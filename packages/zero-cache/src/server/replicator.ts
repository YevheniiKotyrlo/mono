import {stat} from 'node:fs/promises';
import {pid} from 'node:process';
import type {ObservableCallback} from '@opentelemetry/api';
import {consoleLogSink, LogContext} from '@rocicorp/logger';
import {assert} from '../../../shared/src/asserts.ts';
import {must} from '../../../shared/src/must.ts';
import {raceAbort} from '../../../shared/src/promise-race.ts';
import {sleep} from '../../../shared/src/sleep.ts';
import * as v from '../../../shared/src/valita.ts';
import type {
  LitestreamConfig,
  NormalizedZeroConfig,
} from '../config/normalize.ts';
import {getNormalizedZeroConfig} from '../config/zero-config.ts';
import {registerSQLiteCorruptionDiagnosticTarget} from '../db/sqlite-corruption.ts';
import {initEventSink} from '../observability/events.ts';
import {getOrCreateGauge} from '../observability/metrics.ts';
import {ChangeStreamerHttpClient} from '../services/change-streamer/change-streamer-http.ts';
import {reserveAndGetSnapshotStatus} from '../services/change-streamer/snapshot.ts';
import {
  exitAfter,
  runUntilKilled,
  shutdownRequested,
} from '../services/life-cycle.ts';
import {
  tryRestore,
  type RestoreResult,
} from '../services/litestream/commands.ts';
import {
  litestreamRestoreDuration,
  litestreamRestoreMetricAttrs,
  litestreamRestoreRuns,
} from '../services/litestream/metrics.ts';
import {ReplicationStatusPublisher} from '../services/replicator/replication-status.ts';
import {
  ReplicatorService,
  type ReplicatorMode,
} from '../services/replicator/replicator.ts';
import {sqliteFileBytes} from '../services/replicator/sqlite-change-log-observability.ts';
import {
  ThreadWriteWorkerClient,
  type ForceCheckpointConfig,
} from '../services/replicator/write-worker-client.ts';
import {
  parentWorker,
  singleProcessMode,
  type Worker,
} from '../types/processes.ts';
import {installProfileHandler} from '../types/profiler.ts';
import {getShardConfig} from '../types/shards.ts';
import {
  deleteStaleChangeLog,
  getPragmaConfig,
  replicaFileModeSchema,
  setUpMessageHandlers,
  setupReplica,
  type WalMode,
} from '../workers/replicator.ts';
import {createLogContext} from './logging.ts';
import {startOtelAuto} from './otel-start.ts';

// Default LogContext, overridden in runWorker
let lc = new LogContext('info', {}, consoleLogSink);

export default async function runWorker(
  parent: Worker,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): Promise<void> {
  assert(args.length > 0, `replicator mode not specified`);
  const fileMode = v.parse(args[0], replicaFileModeSchema);

  const config = getNormalizedZeroConfig({env, argv: args.slice(1)});
  const mode: ReplicatorMode = fileMode === 'backup' ? 'backup' : 'serving';
  const runningLocalChangeStreamer =
    config.changeStreamer.mode === 'dedicated' && !config.changeStreamer.uri;
  const workerName = `${mode}-replicator`;
  installProfileHandler(parent, workerName);
  startOtelAuto(createLogContext(config, workerName, 0, false), workerName, 0);
  lc = createLogContext(config, workerName);
  const unregisterInitialCorruptionDiagnosticTarget =
    registerSQLiteCorruptionDiagnosticTarget(
      {
        debugName: `${workerName} replica`,
        dbPath: config.replica.file,
      },
      config.sqliteCorruptionChecks,
    );
  initEventSink(lc, config);

  // Remote view-syncers restore from the replication-manager, which supplies
  // the backup URL. A local change-streamer owns the canonical replica and
  // must not infer backup configuration from bundled executable paths.
  //
  // Armed before the restore, not after it: the restore is the one part of
  // startup with no bound, so it is the part that has to be interruptible.
  const shutdown = shutdownRequested(parent);

  if (
    fileMode === 'serving' &&
    !runningLocalChangeStreamer &&
    (config.litestream.executable || config.litestream.executableV5)
  ) {
    if (!(await restoreReplica(lc, config, shutdown))) {
      // Asked to stop mid-restore. There is nothing to drain — no replica is open
      // and no service has started — so returning is the whole shutdown.
      lc.info?.('shutdown requested while restoring the replica');
      return;
    }
  }

  const {
    file: dbPath,
    walMode,
    pageSize,
  } = await setupReplica(lc, fileMode, config.replica);
  unregisterInitialCorruptionDiagnosticTarget();
  registerSQLiteCorruptionDiagnosticTarget(
    {
      debugName: `${workerName} replica`,
      dbPath,
    },
    config.sqliteCorruptionChecks,
  );

  // A file left behind by a run with the writer enabled would otherwise hold
  // local disk indefinitely. See `replicatorDeletesStaleChangeLog` for why
  // this is keyed on the config flag and nothing else.
  deleteStaleChangeLog(config.changeStreamer.sqliteChangeLogMode, dbPath);

  setupMetrics(lc, dbPath, walMode);

  // Create the write worker for async SQLite writes. Enable write-path
  // checkpoint backpressure only for the backup replicator on litestream v5,
  // which owns the replica litestream backs up.
  const pragmas = getPragmaConfig(fileMode);
  const checkpoint: ForceCheckpointConfig | null =
    mode === 'backup' &&
    config.litestream.backupURL &&
    config.litestream.backupUsingV5 &&
    config.litestream.forceCheckpointThresholdMB
      ? {
          checkpointThresholdPages:
            (config.litestream.forceCheckpointThresholdMB * 1024 ** 2) /
            pageSize,
          maxWalPages: !config.litestream.maxWalSizeMB
            ? undefined
            : (config.litestream.maxWalSizeMB * 1024 ** 2) / pageSize,
        }
      : null;
  const workerClient = new ThreadWriteWorkerClient();
  await workerClient.init(dbPath, mode, pragmas, config.log, checkpoint);

  const shard = getShardConfig(config);
  const {
    taskID,
    change,
    changeStreamer: {
      port,
      uri: changeStreamerURI = runningLocalChangeStreamer
        ? `http://localhost:${port}/`
        : undefined,
    },
  } = config;
  const changeStreamer = new ChangeStreamerHttpClient(
    lc,
    shard,
    change.db,
    changeStreamerURI,
  );

  const replicator = new ReplicatorService(
    lc,
    taskID,
    `${workerName}-${pid}`,
    mode,
    changeStreamer,
    workerClient,
    runningLocalChangeStreamer
      ? // publish ReplicationStatusEvents from backup-replicator only
        ReplicationStatusPublisher.forReplicaFile(dbPath)
      : null,
  );

  setUpMessageHandlers(lc, replicator, parent);

  // The signal armed before the restore, not a fresh one: a request that arrived
  // during startup is already recorded in it, and this is the first point at which
  // there is a service to hand it to.
  const running = runUntilKilled(lc, parent, shutdown, replicator);

  // Readiness, raced against the request to shut down. `runUntilKilled` starts
  // nothing once the request has arrived, and `subscribe()` reports a state only
  // once one is known — which never happens before `run()` — so waiting for it
  // unconditionally would wait forever, holding the replica open while the
  // manager's deadline elapses.
  await raceAbort(
    (async () => {
      for await (const _ of replicator.subscribe()) {
        parent.send(['ready', {ready: true}]);
        break;
      }
    })(),
    shutdown,
  );

  return running;
}

function setupMetrics(lc: LogContext, file: string, walMode: WalMode) {
  getOrCreateGauge('replica', 'db_size', {
    description:
      `The size of the replica's main db file, ` +
      `which does not include the wal file(s)`,
    unit: 'bytes',
  }).addCallback(observeFileSize(lc, file));

  getOrCreateGauge('replica', 'wal_size', {
    description: `The size of the replica's wal file`,
    unit: 'bytes',
  }).addCallback(observeFileSize(lc, `${file}-wal`));

  if (walMode === 'wal2') {
    getOrCreateGauge('replica', 'wal2_size', {
      description: `The size of the replica's wal2 file`,
      unit: 'bytes',
    }).addCallback(observeFileSize(lc, `${file}-wal2`));
  }

  // A whole-database total rather than a per-file one. Its counterpart,
  // `sqlite_change_log.file_bytes`, is emitted by the change-streamer, which is
  // the process that writes the log.
  getOrCreateGauge('replica', 'file_bytes', {
    description:
      `The replica's total on-disk footprint: its main db file plus its ` +
      `wal sidecars.`,
    unit: 'By',
  }).addCallback(observeSQLiteFileBytes(lc, file));
}

function observeFileSize(lc: LogContext, file: string): ObservableCallback {
  return async o => {
    try {
      const stats = await stat(file);
      o.observe(stats.size);
    } catch (e) {
      lc.warn?.(`unable to stat ${file} for size metrics`, e);
    }
  };
}

function observeSQLiteFileBytes(
  lc: LogContext,
  file: string,
): ObservableCallback {
  return async o => o.observe(await sqliteFileBytes(lc, file));
}

const RETRY_INTERVAL_MS = 3000;

// View-syncers (no replicaConstraints) wait indefinitely for the
// replication-manager to publish a restorable backup. On a fresh stack the
// first backup is not durable until the initial sync completes and litestream
// uploads the initial snapshot, which can take many minutes for a large
// replica. The platform's startup probe budget (which scales with replica
// size) is the backstop, so restoreReplica must not impose its own shorter
// cap and self-terminate while the backup is still being produced.
//
// Unbounded is not the same as uninterruptible, though. `shutdown` ends the WAITING
// early when the manager asks the worker to stop — the reservation and the retry
// sleep both race it. A restore attempt already in flight is not interrupted:
// litestream runs as a subprocess, so the request is acted on when that attempt
// returns, which bounds the delay by one attempt rather than by the whole loop.
//
// @returns whether the replica was restored; `false` means shutdown was
//     requested first, and no replica was opened.
async function restoreReplica(
  lc: LogContext,
  config: NormalizedZeroConfig,
  shutdown: AbortSignal,
): Promise<boolean> {
  const start = performance.now();
  let backupURL: string | undefined;
  let result: RestoreResult | undefined;
  try {
    while (!shutdown.aborted) {
      let snapshotStatus;
      try {
        snapshotStatus = await reserveAndGetSnapshotStatus(
          lc,
          config,
          shutdown,
        );
      } catch (e) {
        if (shutdown.aborted) {
          break; // asked to stop while waiting to reserve
        }
        throw e;
      }
      // The backupURL comes from the replication-manager's snapshot response.
      ({backupURL} = snapshotStatus);
      const litestream: LitestreamConfig = {...config.litestream, backupURL};
      const attempt = await tryRestore(
        lc,
        litestream,
        config.replica.file,
        snapshotStatus,
        'view_syncer',
      );
      if (attempt.restored) {
        result = attempt.result;
        return true;
      }
      lc.info?.(
        `replica not found. retrying in ${RETRY_INTERVAL_MS / 1000} seconds`,
      );
      // Swallowed rather than propagated: an abort here is the requested
      // shutdown, not a failure, and the loop condition is what acts on it.
      await sleep(RETRY_INTERVAL_MS, shutdown).catch(() => {});
    }
    return false;
  } finally {
    const attrs = litestreamRestoreMetricAttrs(
      config.litestream,
      'view_syncer',
      backupURL,
    );
    // A shutdown is neither a success nor a failure. Reporting it as 'error'
    // would make the restore-failure metric fire on every rolling restart that
    // catches a view-syncer mid-restore.
    const labels = {
      ...attrs,
      result: result ?? (shutdown.aborted ? 'shutdown' : 'error'),
    };
    litestreamRestoreRuns().add(1, labels);
    litestreamRestoreDuration().recordMs(performance.now() - start, labels);
  }
}

// fork()
if (!singleProcessMode()) {
  void exitAfter(
    () => lc,
    () => runWorker(must(parentWorker), process.env, ...process.argv.slice(2)),
  );
}
