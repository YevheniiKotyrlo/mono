import {expect} from 'vitest';
import {test} from '../test/db.ts';

const ANSWER_GUARD_MS = 5_000;

// Over the readable's 16 KiB buffer, so the stream pauses the socket.
const COPY_LARGER_THAN_THE_BUFFER =
  "COPY (SELECT repeat('x', 1000) FROM generate_series(1, 2000)) TO STDOUT";

/** Whether the connection answers its next statement before the guard expires. */
async function answersNextStatement(
  statement: () => Promise<unknown>,
): Promise<'answered' | 'hung'> {
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      statement().then(() => 'answered' as const),
      new Promise<'hung'>(resolve => {
        guard = setTimeout(resolve, ANSWER_GUARD_MS, 'hung');
      }),
    ]);
  } finally {
    clearTimeout(guard);
  }
}

test('a connection answers after its consumer destroys a COPY TO stream', async ({
  testDBs,
}) => {
  const db = await testDBs.create('pg_copy_stream_destroyed');
  const reserved = await db.reserve();
  try {
    const stream = await reserved
      .unsafe(COPY_LARGER_THAN_THE_BUFFER)
      .readable();
    await new Promise<void>(resolve => stream.once('data', () => resolve()));
    stream.destroy();

    expect(await answersNextStatement(() => reserved`SELECT 1`)).toBe(
      'answered',
    );
  } finally {
    reserved.release();
    // A hung connection would hold a graceful end, and the drop behind it.
    await db.end({timeout: 0});
    await testDBs.drop(db);
  }
});

test('a connection answers after a COPY TO stream is read to its end', async ({
  testDBs,
}) => {
  const db = await testDBs.create('pg_copy_stream_ended');
  const reserved = await db.reserve();
  try {
    const stream = await reserved
      .unsafe(COPY_LARGER_THAN_THE_BUFFER)
      .readable();
    let bytes = 0;
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length;
    }

    expect(bytes).toBe(2000 * 1001);
    expect(await answersNextStatement(() => reserved`SELECT 1`)).toBe(
      'answered',
    );
  } finally {
    reserved.release();
    // A hung connection would hold a graceful end, and the drop behind it.
    await db.end({timeout: 0});
    await testDBs.drop(db);
  }
});
