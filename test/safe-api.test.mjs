import test from 'node:test';
import assert from 'node:assert/strict';
import { safeGet, fetchTransaction, fetchSafeTransactions } from '../src/safe-api.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;

async function withFetch(handler, run) {
  const previous = { fetch: globalThis.fetch, key: process.env.SAFE_API_KEY };
  process.env.SAFE_API_KEY = 'test-only-safe-key';
  globalThis.fetch = handler;
  try { return await run(); }
  finally {
    globalThis.fetch = previous.fetch;
    if (previous.key === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = previous.key;
  }
}

test('Safe Transaction Service requests use the configured key and validate paths', async () => withFetch(async (url, options) => {
  assert.match(String(url), /\/tx-service\/eth\/api\/v1\/safes\//);
  assert.equal(options.headers.Authorization, 'Bearer explicit-test-key');
  return new Response(JSON.stringify({ address: SAFE, nonce: 8 }), { status: 200 });
}, async () => {
  const result = await safeGet('eth', `/safes/${SAFE}/`, 'explicit-test-key');
  assert.equal(result.address, SAFE);
  await assert.rejects(() => safeGet('eth', '/../../user', 'explicit-test-key'), /Invalid Safe API path/);
  await assert.rejects(() => safeGet('unknown', `/safes/${SAFE}/`, 'explicit-test-key'), /Unsupported/);
}));

test('a hash lookup records the live source and queue pages preserve their coverage', async () => withFetch(async (url, options) => {
  assert.equal(options.headers.Authorization, 'Bearer test-only-safe-key');
  const path = String(url);
  if (path.includes('/multisig-transactions/' + HASH + '/')) return new Response(JSON.stringify({ safe: SAFE, safeTxHash: HASH }), { status: 200 });
  if (path.endsWith(`/safes/${SAFE}/`)) return new Response(JSON.stringify({ address: SAFE, nonce: 8, owners: [SAFE], threshold: 1 }), { status: 200 });
  if (path.includes('/multisig-transactions/?')) return new Response(JSON.stringify({ results: [{ safeTxHash: HASH, nonce: 8 }], next: 'next-page' }), { status: 200 });
  throw new Error(`Unexpected request: ${path}`);
}, async () => {
  const transaction = await fetchTransaction(HASH, 'eth');
  assert.equal(transaction.lookupSource, 'safe_api');
  const queue = await fetchSafeTransactions(SAFE, 'eth', 'pending', 1);
  assert.equal(queue.source, 'safe_api');
  assert.equal(queue.transactions[0].safeTxHash, HASH);
  assert.equal(queue.truncated, true);
}));

test('an API failure does not silently turn an unavailable queue into an empty one', async () => withFetch(async () => new Response('failure', { status: 503 }), async () => {
  await assert.rejects(() => fetchSafeTransactions(SAFE, 'eth', 'pending', 1), /Safe API 503.*Safe Client Gateway 503/);
  await assert.rejects(() => fetchSafeTransactions(SAFE, 'eth', 'pending', 0), /limit/);
}));
