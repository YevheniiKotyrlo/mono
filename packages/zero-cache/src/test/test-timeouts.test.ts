import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseSync} from 'oxc-parser';
import {expect, test} from 'vitest';
import {MAX_PG_TEST_TIMEOUT_MS} from '../../../shared/src/tool/vitest-config.ts';

/**
 * A Postgres-backed test may raise its own time budget, never lower it.
 *
 * The project grants one that already accounts for where it runs — doubled in CI,
 * because CI is slower. A file that hardcodes its own number opts out of that: a
 * literal equal to the local grant silently halves the CI one, and a smaller
 * literal halves both. Neither is visible at the call site, and what it produces
 * is a suite that passes alone and times out under the parallelism the pg projects
 * actually run at. The case that finally exposed the pattern ran in under a second
 * on its own while failing at ten.
 *
 * Hooks count too: `pgProjectDefaults()` sets `hookTimeout` from the same number,
 * and a `beforeEach` that provisions a database is what starves first.
 *
 * Raising is fine and stays possible — a suite that genuinely needs longer than
 * its siblings can say so, and saying so is the point. This only refuses the
 * direction that can turn a healthy test red.
 *
 * A tight budget used as a DETECTOR belongs on the case that detects with it, not
 * on the file: see the crafted COPY case in initial-sync.pg.test.ts, whose
 * documented failure mode is an unresponsive Postgres and which therefore reports
 * as a timeout by design.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Every `*.pg.test.ts` in the repo. */
function pgTestFiles(): string[] {
  const found: string[] = [];
  const search = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        search(path);
      } else if (entry.name.endsWith('.pg.test.ts')) {
        found.push(path);
      }
    }
  };
  for (const top of ['packages', 'apps']) {
    search(join(REPO_ROOT, top));
  }
  return found;
}

/**
 * Everything vitest lets you attach a time budget to.
 *
 * Hooks belong here as much as cases do, for the reason in the header: one number
 * feeds `testTimeout` and `hookTimeout` both.
 */
const TIMEOUT_BEARING = new Set([
  'describe',
  'suite', // a real vitest export, and this repo writes suites with it
  'test',
  'it',
  'bench',
  'beforeEach',
  'beforeAll',
  'afterEach',
  'afterAll',
  'aroundEach',
  'aroundAll',
]);

/**
 * The smallest budget worth reporting.
 *
 * `{timeout: 0}` is vitest's "no timeout at all" — verified against the runner: a
 * case declaring it runs past any deadline and passes. So zero is the strongest
 * possible RAISE, and comparing it numerically reports it as the strongest possible
 * lowering. Negatives behave the same way (`timeout <= 0` disables it).
 */
const DISABLES_TIMEOUT = 0;

/**
 * Parsed rather than pattern-matched, because every interesting form here defeats
 * a pattern.
 *
 * Neither the options form nor the trailing one is reliably on one line, and one of
 * them cannot be: `oxfmt` wraps a call past 80 columns and CI runs `oxfmt --check`,
 * so for a long name the wrapped form is the only committable one. The trailing
 * form's number sits after a body that routinely spans hundreds of lines. And the
 * value is an expression, not a token — `{timeout: 90 * 1000}` is a 90-second RAISE
 * that a pattern reading the first digits sees as 90ms and fails.
 *
 * Balancing brackets by hand instead runs into the same wall one level down: a
 * regex literal containing a quote or an unbalanced paren desynchronises the count,
 * `describe.skipIf(!isCI())(…)` nests parens inside the modifier call, and
 * `beforeEach<PgTest<Foo>>(…)` nests angle brackets. The compiler already knows all
 * of this, and it ships with the repo.
 */
type TimeoutDeclaration = {
  line: number;
  construct: string;
  /** `options` is `{timeout: …}`; `trailing` is the final numeric argument. */
  form: 'options' | 'trailing';
  /** `null` when the value is not statically a number — see `text`. */
  ms: number | null;
  /** The value as written, for reporting one this cannot evaluate. */
  text: string;
};

/**
 * The syntax this gate reads.
 *
 * oxc reports an ESTree tree, and only the handful of node shapes a time budget
 * is ever written as are named here. Structural rather than nominal: a walk over
 * an unknown tree cannot be exhaustive, so the reader narrows what it recognises
 * and reports everything else rather than guessing.
 */
type Node = {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
};

function isNode(value: unknown): value is Node {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {type?: unknown}).type === 'string'
  );
}

function child(node: Node, key: string): Node | undefined {
  const value = node[key];
  return isNode(value) ? value : undefined;
}

function children(node: Node, key: string): readonly Node[] {
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

/** Depth-first over every node in the tree. */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (isNode(value)) {
      walk(value, visit);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (isNode(entry)) {
          walk(entry, visit);
        }
      }
    }
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionExpression',
  'ArrowFunctionExpression',
  'FunctionDeclaration',
]);

const NUMERIC_LITERAL = /^[-+]?[\dA-Fa-fXxOoBb_.]+$/u;

/**
 * A number if the expression is statically one, else `undefined`.
 *
 * Covers what a budget is ever written as: a literal in any base, a negation,
 * arithmetic over those (`90 * 1000`, `2 * 60 * 1000`), and a file-local `const`
 * holding any of them. A value from further away — a call, an import, a member
 * access — is NOT resolved: it is reported rather than guessed, because guessing
 * is how a matcher ends up deciding what counts as a violation.
 */
function staticNumber(
  node: Node,
  constants: ReadonlyMap<string, number> = new Map(),
): number | undefined {
  if (node.type === 'Literal') {
    // `raw` rather than `value`, so a separator-bearing literal reads as written.
    const raw = node['raw'];
    if (typeof raw === 'string' && NUMERIC_LITERAL.test(raw)) {
      const parsed = Number(raw.replaceAll('_', ''));
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    const value = node['value'];
    return typeof value === 'number' ? value : undefined;
  }
  // A budget named by a file-local constant is still a budget this can read, and
  // reading it beats exempting it: `const TIMEOUT_MS = 120_000` is a RAISE, and a
  // gate told to trust the name would go on trusting it if the value became
  // 5_000. Fifteen sites in this repo are written that way.
  if (node.type === 'Identifier') {
    const name = node['name'];
    return typeof name === 'string' ? constants.get(name) : undefined;
  }
  // Present only where parentheses are preserved; harmless either way, since oxc
  // otherwise folds them and the arithmetic arrives directly.
  if (node.type === 'ParenthesizedExpression') {
    const inner = child(node, 'expression');
    return inner && staticNumber(inner, constants);
  }
  if (node.type === 'UnaryExpression' && node['operator'] === '-') {
    const argument = child(node, 'argument');
    const operand = argument && staticNumber(argument, constants);
    return operand === undefined ? undefined : -operand;
  }
  if (node.type === 'BinaryExpression') {
    const leftNode = child(node, 'left');
    const rightNode = child(node, 'right');
    const left = leftNode && staticNumber(leftNode, constants);
    const right = rightNode && staticNumber(rightNode, constants);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    switch (node['operator']) {
      case '*':
        return left * right;
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '/':
        return right === 0 ? undefined : left / right;
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * The identifier a call chain is rooted at, if the whole chain is identifiers.
 *
 * `test` -> `test`; `describe.skipIf(x)` -> `describe`; `foo.test` -> `foo`, which
 * is how a method that merely shares vitest's name stays out of the scan.
 */
function rootIdentifier(node: Node): string | undefined {
  if (node.type === 'Identifier') {
    const name = node['name'];
    return typeof name === 'string' ? name : undefined;
  }
  const inner =
    node.type === 'MemberExpression'
      ? child(node, 'object')
      : node.type === 'CallExpression'
        ? // the curried `describe.skipIf(x)(…)`
          child(node, 'callee')
        : node.type === 'TaggedTemplateExpression'
          ? // the `describe.each` table form
            child(node, 'tag')
          : undefined;
  return inner && rootIdentifier(inner);
}

/**
 * Every `const` name bound to a static number, minus any bound more than once.
 *
 * Collected over the whole tree rather than file scope, and a re-declared name is
 * dropped rather than resolved to whichever binding was seen. Resolving it would
 * be worse than not resolving it at all: an inner `const T = 30_000` shadowing an
 * outer `const T = 120_000` would be reported as 120000, which CLEARS the grant —
 * a wrong number, not a missing one, so the "unreadable is reported" backstop
 * never fires. Dropped names come back as `null` and are reported.
 */
function fileConstants(program: Node): ReadonlyMap<string, number> {
  const seen = new Map<string, number>();
  const ambiguous = new Set<string>();

  walk(program, node => {
    if (node.type !== 'VariableDeclaration' || node['kind'] !== 'const') {
      return;
    }
    for (const declaration of children(node, 'declarations')) {
      const id = child(declaration, 'id');
      const name = id?.type === 'Identifier' ? id['name'] : undefined;
      if (typeof name !== 'string') {
        continue;
      }
      if (seen.has(name) || ambiguous.has(name)) {
        ambiguous.add(name);
        seen.delete(name);
        continue;
      }
      const init = child(declaration, 'init');
      const value = init && staticNumber(init);
      if (value !== undefined) {
        seen.set(name, value);
      } else {
        // A name bound to something unreadable must not fall through to an outer
        // binding of the same name either.
        ambiguous.add(name);
      }
    }
  });
  return seen;
}

/**
 * One parse, and the three things every reader of it needs.
 *
 * Both scans below want the tree, a line number for a node, and the text a node
 * was written as. Deriving them once keeps the two from disagreeing about any of
 * it, and puts the parse failure in a single place.
 */
type ParsedSource = {
  readonly root: Node;
  readonly constants: ReadonlyMap<string, number>;
  readonly lineOf: (position: number) => number;
  readonly textOf: (node: Node) => string;
};

function parseSource(fileName: string, source: string): ParsedSource {
  const {program, errors} = parseSync(fileName, source);
  if (errors.length > 0) {
    throw new Error(
      `${fileName}: ${errors.map(error => error.message).join('; ')}`,
    );
  }
  const root = program as unknown as Node;

  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') {
      lineStarts.push(i + 1);
    }
  }
  return {
    root,
    constants: fileConstants(root),
    lineOf: position => {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= position) {
        line++;
      }
      return line + 1;
    },
    textOf: node => source.slice(node.start, node.end),
  };
}

/** Every time budget declared in `source`, in either form vitest accepts. */
function timeoutDeclarations(
  source: string,
  fileName = 'input.ts',
): TimeoutDeclaration[] {
  const {root, constants, lineOf, textOf} = parseSource(fileName, source);
  const found: TimeoutDeclaration[] = [];

  walk(root, node => {
    if (node.type !== 'CallExpression') {
      return;
    }
    const callee = child(node, 'callee');
    const construct = callee && rootIdentifier(callee);
    if (construct === undefined || !TIMEOUT_BEARING.has(construct)) {
      return;
    }
    const args = children(node, 'arguments');
    for (const argument of args) {
      // Only this object's OWN properties: a `{poll: {timeout: 50}}` nested
      // inside is some other API's budget, not this call's.
      if (argument.type !== 'ObjectExpression') {
        continue;
      }
      for (const property of children(argument, 'properties')) {
        if (property.type === 'SpreadElement') {
          // Options merged in from elsewhere may carry a budget this cannot see.
          // Reported rather than passed: a shared options object is the natural
          // shape the moment two suites want the same settings.
          found.push({
            line: lineOf(property.start),
            construct,
            form: 'options',
            ms: null,
            text: textOf(property),
          });
          continue;
        }
        if (property.type !== 'Property') {
          continue;
        }
        // `{timeout: T}`, and `{timeout}` — the same declaration written shorter,
        // where the value is the name itself. oxc gives a shorthand property the
        // same key and value node, so both forms read identically here.
        const key = child(property, 'key');
        const named =
          key !== undefined &&
          ((key.type === 'Identifier' && key['name'] === 'timeout') ||
            (key.type === 'Literal' && key['value'] === 'timeout'));
        const value = child(property, 'value');
        if (named && value !== undefined) {
          found.push({
            line: lineOf(property.start),
            construct,
            form: 'options',
            ms: staticNumber(value, constants) ?? null,
            text: textOf(value),
          });
        }
      }
    }
    // The trailing budget, recognised by POSITION rather than by whether its
    // value can be read. Keying on readability would make the check its own
    // exemption: `beforeEach(fn, HOOK_TIMEOUT_MS)` halves the CI grant and would
    // produce no output at all, and five of the literals this gate first found
    // were in exactly that position.
    //
    // Position is unambiguous when the argument before it is the BODY:
    // `test(name, fn, T)` and `beforeEach(fn, T)` qualify. Requiring a function
    // there rather than "anything but a number" is what separates those from
    // `describe(name, {timeout: T}, body)`, where the last argument is a body
    // referred to by name and no trailing budget exists.
    //
    // A body passed by name with a trailing budget — `test(name, fn, T)` where
    // `fn` is an identifier — is outside this, and stated rather than silent: the
    // two shapes are indistinguishable without resolving the name, and no test in
    // this repo is written that way.
    const last = args.at(-1);
    const previous = args.at(-2);
    if (
      last !== undefined &&
      previous !== undefined &&
      last.type !== 'ObjectExpression' &&
      !FUNCTION_TYPES.has(last.type) &&
      FUNCTION_TYPES.has(previous.type)
    ) {
      found.push({
        line: lineOf(last.start),
        construct,
        form: 'trailing',
        ms: staticNumber(last, constants) ?? null,
        text: textOf(last),
      });
    }
  });
  return found;
}

const files = pgTestFiles();

/**
 * Compared against the maximum the project ever grants, not against this run's.
 *
 * The grant doubles in CI because CI is slower, so a literal equal to the local
 * value is below the CI value — and a check that reads the environment it runs in
 * passes locally on exactly the literals that undercut CI. The first pass of this
 * gate did that, and let a `{timeout: 30000}` through.
 */
const granted = MAX_PG_TEST_TIMEOUT_MS;

/** Repo-relative and slash-normalised, so a report reads the same on any host. */
const rel = (file: string) => relative(REPO_ROOT, file).replaceAll('\\', '/');

test('the pg test files are found at all', () => {
  // Otherwise the case below passes over an empty list and proves nothing.
  expect(files.length).toBeGreaterThan(20);
});

test('the scan parses every real file', () => {
  // Real files contain syntax no fixture thought of. This is not a count: the
  // number of legitimate raises in the repo is not an invariant, and a guard that
  // failed when someone removed the last one would be wired to live content.
  for (const file of files) {
    expect(() =>
      timeoutDeclarations(readFileSync(file, 'utf8'), file),
    ).not.toThrow();
  }
});

test('no pg test lowers the budget its project grants', () => {
  const lowered: string[] = [];
  for (const file of files) {
    for (const {line, construct, ms, form} of timeoutDeclarations(
      readFileSync(file, 'utf8'),
      file,
    )) {
      // `ms === DISABLES_TIMEOUT` is the strongest raise, not the smallest budget.
      if (ms !== null && ms > DISABLES_TIMEOUT && ms < granted) {
        lowered.push(
          `${relative(REPO_ROOT, file).replaceAll('\\', '/')}:${line}: ` +
            `${construct} (${form}) ${ms}ms < ${granted}ms`,
        );
      }
    }
  }
  expect(lowered).toEqual([]);
});

test('a budget this cannot evaluate is reported, not skipped', () => {
  // The matcher must not also be the thing that decides what counts. A budget
  // written as an identifier or a call is invisible to any static read, so it is
  // surfaced for a human rather than passed silently — otherwise illegibility
  // becomes an exemption nobody granted.
  //
  // Keyed by FILE as well as by the expression. A bare name exempts itself
  // everywhere at any value, so a later `const TIMEOUT_MS = 5_000` in some other
  // file would inherit the exemption — the same illegibility-as-exemption this
  // refuses, one level up. Each entry is a RAISE or a documented detector.
  const SANCTIONED = new Set([
    // The crafted COPY detector: a per-case value, so no constant to resolve.
    // Documented at its call site and in this file's header.
    'packages/zero-cache/src/services/change-source/pg/initial-sync.pg.test.ts :: c.timeoutMs',
    'packages/zero-cache/src/services/change-source/pg/initial-sync.pg.test.ts :: timeoutMs',
  ]);

  const unreadable: string[] = [];
  for (const file of files) {
    for (const {line, ms, text} of timeoutDeclarations(
      readFileSync(file, 'utf8'),
      file,
    )) {
      const key = `${rel(file)} :: ${text}`;
      if (ms === null && !SANCTIONED.has(key)) {
        unreadable.push(`${key} (line ${line})`);
      }
    }
  }
  expect(unreadable).toEqual([]);
});

/** Every `vitest.config*.ts` under a package, where projects are assembled. */
function packageConfigs(): string[] {
  const found: string[] = [];
  const search = (dir: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        search(path, depth + 1);
      } else if (/^vitest\.config.*\.ts$/u.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const top of ['packages', 'apps']) {
    search(join(REPO_ROOT, top), 0);
  }
  return found;
}

/**
 * Whether this config can reach a pg project at all.
 *
 * A package with no pg projects is free to set whatever budget it likes — that is
 * what a per-project grant is for. `packages/zql` merges the shared config down to
 * 20s and owns no `*.pg.test.ts` and no pg project, so flagging it would report a
 * lowering that reaches nothing.
 */
function assemblesPgProjects(source: string): boolean {
  return /\b(configForVersion|configForCustomPg|pgProjectDefaults)\b/u.test(
    source,
  );
}

/**
 * Budgets cut where a project is assembled rather than in a test file.
 *
 * `mergeConfig(configForVersion(16, url), {test: {testTimeout: 20_000}})` overrides
 * the shared grant and no test file says anything about it. One package did exactly
 * that across every project it owned, raising its no-pg budget (10s -> 20s,
 * deliberate) and quietly lowering all four pg ones (60s -> 20s in CI, not
 * deliberate at all).
 *
 * A raise scoped to the no-pg project is the legitimate shape, so the merge target
 * decides: overriding `configForNoPg` is fine, overriding anything else is not.
 * Both budget keys are read, because `hookTimeout` starves the same suites.
 */
function loweredMergeTargets(
  source: string,
  limit: number,
  fileName = 'vitest.config.ts',
): {line: number; target: string; key: string; ms: number | null}[] {
  const {root, constants, lineOf, textOf} = parseSource(fileName, source);
  const found: {
    line: number;
    target: string;
    key: string;
    ms: number | null;
  }[] = [];

  walk(root, node => {
    if (node.type !== 'CallExpression') {
      return;
    }
    const callee = child(node, 'callee');
    if (callee === undefined || rootIdentifier(callee) !== 'mergeConfig') {
      return;
    }
    const args = children(node, 'arguments');
    if (args.length < 2) {
      return;
    }
    const target = textOf(args[0]);
    // A no-pg-scoped raise is sanctioned. Anything else — a named pg config, or a
    // variable standing for whichever config is being mapped over — reaches the
    // pg projects.
    if (target.startsWith('configForNoPg')) {
      return;
    }
    for (const argument of args.slice(1)) {
      walk(argument, inner => {
        if (inner.type !== 'Property') {
          return;
        }
        const key = child(inner, 'key');
        const name = key?.type === 'Identifier' ? key['name'] : undefined;
        if (name !== 'testTimeout' && name !== 'hookTimeout') {
          return;
        }
        // Resolved against the file's own constants, and REPORTED when it cannot
        // be: dropping an unreadable value here would leave illegibility as an
        // exemption in the one place a budget is most likely to be named rather
        // than written.
        const value = child(inner, 'value');
        const ms = value && staticNumber(value, constants);
        if (ms === undefined || (ms > DISABLES_TIMEOUT && ms < limit)) {
          found.push({
            line: lineOf(inner.start),
            target,
            key: name,
            ms: ms ?? null,
          });
        }
      });
    }
  });
  return found;
}

test('no config lowers a pg project’s budget on its way past', () => {
  const lowered: string[] = [];
  const scanned: string[] = [];
  for (const config of packageConfigs()) {
    const source = readFileSync(config, 'utf8');
    if (!assemblesPgProjects(source)) {
      continue;
    }
    scanned.push(config);
    for (const {line, target, key, ms} of loweredMergeTargets(
      source,
      granted,
      config,
    )) {
      lowered.push(
        `${relative(REPO_ROOT, config).replaceAll('\\', '/')}:${line}: ` +
          (ms === null
            ? `${target} merges ${key} from a value this cannot read`
            : `${target} merged ${key} down to ${ms}ms < ${granted}ms`),
      );
    }
  }
  // In the same case as the assertion, so a scoping predicate that stopped
  // matching cannot quietly empty the scan.
  expect(scanned.length).toBeGreaterThan(8);
  expect(lowered).toEqual([]);
});

test('the granted budget is a real one', () => {
  // A tripwire on the comparison itself: were the grant zero or missing, every
  // literal would clear it and the cases above would pass vacuously.
  expect(granted).toBeGreaterThanOrEqual(10_000);
});

test('the scan reads every form a budget is written in', () => {
  // Fixtures rather than live files. A tripwire wired to a real call site fails
  // when someone legitimately changes that call site, in a package they never
  // opened, and it only ever exercises whichever branch that site occupies.
  const read = (source: string) =>
    timeoutDeclarations(source).map(({construct, ms, form}) => ({
      construct,
      ms,
      form,
    }));

  expect(read("describe('x', {timeout: 15000}, () => {});")).toEqual([
    {construct: 'describe', ms: 15000, form: 'options'},
  ]);
  expect(read("describe('x', {timeout: 20_000}, () => {});")).toEqual([
    {construct: 'describe', ms: 20000, form: 'options'},
  ]);
  expect(read("describe('x', () => {});")).toEqual([]);

  // Wrapped past 80 columns, which is what `oxfmt` produces and CI enforces.
  expect(
    read(`describe(
  'a suite name long enough that the formatter breaks the call',
  {timeout: 30_000},
  async () => {},
);`),
  ).toEqual([{construct: 'describe', ms: 30000, form: 'options'}]);

  // An exploded options object survives the formatter at any name length.
  expect(read("describe('tiny', {\n  timeout: 30_000,\n}, () => {});")).toEqual(
    [{construct: 'describe', ms: 30000, form: 'options'}],
  );

  // Trailing numeric argument, after a body. No bounded pattern reaches this.
  expect(
    read(`test('x', async () => {
  await something();
  expect(1).toBe(1);
}, 10000);`),
  ).toEqual([{construct: 'test', ms: 10000, form: 'trailing'}]);

  // Hooks, including the generic forms the repo uses.
  expect(read('beforeEach<PgTest>(async () => {}, 30000);')).toEqual([
    {construct: 'beforeEach', ms: 30000, form: 'trailing'},
  ]);
  expect(read('beforeEach<PgTest<Foo>>(async () => {}, 30_000);')).toEqual([
    {construct: 'beforeEach', ms: 30000, form: 'trailing'},
  ]);
  expect(read('afterAll(async () => {}, 45_000);')).toEqual([
    {construct: 'afterAll', ms: 45000, form: 'trailing'},
  ]);

  // Modifier chains, including one whose own argument contains parentheses.
  expect(
    read("describe.skipIf(!RUN)('x', {timeout: 30000}, () => {});"),
  ).toEqual([{construct: 'describe', ms: 30000, form: 'options'}]);
  expect(
    read("describe.skipIf(!isCI())('x', {timeout: 30_000}, () => {});"),
  ).toEqual([{construct: 'describe', ms: 30000, form: 'options'}]);
  expect(
    read("describe.each(cases.map(c => c.name))('x', {timeout: 30_000}, f);"),
  ).toEqual([{construct: 'describe', ms: 30000, form: 'options'}]);
  expect(read("test.each([1, 2])('x', () => {}, 12000);")).toEqual([
    {construct: 'test', ms: 12000, form: 'trailing'},
  ]);

  // Arithmetic is evaluated, so a raise written as a product is read as a raise.
  // A pattern reading the leading digits of `90 * 1000` sees 90 and fails a
  // 90-second budget as if it were 90 milliseconds.
  expect(read("test('x', {timeout: 90 * 1000}, () => {});")).toEqual([
    {construct: 'test', ms: 90000, form: 'options'},
  ]);
  expect(read("test('x', {timeout: 2 * 60 * 1000}, () => {});")).toEqual([
    {construct: 'test', ms: 120000, form: 'options'},
  ]);
  expect(read("test('x', {timeout: 90e3}, () => {});")).toEqual([
    {construct: 'test', ms: 90000, form: 'options'},
  ]);
  expect(read("test('x', {timeout: 0x7530}, () => {});")).toEqual([
    {construct: 'test', ms: 30000, form: 'options'},
  ]);

  // Not this call's budget: a nested object belongs to some other API, a
  // retry count is not a time, and a method that shares vitest's name is not it.
  expect(read("test('x', {retry: 2, poll: {timeout: 50}}, () => {});")).toEqual(
    [],
  );
  expect(read("describe('x', {concurrent: true}, () => {});")).toEqual([]);
  expect(read("test('x', () => { setTimeout(fn, 5000); });")).toEqual([]);
  expect(read('foo.test(bar, 100);')).toEqual([]);
  expect(read('suite.bench(name, 250);')).toEqual([]);
});

test('a shadowed name is reported rather than resolved to the wrong one', () => {
  // The dangerous shape, because it produces a WRONG NUMBER rather than none: an
  // inner binding is the real budget, and resolving the outer one reports 120000 —
  // which clears the grant, so the unreadable-value backstop never fires either.
  expect(
    timeoutDeclarations(`const T = 120_000;
describe('outer', () => {
  const T = 30_000;
  test('x', {timeout: T}, () => {});
});`).map(({ms, text}) => ({ms, text})),
  ).toEqual([{ms: null, text: 'T'}]);

  // A single binding still resolves, which is the whole point of resolving at all.
  expect(
    timeoutDeclarations(`const T = 120_000;
test('x', {timeout: T}, () => {});`).map(({ms}) => ms),
  ).toEqual([120000]);
});

test('every construct vitest gives a budget to is in scope', () => {
  const read = (source: string) => timeoutDeclarations(source).map(d => d.ms);

  // `suite` is a real vitest export and this repo writes suites with it.
  expect(read("suite('x', {timeout: 30_000}, () => {});")).toEqual([30000]);
  expect(read("suite('x', () => {}, 30_000);")).toEqual([30000]);
  expect(read('aroundEach(async () => {}, 30_000);')).toEqual([30000]);
  // The tagged-template table form of `each`. Assembled rather than written
  // inline, so the backtick and `${}` inside the FIXTURE are not read as this
  // file's own template syntax.
  const backtick = String.fromCharCode(96);
  expect(
    read(
      `describe.each${backtick}` +
        `\n  a\n  ${1}\n` +
        `${backtick}('x', {timeout: 30_000}, f);`,
    ),
  ).toEqual([30000]);
});

test('a budget written shorter, or merged in, is still seen', () => {
  const read = (source: string) =>
    timeoutDeclarations(source).map(({ms, text}) => ({ms, text}));

  // `{timeout}` is `{timeout: timeout}`.
  expect(
    read(`const timeout = 30_000;
test('x', {timeout}, () => {});`),
  ).toEqual([{ms: 30000, text: 'timeout'}]);
  // Options merged from elsewhere may carry a budget this cannot see, so it is
  // reported. A shared options object is the natural shape once two suites want
  // the same settings.
  expect(read("test('x', {...OPTS}, () => {});")).toEqual([
    {ms: null, text: '...OPTS'},
  ]);
});

test('a disabled timeout is a raise, not the smallest budget', () => {
  // Verified against the runner: `{timeout: 0}` disables the deadline entirely, so
  // a numeric comparison reports the strongest possible raise as the strongest
  // possible lowering.
  expect(timeoutDeclarations("test('x', {timeout: 0}, () => {});")).toEqual([
    {line: 1, construct: 'test', form: 'options', ms: 0, text: '0'},
  ]);
  // And the gate's own corpus scan must not flag it — asserted through the same
  // predicate the scan uses.
  expect(0 > DISABLES_TIMEOUT).toBe(false);
});

test('a value the scan cannot evaluate is surfaced as such', () => {
  expect(
    timeoutDeclarations("test('x', {timeout: TIMEOUT_MS}, () => {});"),
  ).toEqual([
    {
      line: 1,
      construct: 'test',
      form: 'options',
      ms: null,
      text: 'TIMEOUT_MS',
    },
  ]);

  // The trailing form too, and this is the half that matters most: five of the
  // budgets this gate first found sat in exactly this position, and a version
  // that keyed "is this a timeout" on "can I read it" emitted nothing here at
  // all. A budget hidden behind a name would then be the one shape that reads
  // as compliant.
  expect(
    timeoutDeclarations('beforeEach(async () => {}, HOOK_TIMEOUT_MS);'),
  ).toEqual([
    {
      line: 1,
      construct: 'beforeEach',
      form: 'trailing',
      ms: null,
      text: 'HOOK_TIMEOUT_MS',
    },
  ]);
  expect(
    timeoutDeclarations("test('x', async () => {}, slow ? 30_000 : 10_000);"),
  ).toEqual([
    {
      line: 1,
      construct: 'test',
      form: 'trailing',
      ms: null,
      text: 'slow ? 30_000 : 10_000',
    },
  ]);

  // And a body referred to by name after an options object is NOT a trailing
  // budget — the shape that separates the two.
  expect(
    timeoutDeclarations("describe('x', {timeout: 90_000}, body);").map(
      ({form}) => form,
    ),
  ).toEqual(['options']);
});

test('prose and regex literals cannot move the scan', () => {
  // What a parser buys over balancing brackets by hand. Each of these shifts a
  // hand-rolled depth count, and the budget after it is then misread or missed.
  expect(
    timeoutDeclarations(
      `// don't trust a suite's own budget: {timeout: 1}\n` +
        `describe('it (mostly) works', {timeout: 30_000}, () => {});`,
    ).map(({line, ms}) => ({line, ms})),
  ).toEqual([{line: 2, ms: 30000}]);
  expect(
    timeoutDeclarations("describe('a ) unbalanced name', () => {}, 9000);").map(
      ({ms, form}) => ({ms, form}),
    ),
  ).toEqual([{ms: 9000, form: 'trailing'}]);
  expect(
    timeoutDeclarations('/* {timeout: 2} */ describe(name, () => {});'),
  ).toEqual([]);
  // A regex literal holding a quote, or an unbalanced bracket, or a comment
  // opener. All three desynchronise a lexer that does not know what a regex is.
  expect(
    timeoutDeclarations("const r = /'/u;\ndescribe('x', {timeout: 1}, f);").map(
      ({ms}) => ms,
    ),
  ).toEqual([1]);
  expect(
    timeoutDeclarations(
      "test('a', () => { s.replace(/[)]/gu, ''); }, 30_000);",
    ).map(({ms}) => ms),
  ).toEqual([30000]);
  expect(
    timeoutDeclarations(
      "test('a', () => { s.replace(/\\/\\//gu, '/'); }, 30_000);",
    ).map(({ms}) => ms),
  ).toEqual([30000]);
});

test('the line reported is the line the budget is on', () => {
  // Off by one here means the report points at the argument before it, which for
  // the wrapped form is the suite name.
  const wrapped = `describe(
  'a name long enough that the formatter breaks this call apart',
  {timeout: 30_000},
  () => {},
);`;
  expect(timeoutDeclarations(wrapped)[0].line).toBe(3);
});

test('the merge-target scan sees an indirect target', () => {
  const read = (source: string) =>
    loweredMergeTargets(source, 60_000).map(({target, key, ms}) => ({
      target,
      key,
      ms,
    }));

  // The sanctioned shape.
  expect(
    read('mergeConfig(configForNoPg(url), {test: {testTimeout: 20_000}})'),
  ).toEqual([]);
  // A named pg config.
  expect(
    read(
      'mergeConfig(configForVersion(16, url), {test: {testTimeout: 20_000}})',
    ),
  ).toEqual([
    {target: 'configForVersion(16, url)', key: 'testTimeout', ms: 20000},
  ]);
  // The shape that caused this: the target is whatever is being mapped over, so
  // no list of config names recognises it.
  expect(
    read('projects.map(c => mergeConfig(c, {test: {testTimeout: 20_000}}))'),
  ).toEqual([{target: 'c', key: 'testTimeout', ms: 20000}]);
  // Hooks are cut by the same mechanism and starve the same suites.
  expect(
    read(
      'mergeConfig(configForVersion(16, url), {test: {hookTimeout: 20_000}})',
    ),
  ).toEqual([
    {target: 'configForVersion(16, url)', key: 'hookTimeout', ms: 20000},
  ]);
  // A raise is never a violation, whatever the target.
  expect(
    read(
      'mergeConfig(configForVersion(16, url), {test: {testTimeout: 90_000}})',
    ),
  ).toEqual([]);

  // A named constant resolves, exactly as on the test-file side.
  expect(
    read(`const SHORT = 20_000;
mergeConfig(configForVersion(16, url), {test: {testTimeout: SHORT}})`),
  ).toEqual([
    {target: 'configForVersion(16, url)', key: 'testTimeout', ms: 20000},
  ]);
  expect(
    read(`const LONG = 90_000;
mergeConfig(configForVersion(16, url), {test: {testTimeout: LONG}})`),
  ).toEqual([]);

  // And a value it cannot read is REPORTED rather than dropped. A config is the
  // more likely place for a budget to be computed instead of written, so leaving
  // this side silent would put the exemption where it is easiest to reach.
  expect(
    read(
      'mergeConfig(configForVersion(16, url), {test: {testTimeout: seconds(20)}})',
    ),
  ).toEqual([
    {target: 'configForVersion(16, url)', key: 'testTimeout', ms: null},
  ]);
});
