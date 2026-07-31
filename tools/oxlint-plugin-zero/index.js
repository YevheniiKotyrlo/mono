const selectStar = /\bselect\b[\s\S]*?\*(?=\s*(?:,|\bfrom\b))[\s\S]*?\bfrom\b/i;

// Commands that resolve to a `.CMD`/`.bat` shim on Windows rather than a real
// executable image. `CreateProcess` only ever appends `.exe`, so spawning one of
// these by bare name throws ENOENT on Windows even when the shim is on PATH.
// `shell: true` "fixes" it but concatenates arguments instead of escaping them
// (Node DEP0190), so the portable answer is to resolve the JS entrypoint and
// spawn that with `process.execPath`.
const shimCommands = new Set([
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'tsc',
  'tsx',
  'vite',
  'vitest',
  'oxlint',
  'oxfmt',
  'eslint',
  'prettier',
  'turbo',
  'prisma',
  'drizzle-kit',
  'playwright',
  'wrangler',
  'sst',
]);

const spawnFunctions = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
]);

const whitespace = /\s+/;

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

    'no-file-url-pathname': {
      meta: {
        type: 'problem',
        docs: {
          description:
            "Disallow using a file: URL's .pathname as a filesystem path; on Windows it yields a leading slash before the drive letter.",
        },
        schema: [],
        messages: {
          useFileUrlToPath:
            "A file: URL's .pathname is a URL path, not a filesystem path — on Windows it is '/C:/…', which fs cannot open. Use fileURLToPath() from 'node:url'.",
        },
      },
      create(context) {
        return {
          MemberExpression(node) {
            if (isFileUrlPathnameAccess(node)) {
              context.report({node, messageId: 'useFileUrlToPath'});
            }
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
            "Spawning '{{command}}' by bare name throws ENOENT on Windows: it is a .CMD shim and CreateProcess only appends .exe. Do not reach for `shell: true` — it concatenates arguments instead of escaping them (Node DEP0190). Resolve the JS entrypoint (createRequire(...).resolve) and spawn it with process.execPath.",
        },
      },
      create(context) {
        return {
          CallExpression(node) {
            const command = bareShimSpawnCommand(node);
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
 * Normalize a filesystem path to forward slashes so path matching behaves
 * identically on Windows and POSIX. Without this every `/`-bearing comparison
 * in `shouldCheck` is silently false on a Windows checkout, which disabled
 * `no-select-star` outright there instead of failing loudly.
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

/**
 * Matches `.pathname` read off a URL that is known to be a `file:` URL:
 * `new URL('./x', import.meta.url).pathname` or `new URL(import.meta.url).pathname`.
 *
 * The base decides, not the specifier. A relative specifier against an http base
 * — `new URL('./v2/users', apiBaseUrl).pathname` — is ordinary URL work and must
 * not be flagged, so a two-argument form is only a finding when the base is
 * `import.meta.url`.
 */
function isFileUrlPathnameAccess(node) {
  if (node.computed || node.property?.name !== 'pathname') {
    return false;
  }
  const target = node.object;
  if (target?.type !== 'NewExpression' || target.callee?.name !== 'URL') {
    return false;
  }
  const [specifier, base] = target.arguments ?? [];
  if (base !== undefined) {
    return isImportMetaUrl(base);
  }
  // Single-argument form. `new URL(import.meta.url)` is the one that keeps
  // appearing; a `file:` literal is the same mistake spelled out.
  return (
    isImportMetaUrl(specifier) ||
    (specifier?.type === 'Literal' &&
      typeof specifier.value === 'string' &&
      specifier.value.startsWith('file:'))
  );
}

function isImportMetaUrl(node) {
  return (
    node?.type === 'MemberExpression' &&
    node.property?.name === 'url' &&
    node.object?.type === 'MetaProperty'
  );
}

/**
 * Returns the offending command name when `node` spawns a Windows shim command
 * by bare name without a shell, otherwise undefined.
 */
function bareShimSpawnCommand(node) {
  // Both `spawn(…)` and `childProcess.spawn(…)`: the member form is just as
  // common and was previously invisible to this rule.
  const callee = node.callee;
  const calleeName =
    callee?.type === 'Identifier'
      ? callee.name
      : callee?.type === 'MemberExpression' && !callee.computed
        ? callee.property?.name
        : undefined;
  if (calleeName === undefined || !spawnFunctions.has(calleeName)) {
    return undefined;
  }
  const [commandArgument, , options] = node.arguments ?? [];
  if (
    commandArgument?.type !== 'Literal' ||
    typeof commandArgument.value !== 'string'
  ) {
    return undefined;
  }
  const command = commandArgument.value.trim().split(whitespace)[0];
  if (!shimCommands.has(command)) {
    return undefined;
  }
  // An explicit `shell` option is a deliberate (if discouraged) choice; this
  // rule only flags the silently-broken bare form.
  if (hasShellProperty(options)) {
    return undefined;
  }
  return command;
}

function hasShellProperty(options) {
  if (options?.type !== 'ObjectExpression') {
    return false;
  }
  return options.properties.some(
    property =>
      property.type === 'Property' &&
      (property.key?.name === 'shell' || property.key?.value === 'shell'),
  );
}

export default plugin;
export {
  bareShimSpawnCommand,
  hasSelectStar,
  isFileUrlPathnameAccess,
  shouldCheck,
  stripCommentOnlyLines,
  toPosixPath,
};
