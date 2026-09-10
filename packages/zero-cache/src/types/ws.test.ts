import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {resolver} from '@rocicorp/resolver';
import {afterAll, beforeAll, describe, expect, test} from 'vitest';
import WebSocket, {WebSocketServer} from 'ws';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {must} from '../../../shared/src/must.ts';
import {closeWithError, PROTOCOL_ERROR} from './ws.ts';

describe('types/ws', () => {
  let port: number;
  let wss: WebSocketServer;

  beforeAll(async () => {
    // Bound rather than chosen: a picked port collides with whatever already
    // holds it, and that collision is a flake nobody can reproduce on purpose.
    wss = new WebSocketServer({port: 0});
    await once(wss, 'listening');
    port = must(wss.address() as AddressInfo | null).port;
  });

  afterAll(() => {
    wss.close();
  });

  test('close with protocol error', async () => {
    wss.on('connection', ws =>
      closeWithError(
        createSilentLogContext(),
        ws,
        'こんにちは' + 'あ'.repeat(150),
        PROTOCOL_ERROR,
      ),
    );

    const ws = new WebSocket(`ws://localhost:${port}/`);
    const {promise, resolve} = resolver<{code: number; reason: string}>();
    ws.on('close', (code, reason) =>
      resolve({code, reason: reason.toString('utf-8')}),
    );

    const error = await promise;
    expect(error).toMatchInlineSnapshot(`
      {
        "code": 1002,
        "reason": "こんにちはあああああああああああああああああああああああああああああああああああ...",
      }
    `);
    // close messages must be less than or equal to 123 bytes:
    // https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/close#reason
    expect(new TextEncoder().encode(error.reason).length).toBeLessThanOrEqual(
      123,
    );
  });
});
