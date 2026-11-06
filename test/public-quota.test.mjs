import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicQuota } from '../src/public-quota.mjs';
import { serve } from '../src/server.mjs';

test('public quota persists across process restarts and resets on the next UTC day', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-lens-quota-'));
  const file = join(directory, 'budget.json');
  let time = Date.parse('2026-11-06T10:00:00Z');
  try {
    const first = publicQuota({ file, dailyLimit: 2, now: () => time });
    assert.equal(first.take().allowed, true);
    assert.equal(first.take().reason, 'busy');
    first.release();
    const restarted = publicQuota({ file, dailyLimit: 2, now: () => time });
    assert.equal(restarted.take().allowed, true);
    restarted.release();
    assert.equal(restarted.take().reason, 'daily_limit');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2026-11-06', used: 2 });
    time = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(restarted.take().allowed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('public server rejects owner keys and enforces origin, explicit network, simulation ban, and quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-lens-server-'));
  const options = { port: 0, publicMode: true, publicOrigin: 'https://lens.example.test', quotaFile: join(directory, 'budget.json'), dailyLimit: 1, credentialReader: async () => ({}) };
  const safe = '0x1111111111111111111111111111111111111111';
  await assert.rejects(() => serve({ ...options, credentialReader: async () => ({ SAFE_API_KEY: 'test' }) }), /refuses owner API credentials/);
  await assert.rejects(() => serve({ ...options, credentialReader: async () => ({ RPC_URL_POL: 'https:\/\/private.example' }) }), /refuses owner API credentials/);
  await assert.rejects(() => serve({ ...options, publicOrigin: 'https://attacker.example@lens.example.test' }), /HTTPS origin/);
  const server = await serve(options);
  const url = `http://127.0.0.1:${server.address().port}/api/inspect`;
  const post = (payload, origin = options.publicOrigin) => fetch(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    assert.equal((await post({ input: safe }, 'https://evil.test')).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input: safe }) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: options.publicOrigin, 'content-type': 'text/plain' }, body: 'test' })).status, 415);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: options.publicOrigin, 'content-type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await post({ input: safe, network: 'auto' })).status, 400);
    assert.equal((await post({ input: safe, simulate: true })).status, 403);
    const plan = { chainId: '1', meta: {}, transactions: [{ to: safe, value: '0', data: '0x' }] };
    assert.equal((await post({ input: plan, network: 'eth' })).status, 200);
    assert.equal((await post({ input: plan, network: 'eth' })).status, 429);
    assert.equal((await fetch(url.replace('/api/inspect', '/healthz'))).status, 200);
    assert.equal((await fetch(url.replace('/api/inspect', '/web/../src/server.mjs'))).status, 404);
    const html = await (await fetch(url.replace('/api/inspect', '/'))).text();
    assert.match(html, /data-public-mode="true"/);
    assert.doesNotMatch(html, /test-only-key/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a corrupt quota state fails closed instead of silently resetting the public budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-lens-quota-corrupt-'));
  const file = join(directory, 'budget.json');
  try {
    await writeFile(file, 'not json');
    assert.throws(() => publicQuota({ file }).take(), /quota state unavailable/);
    assert.throws(() => publicQuota({ file, dailyLimit: 0 }), /Invalid public quota/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
