import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';

test('local API accepts an offline plan, rejects cross-origin posts, and limits simulation to one transaction', async () => {
  const server = await serve({ port: 0 });
  const url = `http://127.0.0.1:${server.address().port}/api/inspect`;
  const post = (payload, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  try {
    for (const suffix of ['/', '/?', `/?hash=0x${'a'.repeat(64)}`]) {
      const landing = await fetch(`http://127.0.0.1:${server.address().port}${suffix}`);
      assert.equal(landing.status, 200);
      assert.match(await landing.text(), /Safe Tx Lens/);
    }
    const coverage = await fetch(`http://127.0.0.1:${server.address().port}/api/network-coverage`);
    assert.equal(coverage.status, 200);
    const snapshot = await coverage.json();
    assert.equal(snapshot.networks.length, 10);
    assert.equal(snapshot.networks.find(row => row.network === 'zkevm').pending, 'not_available');
    assert.doesNotMatch(JSON.stringify(snapshot), /SAFE_API_KEY|safeQuotaRemaining/);
    const plan = { chainId: '1', meta: {}, transactions: [{ to: SAFE, value: '0', data: '0x' }] };
    const valid = await post({ input: plan, network: 'eth' });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).kind, 'builder');

    const foreign = await post({ input: plan, network: 'eth' }, { Origin: 'https://example.invalid' });
    assert.equal(foreign.status, 403);

    const broadSimulation = await post({ input: SAFE, network: 'eth', simulate: true });
    assert.equal(broadSimulation.status, 400);
    assert.match((await broadSimulation.json()).error, /Select one transaction/);

    const malformed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('upstream Safe quota failure is a service error with a machine-readable code', async () => {
  const server = await serve({ port: 0, rpcUrl: '' });
  const original = globalThis.fetch;
  const safeKey = process.env.SAFE_API_KEY;
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  // Exercise the anonymous path even when the developer has local credentials.
  process.env.SAFE_API_KEY = '';
  process.env.ETHERSCAN_API_KEY = '';
  globalThis.fetch = async url => new Response('{}', { status: String(url).includes('api.safe.global') ? 429 : 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '60' } });
  try {
    const response = await original(`http://127.0.0.1:${server.address().port}/api/inspect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: `0x${'ab'.repeat(32)}`, network: 'eth' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'UPSTREAM_LIMITED');
  } finally {
    globalThis.fetch = original;
    if (safeKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = safeKey;
    if (etherscanKey === undefined) delete process.env.ETHERSCAN_API_KEY; else process.env.ETHERSCAN_API_KEY = etherscanKey;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
