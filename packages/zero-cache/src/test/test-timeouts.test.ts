import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
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
  'test',
  'it',
  'bench',
  'beforeEach',
  'beforeAll',
  'afterEach',
  'afterAll',
]);

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
 * A number if the expression is statically one, else `undefined`.
 *
 * Covers what a budget is ever written as: a literal in any base, a negation, and
 * arithmetic over those (`90 * 1000`, `2 * 60 * 1000`). An identifier or a call is
 * deliberately NOT resolved — a value this cannot see is reported rather than
 * guessed, because guessing is how a matcher ends up deciding what counts as a
 * violation.
 */
function staticNumber(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) {
    return Number(node.text.replaceAll('_', ''));
  }
  if (ts.isParenthesizedExpression(node)) {
    return staticNumber(node.expression);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken
  ) {
    const operand = staticNumber(node.operand);
    return operand === undefined ? undefined : -operand;
  }
  if (ts.isBinaryExpression(node)) {
    const left = staticNumber(node.left);
    const right = staticNumber(node.right);
    if (left === undefined || right === undefined) {
      return undefined;
    }
    switch (node.operatorToken.kind) {
      case ts.SyntaxKind.AsteriskToken:
        return left * right;
      case ts.SyntaxKind.PlusToken:
        return left + right;
      case ts.SyntaxKind.MinusToken:
        return left - right;
      case ts.SyntaxKind.SlashToken:
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
function rootIdentifier(node: ts.Expression): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  if (ts.isPropertyAccessExpression(node)) {
    return rootIdentifier(node.expression);
  }
  if (ts.isCallExpression(node)) {
    return rootIdentifier(node.expression); // the curried `describe.skipIf(x)(…)`
  }
  return undefined;
}

/** Every time budget declared in `source`, in either form vitest accepts. */
function timeoutDeclarations(
  source: string,
  fileName = 'input.ts',
): TimeoutDeclaration[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const found: TimeoutDeclaration[] = [];

  const lineOf = (position: number) =>
    parsed.getLineAndCharacterOfPosition(position).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const construct = rootIdentifier(node.expression);
      if (construct !== undefined && TIMEOUT_BEARING.has(construct)) {
        for (const argument of node.arguments) {
          // Only this object's OWN properties: a `{poll: {timeout: 50}}` nested
          // inside is some other API's budget, not this call's.
          if (ts.isObjectLiteralExpression(argument)) {
            for (const property of argument.properties) {
              if (
                ts.isPropertyAssignment(property) &&
                (ts.isIdentifier(property.name) ||
                  ts.isStringLiteral(property.name)) &&
                property.name.text === 'timeout'
              ) {
                found.push({
                  line: lineOf(property.getStart(parsed)),
                  construct,
                  form: 'options',
                  ms: staticNumber(property.initializer) ?? null,
                  text: property.initializer.getText(parsed),
                });
              }
            }
          }
        }
        // A bare numeric final argument is only ever the timeout — every other
        // position takes a name, an options object, or a function.
        const last = node.arguments.at(-1);
        if (
          last !== undefined &&
          !ts.isObjectLiteralExpression(last) &&
          !ts.isFunctionLike(last) &&
          staticNumber(last) !== undefined
        ) {
          found.push({
            line: lineOf(last.getStart(parsed)),
            construct,
            form: 'trailing',
            ms: staticNumber(last) ?? null,
            text: last.getText(parsed),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
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
      if (ms !== null && ms < granted) {
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
  // The entries below are the sanctioned ones. Each is a RAISE or a documented
  // detector; a new name appearing here is a decision, not a formality.
  const SANCTIONED = new Set([
    'TIMEOUT_MS', // 120_000 / 600_000 raises, declared in their own files
    'c.timeoutMs', // the crafted COPY detector, documented at its call site
    'timeoutMs', // the same value, as the option is assembled
  ]);

  const unreadable: string[] = [];
  for (const file of files) {
    for (const {line, ms, text} of timeoutDeclarations(
      readFileSync(file, 'utf8'),
      file,
    )) {
      if (ms === null && !SANCTIONED.has(text)) {
        unreadable.push(
          `${relative(REPO_ROOT, file).replaceAll('\\', '/')}:${line}: ${text}`,
        );
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
): {line: number; target: string; key: string; ms: number}[] {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const found: {line: number; target: string; key: string; ms: number}[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      rootIdentifier(node.expression) === 'mergeConfig' &&
      node.arguments.length >= 2
    ) {
      const target = node.arguments[0].getText(parsed);
      // A no-pg-scoped raise is sanctioned. Anything else — a named pg config, or
      // a variable standing for whichever config is being mapped over — reaches
      // the pg projects.
      if (!target.startsWith('configForNoPg')) {
        for (const argument of node.arguments.slice(1)) {
          const walk = (inner: ts.Node): void => {
            if (
              ts.isPropertyAssignment(inner) &&
              ts.isIdentifier(inner.name) &&
              (inner.name.text === 'testTimeout' ||
                inner.name.text === 'hookTimeout')
            ) {
              const ms = staticNumber(inner.initializer);
              if (ms !== undefined && ms < limit) {
                found.push({
                  line:
                    parsed.getLineAndCharacterOfPosition(inner.getStart(parsed))
                      .line + 1,
                  target,
                  key: inner.name.text,
                  ms,
                });
              }
            }
            ts.forEachChild(inner, walk);
          };
          walk(argument);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
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
          `${target} merged ${key} down to ${ms}ms < ${granted}ms`,
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

test('a value the scan cannot evaluate is surfaced as such', () => {
  const declarations = timeoutDeclarations(
    "test('x', {timeout: TIMEOUT_MS}, () => {});",
  );
  expect(declarations).toEqual([
    {
      line: 1,
      construct: 'test',
      form: 'options',
      ms: null,
      text: 'TIMEOUT_MS',
    },
  ]);
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
});
