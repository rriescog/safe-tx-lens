import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTransaction } from '../src/safe-api.mjs';

test('anonymous lookup falls back from Gateway to Transaction Service', async () => {
  const oldKey = process.env.SAFE_API_KEY;
  const oldFetch = globalThis.fetch;
  process.env.SAFE_API_KEY = '';
  const hash = `0x${'ab'.repeat(32)}`;
  let gatewayCalls = 0;
  let serviceCalls = 0;
  globalThis.fetch = async url => {
    if (String(url).includes('safe-client.safe.global')) { gatewayCalls++; return new Response('outage', { status: 503 }); }
    serviceCalls++;
    return new Response(JSON.stringify({ safeTxHash: hash, safe: '0x1111111111111111111111111111111111111111' }), { status: 200 });
  };
  try {
    const found = await fetchTransaction(hash, 'eth');
    assert.equal(found.lookupSource, 'safe_api');
    assert.equal(gatewayCalls, 1);
    assert.equal(serviceCalls, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldKey === undefined) delete process.env.SAFE_API_KEY; else process.env.SAFE_API_KEY = oldKey;
  }
});
