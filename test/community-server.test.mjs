import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '../src/server.mjs';

const origin = 'https://lens.example.org';
const plan = { chainId: '1', meta: {}, transactions: [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x' }] };

test('community web and hosted MCP share the same IP and global quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-server-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), communityDailyUnits: 4, communityMonthlyUnits: 4, communityClientDailyRequests: 2, credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, data, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-client-ip': '203.0.113.1', ...headers }, body: JSON.stringify(data) });
  try {
    const html = await (await fetch(base)).text();
    assert.match(html, /data-community-mode="true"/);
    assert.doesNotMatch(html, /test-key|127\.0\.0\.1|every 30 seconds/i);
    const first = await post('/api/inspect', { input: plan, network: 'eth' });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).kind, 'builder');
    const second = await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    assert.equal(second.status, 200);
    const data = await second.text();
    assert.match(data, /"name":"inspect"/);
    const limited = await post('/api/inspect', { input: plan, network: 'eth' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.match((await limited.json()).error, /try again in/i);
    const noIdentity = await post('/api/inspect', { input: plan }, { 'x-client-ip': 'spoof' });
    assert.equal(noIdentity.status, 403);
    const otherClient = await post('/api/inspect', { input: plan, network: 'eth' }, { 'x-client-ip': '203.0.113.2' });
    assert.equal(otherClient.status, 200);
    const mcpCall = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: plan, network: 'eth' } } }, { 'x-client-ip': '203.0.113.3' });
    assert.equal(mcpCall.status, 200);
    assert.match(await mcpCall.text(), /"kind".*"builder"|\\"kind\\":\\"builder\\"/);
    const exhausted = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, { 'x-client-ip': '203.0.113.4' });
    assert.equal(exhausted.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('community server needs a Safe key and keeps simulation opt-in', async () => {
  await assert.rejects(serve({ port: 0, publicOrigin: origin, communityMode: true, credentialReader: async () => ({}) }), /dedicated Safe API key/);
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-sim-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/inspect`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-client-ip': '203.0.113.1' }, body: JSON.stringify({ input: plan, network: 'eth', simulate: true }) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/);
    const invalid = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-ip': '203.0.113.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: {}, network: 'eth' } } }) });
    assert.equal(invalid.status, 200);
    assert.match(await invalid.text(), /isError.*true|"isError":true/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
