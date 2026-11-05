import test from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';

test('local API accepts an offline plan, rejects cross-origin posts, and limits simulation to one transaction', async () => {
  const server = await serve({ port: 0 });
  const url = `http://127.0.0.1:${server.address().port}/api/inspect`;
  const post = (payload, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  try {
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
