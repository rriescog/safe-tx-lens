import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMonitorStorage, localCredentials, monitorConfig } from '../src/tenderly-storage.mjs';

async function withConfig(values, fetcher, run) {
  const keys = ['TENDERLY_ACCESS_KEY', 'TENDERLY_ACCOUNT', 'TENDERLY_PROJECT', 'TENDERLY_MONITOR_ENV_FILE'];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  for (const key of keys) process.env[key] = values[key] ?? '';
  if (fetcher) globalThis.fetch = fetcher;
  try { return await run(); }
  finally {
    globalThis.fetch = oldFetch;
    for (const key of keys) if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key];
  }
}

test('monitor credentials are optional and invalid account paths are rejected', async () => {
  await withConfig({}, null, async () => {
    assert.equal(await monitorConfig(), null);
    assert.equal(await fetchMonitorStorage(), null);
  });
  await withConfig({ TENDERLY_ACCESS_KEY: 'test', TENDERLY_ACCOUNT: '../bad', TENDERLY_PROJECT: 'project' }, null, async () => {
    await assert.rejects(() => monitorConfig(), /Invalid Tenderly account or project/);
  });
});

test('monitor can read an external local env file without echoing credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'safe-monitor-test-'));
  const path = join(dir, 'monitor.env');
  try {
    await writeFile(path, "TENDERLY_ACCESS_KEY='file-test-token'\nTENDERLY_ACCOUNT=file-account\nTENDERLY_PROJECT=file-project\nIGNORED COMMENT\n");
    await withConfig({ TENDERLY_MONITOR_ENV_FILE: path }, null, async () => {
      const config = await localCredentials();
      assert.equal(config.TENDERLY_ACCOUNT, 'file-account');
      assert.equal((await monitorConfig()).project, 'file-project');
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('monitor storage distinguishes HTTP failure, malformed payload, missing queue, and valid queue', async () => {
  const config = { TENDERLY_ACCESS_KEY: 'test', TENDERLY_ACCOUNT: 'account', TENDERLY_PROJECT: 'project' };
  await withConfig(config, async () => new Response('outage', { status: 503 }), async () => {
    await assert.rejects(() => fetchMonitorStorage(), /storage 503/);
  });
  await withConfig(config, async () => new Response('{}', { status: 200 }), async () => {
    await assert.rejects(() => fetchMonitorStorage(), /Unexpected Tenderly monitor storage response/);
  });
  await withConfig(config, async () => new Response('[]', { status: 200 }), async () => {
    await assert.rejects(() => fetchMonitorStorage(), /no PENDING_TXN_DATA/);
  });
  await withConfig(config, async () => new Response(JSON.stringify([{ key: 'PENDING_TXN_DATA', value: '{}' }]), { status: 200 }), async () => {
    assert.deepEqual(await fetchMonitorStorage(), { PENDING_TXN_DATA: '{}' });
  });
});
