import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';

test('local API accepts an offline plan, rejects cross-origin posts, and limits simulation to one transaction', async () => {
  const incidents = [];
  const server = await serve({ port: 0, incidentReporter: event => incidents.push(event) });
  const url = `http://127.0.0.1:${server.address().port}/api/inspect`;
  const post = (payload, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  try {
    for (const suffix of ['/', '/?', `/?hash=0x${'a'.repeat(64)}`]) {
      const landing = await fetch(`http://127.0.0.1:${server.address().port}${suffix}`);
      assert.equal(landing.status, 200);
      assert.match(await landing.text(), /Safe Tx Lens/);
    }
    const missingPage = await fetch(`http://127.0.0.1:${server.address().port}/missing-page?private-marker`, { headers: { accept: 'text/html' } });
    assert.equal(missingPage.status, 404);
    const errorHtml = await missingPage.text();
    assert.match(errorHtml, /We recorded the issue/);
    assert.match(errorHtml, /Open the inspector/);
    assert.doesNotMatch(errorHtml, /Not found|private-marker/);
    const missingApi = await fetch(`http://127.0.0.1:${server.address().port}/api/missing?private-marker`);
    assert.equal(missingApi.status, 404);
    const errorJson = await missingApi.json();
    assert.equal(errorJson.code, 'ROUTE_UNAVAILABLE');
    assert.match(errorJson.incidentId, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(incidents), /private-marker/);
    assert.equal(incidents.length, 2);
    const coverage = await fetch(`http://127.0.0.1:${server.address().port}/api/network-coverage`);
    assert.equal(coverage.status, 200);
    const snapshot = await coverage.json();
    assert.equal(snapshot.networks.length, 11);
    assert.equal(snapshot.networks.some(row => row.network === 'zkevm'), false);
    assert.equal(snapshot.networks.find(row => row.network === 'kat').pending, 'available');
    assert.equal(snapshot.networks.find(row => row.network === 'xlayer').rpc, 'available');
    assert.doesNotMatch(JSON.stringify(snapshot), /SAFE_API_KEY|safeQuotaRemaining/);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const manifestResponse = await fetch(`${origin}/manifest.webmanifest`);
    assert.equal(manifestResponse.status, 200);
    const manifest = await manifestResponse.json();
    assert.equal(manifest.display, 'standalone');
    assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);
    const worker = await (await fetch(`${origin}/sw.js`)).text();
    assert.match(worker, /event\.request\.mode !== 'navigate'/);
    assert.match(worker, /fetch\(event\.request\)/);
    const offline = await (await fetch(`${origin}/web/offline.html`)).text();
    assert.match(offline, /No transaction report was stored/);
    for (const size of [192, 512]) {
      const icon = await fetch(`${origin}/web/icons/icon-${size}.png`);
      assert.equal(icon.status, 200);
      assert.equal(icon.headers.get('content-type'), 'image/png; charset=utf-8');
      assert.ok((await icon.arrayBuffer()).byteLength > 100);
    }
    const demoResponse = await fetch(`${origin}/api/demo`);
    assert.equal(demoResponse.status, 200);
    const demo = await demoResponse.json();
    assert.equal(demo.evidence.source, 'bundled_example');
    assert.equal(demo.evidence.executionHash, '0x7fa90051644c1dc76f1a8cbf8402ff401781a5a65c5601b40827b7a6193b86a0');
    assert.equal(demo.transaction.nonce, '474');
    assert.equal(demo.calculatedHash, demo.transaction.safeTxHash);
    assert.doesNotMatch(JSON.stringify(demo), /tenderly_monitor|safe_api/);
    for (const name of ['kat', 'xlayer']) {
      const logo = await fetch(`${origin}/web/assets/chains/${name}.svg`);
      assert.equal(logo.status, 200);
      assert.match(await logo.text(), /<svg/);
    }
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
  const incidents = [];
  const server = await serve({ port: 0, rpcUrl: '', incidentReporter: event => incidents.push(event) });
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
    const failure = await response.json();
    assert.equal(failure.code, 'UPSTREAM_LIMITED');
    assert.match(failure.error, /recorded this interruption/);
    assert.equal(incidents[0].incidentId, failure.incidentId);
    assert.doesNotMatch(JSON.stringify(incidents), /0x[0-9a-f]{64}/i);
  } finally {
    globalThis.fetch = original;
    if (safeKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = safeKey;
    if (etherscanKey === undefined) delete process.env.ETHERSCAN_API_KEY; else process.env.ETHERSCAN_API_KEY = etherscanKey;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
