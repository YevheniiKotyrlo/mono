/**
 * A minimal process that installs a {@link ProcessManager} and waits.
 *
 * Forked by shutdown-smoke.test.ts, which then asks it to shut down. Small on
 * purpose: it proves the request reaches a real forked child over a real IPC
 * channel, without a database or any of the workers a zero-cache would start.
 */
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {parentWorker} from '../types/processes.ts';
import {ProcessManager} from './life-cycle.ts';

new ProcessManager(createSilentLogContext(), parentWorker ?? process);

// Nothing else keeps the event loop alive, and a child that exits on its own
// proves nothing about the shutdown path.
const keepAlive = setInterval(() => {}, 60_000);

parentWorker?.send(['ready', {ready: true}]);

// Answers a liveness probe, so the parent can prove this process is still up
// without waiting on a clock. A negative proved by a timer is only as good as the
// machine's load at the time; a round trip is an observation.
parentWorker?.onMessageType('status', () => {
  parentWorker?.send(['status', {status: 'alive'}]);
});

// So the interval cannot outlive a shutdown that works.
process.on('exit', () => clearInterval(keepAlive));
