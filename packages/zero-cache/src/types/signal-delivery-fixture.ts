import {parentWorker} from './processes.ts';

// A forked worker that reports ready, and with `--handle-sigterm` exits 0 when
// SIGTERM reaches its listener; without it, SIGTERM takes its default action.
if (process.argv.includes('--handle-sigterm')) {
  process.on('SIGTERM', () => process.exit(0));
}
parentWorker?.send(['ready', {}]);
setInterval(() => {}, 1000);
