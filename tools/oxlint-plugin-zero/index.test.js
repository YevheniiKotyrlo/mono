import {describe, expect, test} from 'vitest';
import {
  bareShimSpawnCommand,
  isFileUrlPathnameAccess,
  shouldCheck,
  toPosixPath,
} from './index.js';

// These tests are deliberately platform-independent: they feed Windows-shaped
// input explicitly rather than depending on the host separator, so a regression
// is caught on a POSIX CI runner too. That matters because every bug fixed here
// is invisible on POSIX by construction.

describe('toPosixPath', () => {
  test('rewrites Windows separators', () => {
    expect(toPosixPath('C:\\repo\\packages\\zero-cache\\src\\db.ts')).toBe(
      'C:/repo/packages/zero-cache/src/db.ts',
    );
  });

  test('leaves a POSIX path untouched', () => {
    expect(toPosixPath('/repo/packages/zero-cache/src/db.ts')).toBe(
      '/repo/packages/zero-cache/src/db.ts',
    );
  });
});

describe('shouldCheck', () => {
  const include = ['packages/zero-cache/src/'];

  test('matches a Windows path against a POSIX include prefix', () => {
    // Before normalization this returned false, so no-select-star silently did
    // not run on Windows at all.
    expect(
      shouldCheck('C:\\repo\\packages\\zero-cache\\src\\query.ts', include),
    ).toBe(true);
  });

  test('matches a POSIX path against a POSIX include prefix', () => {
    expect(shouldCheck('/repo/packages/zero-cache/src/query.ts', include)).toBe(
      true,
    );
  });

  test('tolerates a Windows-shaped include prefix', () => {
    expect(
      shouldCheck('/repo/packages/zero-cache/src/query.ts', [
        'packages\\zero-cache\\src\\',
      ]),
    ).toBe(true);
  });

  test('skips a file outside the include prefixes', () => {
    expect(shouldCheck('C:\\repo\\packages\\zql\\src\\query.ts', include)).toBe(
      false,
    );
  });

  test('skips test files on both separators', () => {
    expect(
      shouldCheck('C:\\repo\\packages\\zero-cache\\src\\a.test.ts', include),
    ).toBe(false);
    expect(
      shouldCheck('/repo/packages/zero-cache/src/a.test.ts', include),
    ).toBe(false);
  });

  test('skips test directories on both separators', () => {
    // This exclusion was also dead on Windows: '/test/' never matched a
    // backslash path, so test-directory files were linted there but not on CI.
    expect(
      shouldCheck('C:\\repo\\packages\\zero-cache\\src\\test\\a.ts', include),
    ).toBe(false);
    expect(
      shouldCheck('/repo/packages/zero-cache/src/test/a.ts', include),
    ).toBe(false);
  });

  test('skips snapshots and generated files on both separators', () => {
    expect(
      shouldCheck(
        'C:\\repo\\packages\\zero-cache\\src\\__snapshots__\\a.ts',
        include,
      ),
    ).toBe(false);
    expect(
      shouldCheck(
        'C:\\repo\\packages\\zero-cache\\src\\a_generated.ts',
        include,
      ),
    ).toBe(false);
  });

  test('an empty include list never matches', () => {
    expect(shouldCheck('C:\\repo\\packages\\zero-cache\\src\\a.ts', [])).toBe(
      false,
    );
  });
});

// Minimal ESTree-shaped literals; only the fields the predicates read.
const literal = value => ({type: 'Literal', value});
const importMetaUrl = () => ({
  type: 'MemberExpression',
  object: {type: 'MetaProperty'},
  property: {name: 'url'},
});
const urlPathname = args => ({
  type: 'MemberExpression',
  computed: false,
  property: {name: 'pathname'},
  object: {type: 'NewExpression', callee: {name: 'URL'}, arguments: args},
});

describe('isFileUrlPathnameAccess', () => {
  test('flags new URL(relative, import.meta.url).pathname', () => {
    expect(
      isFileUrlPathnameAccess(
        urlPathname([literal('./tools/plugin/index.js'), importMetaUrl()]),
      ),
    ).toBe(true);
  });

  test('flags the single-argument new URL(import.meta.url) form', () => {
    // The form that keeps appearing in real code, and the one this rule missed.
    expect(isFileUrlPathnameAccess(urlPathname([importMetaUrl()]))).toBe(true);
  });

  test('flags a single file: literal', () => {
    expect(
      isFileUrlPathnameAccess(urlPathname([literal('file:///a/b.js')])),
    ).toBe(true);
  });

  test('ignores a relative specifier against a non-file base', () => {
    // `new URL('./v2/users', apiBaseUrl).pathname` is ordinary URL work; the
    // base decides, not the specifier.
    const node = urlPathname([
      literal('./v2/users'),
      {type: 'Identifier', name: 'apiBaseUrl'},
    ]);
    expect(isFileUrlPathnameAccess(node)).toBe(false);
  });

  test('ignores an http URL, where pathname is the right property', () => {
    expect(
      isFileUrlPathnameAccess(urlPathname([literal('https://example.com/a')])),
    ).toBe(false);
  });

  test('ignores a different property', () => {
    const node = urlPathname([literal('./a.js')]);
    node.property = {name: 'href'};
    expect(isFileUrlPathnameAccess(node)).toBe(false);
  });

  test('ignores computed access', () => {
    const node = urlPathname([literal('./a.js')]);
    node.computed = true;
    expect(isFileUrlPathnameAccess(node)).toBe(false);
  });
});

const spawnCall = (name, commandValue, options) => ({
  type: 'CallExpression',
  callee: {type: 'Identifier', name},
  arguments: [
    commandValue === undefined ? undefined : literal(commandValue),
    {type: 'ArrayExpression', elements: []},
    options,
  ],
});
const objectWith = keyName => ({
  type: 'ObjectExpression',
  properties: [{type: 'Property', key: {name: keyName}}],
});

describe('bareShimSpawnCommand', () => {
  test.each(['spawn', 'spawnSync', 'execFile', 'execFileSync'])(
    'flags a bare shim command via %s',
    name => {
      expect(bareShimSpawnCommand(spawnCall(name, 'npm'))).toBe('npm');
    },
  );

  test('flags tsc, the case that breaks the build', () => {
    expect(bareShimSpawnCommand(spawnCall('spawn', 'tsc'))).toBe('tsc');
  });

  test('reads only the leading word of a command string', () => {
    expect(
      bareShimSpawnCommand(spawnCall('spawn', 'tsc -p tsconfig.json')),
    ).toBe('tsc');
  });

  test('ignores a real executable', () => {
    expect(bareShimSpawnCommand(spawnCall('spawn', 'git'))).toBeUndefined();
    expect(bareShimSpawnCommand(spawnCall('spawn', 'docker'))).toBeUndefined();
  });

  test('ignores a call that already passes an explicit shell option', () => {
    expect(
      bareShimSpawnCommand(spawnCall('spawn', 'npm', objectWith('shell'))),
    ).toBeUndefined();
  });

  test('an unrelated option does not exempt the call', () => {
    expect(
      bareShimSpawnCommand(spawnCall('spawn', 'npm', objectWith('stdio'))),
    ).toBe('npm');
  });

  test('ignores a non-literal command, which it cannot resolve statically', () => {
    const node = spawnCall('spawn', undefined);
    node.arguments[0] = {type: 'Identifier', name: 'litestream'};
    expect(bareShimSpawnCommand(node)).toBeUndefined();
  });

  test('ignores unrelated calls', () => {
    expect(bareShimSpawnCommand(spawnCall('execSync', 'npm'))).toBeUndefined();
  });
});

test('bareShimSpawnCommand flags the member form childProcess.spawn(...)', () => {
  const node = spawnCall('spawn', 'npm');
  node.callee = {
    type: 'MemberExpression',
    computed: false,
    object: {type: 'Identifier', name: 'childProcess'},
    property: {type: 'Identifier', name: 'spawn'},
  };
  expect(bareShimSpawnCommand(node)).toBe('npm');
});

test('bareShimSpawnCommand ignores a computed member callee it cannot read', () => {
  const node = spawnCall('spawn', 'npm');
  node.callee = {
    type: 'MemberExpression',
    computed: true,
    object: {type: 'Identifier', name: 'childProcess'},
    property: {type: 'Identifier', name: 'spawn'},
  };
  expect(bareShimSpawnCommand(node)).toBeUndefined();
});
