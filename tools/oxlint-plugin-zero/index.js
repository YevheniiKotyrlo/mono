const selectStar = /\bselect\b[\s\S]*?\*(?=\s*(?:,|\bfrom\b))[\s\S]*?\bfrom\b/i;

// Commands that are a `.CMD` shim on Windows, which `CreateProcess` does not
// resolve: it appends only `.exe`. Limited to what this repository runs.
const shimCommands = new Set([
  'npm',
  'npx',
  'pnpm',
  'tsc',
  'tsx',
  'vite',
  'vitest',
  'oxlint',
  'oxfmt',
  'turbo',
  'prisma',
  'drizzle-kit',
  'playwright',
  'sst',
]);

// `exec` and `execSync` always go through a shell, which resolves the shim.
const spawnFunctions = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
]);

const whitespace = /\s+/;
const scriptFile = /\.(?:cmd|bat)$/i;
const childProcessModules = new Set(['node:child_process', 'child_process']);

// chai's property assertions assert when they are read — `expect(x).to.be.true` —
// so a statement ending on one of these is an assertion. Any other name a
// statement ends on is a matcher, or a chain word, that was never called.
const chaiPropertyAssertions = new Set([
  'ok',
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'exist',
  'empty',
  'arguments',
  'Arguments',
  'extensible',
  'sealed',
  'frozen',
  'finite',
]);

const plugin = {
  meta: {
    name: 'zero',
    namespace: 'zero',
  },
  rules: {
    'no-select-star': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow SELECT * in runtime SQL because schema migrations can change result shapes and break cached prepared plans.',
        },
        schema: [
          {
            type: 'object',
            properties: {
              include: {
                type: 'array',
                items: {type: 'string'},
              },
            },
            additionalProperties: false,
          },
        ],
        messages: {
          noSelectStar:
            'Avoid SELECT * in runtime SQL. Schema migrations can change result shapes and break cached prepared plans; list result columns explicitly.',
        },
      },
      create(context) {
        const options = context.options[0] ?? {};
        const filename = context.filename ?? context.getFilename?.() ?? '';
        if (!shouldCheck(filename, options.include ?? [])) {
          return {};
        }

        function check(node, text) {
          const stripped = stripCommentOnlyLines(text);
          if (hasSelectStar(stripped)) {
            context.report({node, messageId: 'noSelectStar'});
          }
        }

        return {
          Literal(node) {
            if (typeof node.value === 'string') {
              check(node, node.value);
            }
          },
          TemplateLiteral(node) {
            check(node, node.quasis.map(element => element.value.raw).join(''));
          },
        };
      },
    },

    'no-bare-shim-spawn': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow spawning a command that is a .CMD shim on Windows by bare name; resolve its JS entrypoint and spawn it with process.execPath.',
        },
        schema: [],
        messages: {
          resolveEntrypoint:
            "Spawning '{{command}}' without a shell fails on Windows: it is a .cmd shim, which CreateProcess does not run. `shell: true` concatenates arguments instead of escaping them (Node DEP0190): spawn its JS entrypoint with process.execPath.",
        },
      },
      create(context) {
        const aliases = new Map();
        return {
          ImportDeclaration(node) {
            if (!childProcessModules.has(node.source.value)) {
              return;
            }
            for (const specifier of node.specifiers) {
              if (specifier.type === 'ImportSpecifier') {
                aliases.set(
                  specifier.local.name,
                  specifier.imported.name ?? specifier.imported.value,
                );
              }
            }
          },
          CallExpression(node) {
            const command = bareShimSpawnCommand(node, aliases);
            if (command !== undefined) {
              context.report({
                node,
                messageId: 'resolveEntrypoint',
                data: {command},
              });
            }
          },
        };
      },
    },

    'no-unasserted-expect': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Disallow an expect() statement that asserts nothing: one with no matcher, or one whose matcher is read but never called.',
        },
        schema: [],
        messages: {
          noMatcher:
            'This expect() has no matcher, so it passes whatever the value is. Call one: expect(value).toBe(expected).',
          uncalledMatcher:
            "'{{name}}' is read but never called, so this expect() passes whatever the value is. Call it: .{{name}}(…).",
        },
      },
      create(context) {
        return {
          ExpressionStatement(node) {
            const finding = unassertedExpect(node);
            if (finding !== undefined) {
              context.report({node, ...finding});
            }
          },
        };
      },
    },
  },
};

function stripCommentOnlyLines(source) {
  return source
    .split('\n')
    .map(line => {
      const trimmed = line.trimStart();
      return trimmed.startsWith('//') || trimmed.startsWith('--') ? '' : line;
    })
    .join('\n');
}

function hasSelectStar(source) {
  return selectStar.test(source);
}

/**
 * Normalize a filesystem path to forward slashes, so the `/`-bearing comparisons
 * in `shouldCheck` mean the same thing wherever the linter runs.
 *
 * Comparing against a raw filename makes every one of them false where paths use
 * backslashes, and a rule that never matches a path never runs — which reads
 * exactly like a codebase with nothing to report.
 */
function toPosixPath(filename) {
  return filename.replaceAll('\\', '/');
}

function shouldCheck(filename, include) {
  const path = toPosixPath(filename);
  return (
    include.some(included => path.includes(toPosixPath(included))) &&
    !path.endsWith('.test.ts') &&
    !path.includes('/test/') &&
    !path.includes('/__snapshots__/') &&
    !path.endsWith('_generated.ts')
  );
}

function isStaticallyFalsy(node) {
  if (node?.type === 'Literal') {
    return !node.value;
  }
  if (node?.type === 'Identifier') {
    return node.name === 'undefined';
  }
  return node?.type === 'UnaryExpression' && node.operator === 'void';
}

/**
 * The shim command `node` spawns without a shell, or undefined. `aliases` maps
 * the local names `child_process` functions were imported under.
 */
function bareShimSpawnCommand(node, aliases = new Map()) {
  const callee = node.callee;
  const calleeName =
    callee?.type === 'Identifier'
      ? (aliases.get(callee.name) ?? callee.name)
      : callee?.type === 'MemberExpression' && !callee.computed
        ? callee.property?.name
        : undefined;
  if (calleeName === undefined || !spawnFunctions.has(calleeName)) {
    return undefined;
  }
  const [commandArgument, ...rest] = node.arguments ?? [];
  const text = staticString(commandArgument);
  if (text === undefined) {
    return undefined;
  }
  const command = text.trim().split(whitespace)[0];
  if (!shimCommands.has(command) && !scriptFile.test(command)) {
    return undefined;
  }
  return rest.some(opensShell) ? undefined : command;
}

function staticString(node) {
  if (node?.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : undefined;
  }
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * Whether an options object opens a shell: its last `shell` key decides, as it
 * does at runtime, and a spread after it might hold one, so it counts as one.
 * A statically falsy value — `false`, `undefined`, `void 0` — opens none.
 */
function opensShell(argument) {
  if (argument?.type !== 'ObjectExpression') {
    return false;
  }
  let opens = false;
  for (const property of argument.properties) {
    if (property.type === 'SpreadElement') {
      opens = true;
    } else if (
      property.type === 'Property' &&
      (property.key?.name === 'shell' || property.key?.value === 'shell')
    ) {
      opens = !isStaticallyFalsy(property.value);
    }
  }
  return opens;
}

function isExpectCall(node) {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'Identifier' &&
    node.callee.name === 'expect'
  );
}

/**
 * Returns the report for a statement that builds an assertion and discards it —
 * `expect(x)` with no matcher, or a chain on it ending on a name that is never
 * called — otherwise undefined.
 *
 * Only an expression statement can discard one: an `expect(x)` that is returned
 * or assigned is someone else's to finish. Reach: plain member chains; a
 * computed member (`expect(x)['toBe']`) is out of it.
 */
function unassertedExpect(statement) {
  const expression =
    statement?.expression?.type === 'AwaitExpression'
      ? statement.expression.argument
      : statement?.expression;
  if (isExpectCall(expression)) {
    return {messageId: 'noMatcher'};
  }
  if (expression?.type !== 'MemberExpression' || expression.computed) {
    return undefined;
  }
  let receiver = expression.object;
  while (receiver?.type === 'MemberExpression' && !receiver.computed) {
    receiver = receiver.object;
  }
  const name = expression.property?.name;
  if (!isExpectCall(receiver) || chaiPropertyAssertions.has(name)) {
    return undefined;
  }
  return {messageId: 'uncalledMatcher', data: {name}};
}

export default plugin;
export {
  bareShimSpawnCommand,
  hasSelectStar,
  shouldCheck,
  stripCommentOnlyLines,
  toPosixPath,
  unassertedExpect,
};
