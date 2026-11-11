import {EventEmitter} from 'node:events';
import {expect, test, vi} from 'vitest';
import {resolver} from '../../../shared/src/resolver.ts';
import {
  deliverSignal,
  forkChildWorker,
  raiseSignal,
  sendSignal,
  type Subprocess,
} from './processes.ts';

const FIXTURE = new URL('./signal-delivery-fixture.ts', import.meta.url);
const EXIT_GUARD_MS = 10_000;

function fakeSubprocess(connected: boolean | undefined) {
  const proc = Object.assign(new EventEmitter(), {
    connected,
    send: vi.fn(() => true),
    kill: vi.fn(),
  });
  return proc as typeof proc & Subprocess;
}

function fakeTarget() {
  const target = Object.assign(new EventEmitter(), {pid: 4242, kill: vi.fn()});
  return target;
}

test('on Windows a subprocess with an IPC channel is sent the signal as a message', () => {
  const proc = fakeSubprocess(true);

  sendSignal(proc, 'SIGTERM', 'win32');

  expect(proc.send).toHaveBeenCalledWith(['signal', 'SIGTERM']);
  expect(proc.kill).not.toHaveBeenCalled();
});

test.each([
  ['win32', undefined],
  ['win32', false],
  ['linux', true],
  ['darwin', true],
] as const)(
  'on %s a subprocess whose channel is %s is signalled with kill()',
  (platform, connected) => {
    const proc = fakeSubprocess(connected);

    sendSignal(proc, 'SIGTERM', platform);

    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(proc.send).not.toHaveBeenCalled();
  },
);

test('a delivered signal reaches the listeners, as the operating system delivers it', () => {
  const target = fakeTarget();
  const received: unknown[] = [];
  target.on('SIGTERM', signal => received.push(signal));

  deliverSignal(
    target as unknown as Parameters<typeof deliverSignal>[0],
    'SIGTERM',
  );

  expect(received).toEqual(['SIGTERM']);
  expect(target.kill).not.toHaveBeenCalled();
});

test('a delivered signal with no listener takes the default action', () => {
  const target = fakeTarget();

  deliverSignal(
    target as unknown as Parameters<typeof deliverSignal>[0],
    'SIGTERM',
  );

  expect(target.kill).toHaveBeenCalledWith(4242, 'SIGTERM');
});

test('on Windows a signal raised in this process reaches its listener', () => {
  const listener = vi.fn();
  process.on('SIGUSR2', listener);
  try {
    raiseSignal('SIGUSR2', 'win32');
  } finally {
    process.off('SIGUSR2', listener);
  }

  expect(listener).toHaveBeenCalledWith('SIGUSR2');
});

/** Forks the fixture, waits for it to report ready, signals it and awaits its exit. */
async function signalForkedWorker(
  ...args: string[]
): Promise<{code: number | null; signal: NodeJS.Signals | null}> {
  const ready = resolver<void>();
  const exited = resolver<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  const child = forkChildWorker(FIXTURE, undefined, ...args);
  child.onceMessageType('ready', () => ready.resolve());
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) =>
    exited.resolve({code, signal}),
  );
  child.on('error', err => ready.reject(err));
  await ready.promise;

  sendSignal(child, 'SIGTERM');

  const guard = setTimeout(() => child.kill('SIGKILL'), EXIT_GUARD_MS);
  try {
    return await exited.promise;
  } finally {
    clearTimeout(guard);
  }
}

test('a forked worker that handles SIGTERM runs its handler', async () => {
  expect(await signalForkedWorker('--handle-sigterm')).toEqual({
    code: 0,
    signal: null,
  });
});

test('a forked worker that does not handle SIGTERM is terminated by it', async () => {
  expect(await signalForkedWorker()).not.toEqual({code: 0, signal: null});
});
