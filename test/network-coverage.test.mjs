import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNetworks, publicSnapshot } from '../scripts/check-networks.mjs';
import { CHAINS } from '../src/chains.mjs';
import { analyze } from '../src/analyze.mjs';

const credentials = async () => ({ SAFE_API_KEY: 'fixture-only' });
const pause = async () => {};

test('offline Safe hashes and call decoding work on every named chain without spending API quota', async () => {
  const safe = '0x1111111111111111111111111111111111111111';
  const hashes = new Set();
  for (const [network, id] of Object.entries(CHAINS)) {
    const report = await analyze({ safe, to: safe, nonce: 4, value: '0', data: '0x', operation: 0 }, network, { fetchState: false, verifyTargets: false });
    assert.equal(report.chainId, id);
    assert.equal(report.call.to, safe);
    assert.match(report.calculatedHash, /^0x[0-9a-f]{64}$/);
    hashes.add(report.calculatedHash);
  }
  assert.equal(hashes.size, Object.keys(CHAINS).length);
});

test('network probe spends exactly three Safe units per named chain and validates response shapes', async () => {
  const urls = [];
  const request = async url => {
    urls.push(String(url));
    const body = String(url).includes('/about/indexing/') ? { synced: true, currentBlockNumber: 12 } : { count: 0, results: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'x-ratelimit-remaining': '4000' } });
  };
  const result = await probeNetworks({ request, credentials, pause, includeRpc: false });
  assert.equal(result.safeRequests, Object.keys(CHAINS).length * 3);
  assert.equal(urls.length, Object.keys(CHAINS).length * 3);
  assert.equal(result.networks.length, Object.keys(CHAINS).length);
  assert.ok(result.networks.every(row => Object.values(row.safe).every(value => value.status === 'available')));
  assert.ok(urls.every(url => url.startsWith('https://api.safe.global/tx-service/')));
  assert.ok(urls.some(url => url.includes('/tx-service/katana/')));
  assert.ok(urls.some(url => url.includes('/tx-service/okb/')));
  const snapshot = publicSnapshot(result);
  assert.equal(snapshot.networks.length, Object.keys(CHAINS).length);
  assert.equal(snapshot.networks[0].pending, 'available');
  assert.doesNotMatch(JSON.stringify(snapshot), /fixture-only|safeQuotaRemaining|4000/);
});

test('a Safe 429 stops all later probes before consuming more quota', async () => {
  let requests = 0;
  const result = await probeNetworks({ request: async () => { requests++; return new Response('{}', { status: 429, headers: { 'x-ratelimit-remaining': '0' } }); }, credentials, pause, includeRpc: false });
  assert.equal(requests, 1);
  assert.equal(result.stopped, 'safe_rate_limited');
  assert.equal(result.networks[0].safe.indexing.status, 'quota_limited');
  assert.equal(result.networks[0].safe.pending.status, 'not_tested');
  assert.equal(result.networks.at(-1).safe.history.status, 'not_tested');
});

test('quota floor stops probes and malformed 200 never becomes available', async () => {
  let requests = 0;
  const result = await probeNetworks({ request: async () => { requests++; return new Response('not-json', { status: 200, headers: { 'x-ratelimit-remaining': '99' } }); }, credentials, pause, includeRpc: false });
  assert.equal(requests, 1);
  assert.equal(result.networks[0].safe.indexing.status, 'invalid_response');
  assert.equal(result.networks[0].safe.pending.status, 'not_tested');
  assert.equal(result.stopped, 'request_budget_or_quota_floor');
});

test('network probe distinguishes a wrong RPC chain from Safe availability', async () => {
  const request = async (url, options) => options?.method === 'POST'
    ? new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2' }), { status: 200 })
    : new Response(JSON.stringify(String(url).includes('/about/indexing/') ? { synced: false, currentBlockNumber: 1 } : { count: 0, results: [] }), { status: 200, headers: { 'x-ratelimit-remaining': '4000' } });
  const result = await probeNetworks({ request, credentials, pause });
  assert.equal(result.networks[0].safe.indexing.status, 'indexer_lagging');
  assert.equal(result.networks[0].rpc.status, 'wrong_chain');
  assert.equal(result.networks.some(row => row.network === 'zkevm'), false);
});
