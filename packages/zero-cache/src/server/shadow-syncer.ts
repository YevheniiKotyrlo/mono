import {consoleLogSink, LogContext} from '@rocicorp/logger';
import {must} from '../../../shared/src/must.ts';
import {getServerContext} from '../config/server-context.ts';
import {getNormalizedZeroConfig} from '../config/zero-config.ts';
import {initEventSink} from '../observability/events.ts';
import {
  exitAfter,
  runUntilKilled,
  shutdownRequested,
} from '../services/life-cycle.ts';
import {ShadowSyncService} from '../services/shadow-sync/shadow-sync-service.ts';
import {
  parentWorker,
  singleProcessMode,
  type Worker,
} from '../types/processes.ts';
import {getShardConfig} from '../types/shards.ts';
import {createLogContext} from './logging.ts';
import {startOtelAuto} from './otel-start.ts';

const MS_PER_HOUR = 1000 * 60 * 60;

// Default LogContext, overridden in runWorker
let lc = new LogContext('info', {}, consoleLogSink);

export default function runWorker(
  parent: Worker,
  env: NodeJS.ProcessEnv,
  ...argv: string[]
): Promise<void> {
  // Armed before anything that can block. A 'message' event reaches the
  // listeners that exist at that instant and is not replayed for one added
  // later, so a signal armed after an awaited startup discards any request that
  // arrived during it.
  const shutdown = shutdownRequested(parent);

  const config = getNormalizedZeroConfig({env, argv});

  startOtelAuto(
    createLogContext(config, 'shadow-syncer', 0, false),
    'shadow-syncer',
    0,
  );
  lc = createLogContext(config, 'shadow-syncer');
  initEventSink(lc, config);

  const {shadowSync, upstream, initialSync} = config;
  const shard = getShardConfig(config);
  const service = new ShadowSyncService(
    lc,
    shard,
    upstream.db,
    getServerContext(config),
    {
      intervalMs: shadowSync.intervalHours * MS_PER_HOUR,
      sampleRate: shadowSync.sampleRate,
      maxRowsPerTable: shadowSync.maxRowsPerTable,
      textCopy: initialSync.textCopy,
    },
  );

  parent.send(['ready', {ready: true}]);

  return runUntilKilled(lc, parent, shutdown, service);
}

// fork()
if (!singleProcessMode()) {
  void exitAfter(
    () => lc,
    () => runWorker(must(parentWorker), process.env, ...process.argv.slice(2)),
  );
}
