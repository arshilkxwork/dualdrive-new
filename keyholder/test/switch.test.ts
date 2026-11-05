import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, type Frame } from '../src/switch.ts';
import { senderMatches } from '../src/config.ts';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test('parseSse reads frames split across chunks and skips keepalives', async () => {
  const frames: Frame[] = [];
  const body = streamOf([
    'event: connection_state\ndata: {"generation":3,',
    '"rooms":["r1"]}\n\n: keepalive\n\n',
    'id: 4813\nevent: message\ndata: {"type":"message","room_id":"r1","payload":{"addressed":true},"sequence":4813}\n\n',
  ]);
  for await (const frame of parseSse(body)) {
    frames.push(frame);
  }
  assert.equal(frames.length, 2);
  assert.equal(frames[0].event, 'connection_state');
  assert.equal(frames[0].data.generation, 3);
  assert.equal(frames[1].id, '4813');
  assert.deepEqual(frames[1].data.payload, { addressed: true });
});

test('senderMatches by participant id exactly, or by name ignoring case', () => {
  assert.equal(senderMatches(['@switch-user-a:local'], '@switch-user-a:local', 'Alice'), true);
  assert.equal(senderMatches(['@switch-user-a:local'], '@switch-user-b:local', 'Alice'), false);
  assert.equal(senderMatches(['alice', 'bob'], '@x:local', 'Bob'), true);
  assert.equal(senderMatches(['alice'], '@x:local', 'mallory'), false);
});
