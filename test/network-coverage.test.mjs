import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNetworks, publicSnapshot } from '../scripts/check-networks.mjs';
import { CHAINS } from '../src/chains.mjs';
import { analyze } from '../src/analyze.mjs';
import { PUBLIC_RPC } from '../src/onchain.mjs';
import { readFile } from 'node:fs/promises';

const credentials = async () => ({ SAFE_API_KEY: 'fixture-only' });
const pause = async () => {};

test('every advertised named network has a configured RPC, coverage row, example row, and local override name', async () => {
  const [coverage, examples, html, env] = await Promise.all([
    readFile(new URL('../web/network-coverage.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../web/network-examples.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
  ]);
  const networks = Object.keys(CHAINS).sort();
  assert.deepEqual(Object.keys(PUBLIC_RPC).sort(), networks);
  assert.deepEqual(coverage.networks.map(row => row.network).sort(), networks);
  assert.deepEqual(examples.networks.map(row => row.network).sort(), networks);
  for (const network of networks) {
    assert.match(html, new RegExp(`<option value="${network}"`));
    assert.match(env, new RegExp(`^RPC_URL_${network.toUpperCase()}=`, 'm'));
    assert.equal(coverage.networks.find(row => row.network === network).chainId, CHAINS[network]);
  }
  assert.equal(new Set(coverage.networks.map(row => row.network)).size, networks.length);
  assert.equal(new Set(examples.networks.map(row => row.network)).size, networks.length);
});

test('production configuration inventory names every Compose and deployment setting', async () => {
  const [env, ...configs] = await Promise.all([
    readFile(new URL('../.env.example', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/compose.tenderly.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/compose.etherscan.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../deploy/compose.oklink.yaml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/ci-cd.yml', import.meta.url), 'utf8'),
  ]);
  const workflow = configs.pop();
  const compose = configs.join('\n');
  const variableNames = [...compose.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?::[^}]*)?\}/g)].map(match => match[1]);
  for (const name of variableNames) assert.match(env, new RegExp(`^${name}=`, 'm'));
  const repoSettings = [...workflow.matchAll(/\$\{\{\s*(?:vars|secrets)\.([A-Z][A-Z0-9_]*)\s*\}\}/g)].map(match => match[1]);
  for (const name of repoSettings) assert.match(env, new RegExp(`\\b${name}\\b`));
  for (const name of ['SAFE_API_KEY_FILE', 'TENDERLY_ACCESS_KEY_FILE', 'ETHERSCAN_API_KEY_FILE', 'OKLINK_API_KEY_FILE']) assert.match(env, new RegExp(`\\b${name}\\b`));
});

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
