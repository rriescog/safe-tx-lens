import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHAINS } from '../src/chains.mjs';

test('network carousel covers every named chain and never repeats a sample hash', async () => {
  const catalog = JSON.parse(await readFile(new URL('../web/network-examples.json', import.meta.url), 'utf8'));
  const html = await readFile(new URL('../web/index.html', import.meta.url), 'utf8');
  const networks = catalog.networks.map(row => row.network);
  assert.deepEqual(new Set(networks), new Set(Object.keys(CHAINS)));
  const hashes = [];
  for (const row of catalog.networks) {
    assert.match(html, new RegExp(`data-network="${row.network}"`));
    assert.ok(Array.isArray(row.examples));
    for (const sample of row.examples) {
      assert.match(sample.hash, /^0x[0-9a-fA-F]{64}$/);
      assert.match(sample.safe, /^0x[0-9a-fA-F]{40}$/);
      assert.ok(Number.isSafeInteger(sample.nonce) && sample.nonce >= 0);
      assert.ok(sample.label.length > 0);
      assert.ok(sample.kind === undefined || sample.kind === 'execution');
      hashes.push(sample.hash.toLowerCase());
    }
  }
  assert.equal(new Set(hashes).size, hashes.length);
  assert.ok(catalog.networks.find(row => row.network === 'amoy')?.examples.some(sample => sample.kind === 'execution'), 'Amoy should offer a real Safe execution example');
});
