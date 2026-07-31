// oxlint-disable no-console

import {mkdirSync} from 'node:fs';
import {defaultExec, mustEnv, writeGithubOutput} from './shared.ts';

const packDestination = mustEnv('PACK_DEST');
mkdirSync(packDestination, {recursive: true});

// Goes through defaultExec rather than execFileSync directly: that is the one
// place that knows how to invoke npm portably, and a second exec path here
// would silently miss it.
const output = defaultExec('npm', [
  'pack',
  '--pack-destination',
  packDestination,
  '--json',
]);
const [{filename}] = JSON.parse(output) as [{filename?: unknown}];
if (typeof filename !== 'string' || filename.length === 0) {
  throw new Error(`Could not parse npm pack output: ${output}`);
}

writeGithubOutput({filename});
console.log(`Packed ${filename}`);
