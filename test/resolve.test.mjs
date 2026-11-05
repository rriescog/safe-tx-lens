import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateHash, normalizeTransaction } from '../src/analyze.mjs';
import { resolve } from '../src/resolve.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const base = { safe: SAFE, to: TARGET, nonce: 3, value: '0', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: '0x0000000000000000000000000000000000000000', refundReceiver: '0x0000000000000000000000000000000000000000' };
const transactions = Object.fromEntries(['gno', 'pol'].map(network => [network, { ...base, safeTxHash: calculateHash(normalizeTransaction(base), network) }]));

test('a previously unknown hash is fetched from Safe services, verified, and attributed', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.SAFE_API_KEY;
  process.env.SAFE_API_KEY = 'test-only-key';
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.tenderly.co') return new Response('unavailable', { status: 503 });
    if (parsed.hostname === 'api.etherscan.io') return new Response(JSON.stringify({ status: '0', message: 'No records found', result: [] }), { status: 200 });
    if (parsed.hostname === 'api.safe.global') {
      if (parsed.pathname.endsWith(`/multisig-transactions/${transactions.gno.safeTxHash}/`)) return new Response(JSON.stringify(transactions.gno), { status: 200 });
      if (parsed.pathname.endsWith(`/safes/${SAFE}/`)) return new Response(JSON.stringify({ address: SAFE, nonce: 3, threshold: 1, owners: [SAFE] }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const report = await resolve(transactions.gno.safeTxHash, 'gno');
    assert.equal(report.evidence.source, 'safe_api');
    assert.equal(report.network, 'gno');
    assert.equal(report.transaction.safe, SAFE);
    assert.equal(report.checks[0].status, 'pass');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = oldKey;
  }
});

test('a bare Safe address lists every discovered network instead of silently choosing one', async () => {
  const oldFetch = globalThis.fetch;
  const oldKey = process.env.SAFE_API_KEY;
  process.env.SAFE_API_KEY = 'test-only-key';
  globalThis.fetch = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === 'api.tenderly.co') return new Response('unavailable', { status: 503 });
    if (parsed.hostname !== 'api.safe.global') return new Response('not found', { status: 404 });
    const network = parsed.pathname.match(/\/tx-service\/([^/]+)\//)?.[1];
    if (!transactions[network]) return new Response('not found', { status: 404 });
    if (parsed.pathname.endsWith(`/safes/${SAFE}/`)) return new Response(JSON.stringify({ address: SAFE, nonce: 3, threshold: 1, owners: [SAFE] }), { status: 200 });
    if (parsed.pathname.endsWith(`/safes/${SAFE}/multisig-transactions/`)) return new Response(JSON.stringify({ results: [transactions[network]], next: null }), { status: 200 });
    return new Response('not found', { status: 404 });
  };
  try {
    const result = await resolve(SAFE, 'auto', { scope: 'pending', limit: 1 });
    assert.equal(result.kind, 'queue');
    assert.deepEqual(result.networks, ['gno', 'pol']);
    assert.deepEqual(result.reports.map(report => report.network), ['gno', 'pol']);
    assert.ok(result.reports.every(report => report.checks[0].status === 'pass'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = oldKey;
  }
});
