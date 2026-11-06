import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'ethers';
import { readFile } from 'node:fs/promises';
import { safeGet, fetchTransaction, fetchSafeTransactions, fetchQueue } from '../src/safe-api.mjs';

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

test('lowercase inventory addresses are checksummed before Safe API lookup', async () => withFetch(async url => {
  const checksum = getAddress('0xc74efc7fdb3bec9c6930e91ffdf761b160df79db');
  assert.match(String(url), new RegExp(`/safes/${checksum}/`));
  if (String(url).endsWith(`/safes/${checksum}/`)) return new Response(JSON.stringify({ address: checksum, nonce: 0, owners: [], threshold: 1 }), { status: 200 });
  return new Response(JSON.stringify({ results: [], next: null }), { status: 200 });
}, async () => {
  const queue = await fetchSafeTransactions('0xc74efc7fdb3bec9c6930e91ffdf761b160df79db', 'eth', 'pending', 1);
  assert.equal(queue.source, 'safe_api');
  assert.equal(queue.transactions.length, 0);
}));

test('Safe Gateway can recover a hash and queue when the Transaction Service is unavailable', async () => {
  const tx = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
  const gatewayTx = {
    safeAddress: tx.safe, txStatus: 'AWAITING_CONFIRMATIONS',
    txData: { to: { value: tx.to }, value: tx.value, hexData: tx.data, operation: tx.operation },
    detailedExecutionInfo: { safeTxHash: tx.safeTxHash, nonce: tx.nonce, safeTxGas: tx.safeTxGas, baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken, refundReceiver: { value: tx.refundReceiver }, confirmations: [] },
  };
  await withFetch(async url => {
    const value = String(url);
    if (value.startsWith('https://api.safe.global/')) return new Response('outage', { status: 503 });
    if (value.endsWith(`/transactions/${tx.safeTxHash}`)) return new Response(JSON.stringify(gatewayTx), { status: 200 });
    if (value.endsWith(`/safes/${tx.safe}`)) return new Response(JSON.stringify({ nonce: tx.nonce, threshold: 1, owners: [{ value: tx.safe }] }), { status: 200 });
    if (value.includes(`/safes/${tx.safe}/transactions/queued`)) return new Response(JSON.stringify({ results: [{ transaction: { id: `multisig_${tx.safe}_${tx.safeTxHash}` } }], next: null }), { status: 200 });
    if (value.includes(`/transactions/multisig_${tx.safe}_${tx.safeTxHash}`)) return new Response(JSON.stringify(gatewayTx), { status: 200 });
    throw new Error(`Unexpected request: ${value}`);
  }, async () => {
    const found = await fetchTransaction(tx.safeTxHash, 'eth');
    assert.equal(found.lookupSource, 'safe_gateway');
    const queue = await fetchSafeTransactions(tx.safe, 'eth', 'pending', 1);
    assert.equal(queue.source, 'safe_gateway');
    assert.equal(queue.transactions[0].safeTxHash, tx.safeTxHash);
  });
});

test('fetchQueue uses the pending scope and anonymous quota fails closed', async () => {
  await withFetch(async url => {
    const path = String(url);
    if (path.endsWith(`/safes/${SAFE}/`)) return new Response(JSON.stringify({ address: SAFE, nonce: 0, threshold: 1, owners: [] }), { status: 200 });
    return new Response(JSON.stringify({ results: [], next: null }), { status: 200 });
  }, async () => {
    const queue = await fetchQueue(SAFE, 'eth');
    assert.equal(queue.transactions.length, 0);
  });
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('quota', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' } }); };
  try {
    await assert.rejects(() => safeGet('eth', `/safes/${SAFE}/`, ''), /anonymous monthly quota exhausted/);
    await assert.rejects(() => safeGet('eth', `/safes/${SAFE}/`, ''), /anonymous monthly quota exhausted/);
    assert.equal(requests, 1);
  } finally { globalThis.fetch = original; }
});
