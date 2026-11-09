import test from 'node:test';
import assert from 'node:assert/strict';
import { readJsonResponse } from '../src/response-boundary.mjs';

test('upstream JSON is bounded by declared and actual byte length', async () => {
  assert.deepEqual(await readJsonResponse(new Response('{"ok":true}'), 64), { ok: true });
  await assert.rejects(readJsonResponse(new Response('{"long":"123456789"}', { headers: { 'content-length': '100' } }), 32), /exceeded/);
  await assert.rejects(readJsonResponse(new Response('{"long":"123456789"}'), 10), /exceeded/);
  await assert.rejects(readJsonResponse(new Response('bad'), 32), SyntaxError);
  await assert.rejects(readJsonResponse(new Response('{}'), 0), /Invalid response limit/);
});
