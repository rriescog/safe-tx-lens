import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeBuilderExport } from '../src/builder.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const OTHER = '0x3333333333333333333333333333333333333333';
const fixture = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
const exported = { chainId: '1', meta: { createdFromSafeAddress: fixture.safe }, transactions: [{ to: fixture.to, value: fixture.value, data: fixture.data, operation: fixture.operation }] };

function withSafeResponse(handler, run) {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.SAFE_API_KEY;
  process.env.SAFE_API_KEY = 'builder-test-key';
  globalThis.fetch = handler;
  return Promise.resolve().then(run).finally(() => {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = oldKey;
  });
}

test('Builder comparison recovers the exact Safe transaction and rejects a different Safe', async () => withSafeResponse(async url => {
  assert.match(String(url), /\/multisig-transactions\//);
  return new Response(JSON.stringify(fixture), { status: 200 });
}, async () => {
  const matched = await analyzeBuilderExport(exported, 'eth', { safeHash: fixture.safeTxHash, fetchState: false, verifyTargets: false, rpcUrl: '' });
  assert.equal(matched.comparison.status, 'match');
  assert.equal(matched.comparison.nonce, String(fixture.nonce));
  const wrongSafe = await analyzeBuilderExport(exported, 'eth', { safeAddress: OTHER, safeHash: fixture.safeTxHash, fetchState: false, verifyTargets: false, rpcUrl: '' });
  assert.equal(wrongSafe.comparison.status, 'mismatch');
  assert.match(wrongSafe.warnings[0], /differs/);
}));

test('Builder comparison explicitly reports unavailable proposals and invalid inputs', async () => withSafeResponse(async () => new Response('unavailable', { status: 503 }), async () => {
  const missing = await analyzeBuilderExport(exported, 'eth', { safeHash: fixture.safeTxHash, rpcUrl: '', verifyTargets: false });
  assert.equal(missing.comparison.status, 'unavailable');
  await assert.rejects(() => analyzeBuilderExport(exported, 'eth', { safeHash: '0x123' }), /Safe transaction hash/);
  await assert.rejects(() => analyzeBuilderExport(exported, 'eth', { safeAddress: '0x123' }), /Invalid Safe address/);
  await assert.rejects(() => analyzeBuilderExport({ ...exported, transactions: [{ ...exported.transactions[0], data: '0xabc' }] }, 'eth'), /invalid transaction/);
  await assert.rejects(() => analyzeBuilderExport({ ...exported, transactions: [{ ...exported.transactions[0], value: '-1' }] }, 'eth'), /invalid transaction/);
  await assert.rejects(() => analyzeBuilderExport({ ...exported, transactions: [{ ...exported.transactions[0], to: '0x123' }] }, 'eth'), /invalid transaction/);
  const fallback = await analyzeBuilderExport(exported, 'eth', { safeHash: fixture.safeTxHash, rpcUrl: '', provider: { getNetwork: async () => { throw new Error('offline'); }, getBlockNumber: async () => 0 }, verifyTargets: false });
  assert.equal(fallback.comparison.status, 'unavailable');
  assert.match(fallback.warnings.join(' '), /Onchain hash lookup unavailable/);
}));

test('Builder comparison rejects a fetched transaction with a forged Safe hash', async () => withSafeResponse(async () => new Response(JSON.stringify({ ...fixture, nonce: Number(fixture.nonce) + 1 }), { status: 200 }), async () => {
  const result = await analyzeBuilderExport(exported, 'eth', { safeHash: fixture.safeTxHash, fetchState: false, verifyTargets: false, rpcUrl: '' });
  assert.equal(result.comparison.status, 'mismatch');
  assert.match(result.comparison.detail, /failed independent EIP-712 verification/);
}));
