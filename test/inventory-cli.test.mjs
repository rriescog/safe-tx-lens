import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const preload = resolve('test/support/mock-safe-api.mjs');
const script = resolve('scripts/check-safe-inventory.mjs');
function run(...args) { return spawnSync(process.execPath, ['--import', preload, script, ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SAFE_API_KEY: 'test-only-key' } }); }

test('inventory smoke runner verifies queued and historical Safe hashes without network access', async () => {
  const tx = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'safe-inventory-test-'));
  const path = join(dir, 'inventory.json');
  try {
    await writeFile(path, JSON.stringify({ safes: [{ chain_id: 1, address: tx.safe.toLowerCase(), name: 'Fixture Safe' }] }));
    const result = run(path, '1', 'eth');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pending:hash-pass/);
    assert.match(result.stdout, /history:hash-pass/);
    assert.match(result.stdout, /"passed":2/);
    const old = process.env.TEST_FAIL_PENDING;
    process.env.TEST_FAIL_PENDING = '1';
    try {
      const outage = run(path, '1', 'eth');
      assert.equal(outage.status, 1);
      assert.match(outage.stdout, /pending:ERROR/);
      assert.match(outage.stdout, /"failed":1/);
    } finally { if (old === undefined) delete process.env.TEST_FAIL_PENDING; else process.env.TEST_FAIL_PENDING = old; }
    assert.notEqual(run(path, '2', 'eth').status, 0);
    assert.notEqual(run(path, '1', 'invalid').status, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('inventory runner validates its command line before reading files', () => {
  const result = run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage:/);
  assert.equal(run('/missing.json', '0').status, 2);
  assert.equal(run('/missing.json', '1.5').status, 2);
});

test('inventory runner accepts an array, filters unsupported networks, and prioritizes named Safes', async () => {
  const tx = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
  const dir = await mkdtemp(join(tmpdir(), 'safe-inventory-selection-'));
  const path = join(dir, 'inventory.json');
  try {
    await writeFile(path, JSON.stringify([
      { chain_id: 999999, address: tx.safe, name: 'Unsupported' },
      { chain_id: 1, address: '0x0000000000000000000000000000000000000001', name: 'Other' },
      { chain_id: 1, address: tx.safe, name: 'Protocol Council fixture' },
    ]));
    const result = run(path, '1');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Protocol Council fixture/);
    assert.doesNotMatch(result.stdout, /Other|Unsupported/);
    await writeFile(path, JSON.stringify({ invalid: [] }));
    assert.match(run(path, '1').stderr, /Inventory must be an array/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
