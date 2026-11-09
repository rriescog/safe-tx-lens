import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, redactPrivateSimulationUrl } from '../src/server.mjs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const origin = 'https://lens.example.org';
const plan = { chainId: '1', meta: {}, transactions: [{ to: '0x1111111111111111111111111111111111111111', value: '0', data: '0x' }] };

test('public reports retain measured effects without disclosing a private Tenderly dashboard URL', () => {
  const result = { simulation: { url: 'https://dashboard.tenderly.co/private/project/simulator/1', success: true }, effects: [{ kind: 'storage', before: '0', after: '1' }] };
  assert.deepEqual(redactPrivateSimulationUrl(result), { simulation: { success: true }, effects: [{ kind: 'storage', before: '0', after: '1' }] });
  const queue = { reports: [{ simulation: { url: 'https://dashboard.tenderly.co/private', success: false } }] };
  assert.deepEqual(redactPrivateSimulationUrl(queue), { reports: [{ simulation: { success: false } }] });
});

test('community web and hosted MCP share the same IP quota while deep review has higher cost', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-server-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), communityDailyUnits: 25, communityMonthlyUnits: 25, communityClientDailyRequests: 2, credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
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
    const secondInspection = await post('/api/inspect', { input: plan, network: 'eth' });
    assert.equal(secondInspection.status, 200);
    const limited = await post('/api/inspect', { input: plan, network: 'eth' });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    const limitedBody = await limited.json();
    assert.match(limitedBody.error, /try again in/i);
    assert.equal(limitedBody.code, 'USAGE_LIMIT');
    const noIdentity = await post('/api/inspect', { input: plan }, { 'x-client-ip': 'spoof' });
    assert.equal(noIdentity.status, 403);
    const otherClient = await post('/api/inspect', { input: plan, network: 'eth' }, { 'x-client-ip': '203.0.113.2' });
    assert.equal(otherClient.status, 200);
    const mcpCall = await post('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: plan, network: 'eth' } } }, { 'x-client-ip': '203.0.113.3' });
    assert.equal(mcpCall.status, 200);
    assert.match(await mcpCall.text(), /"kind".*"builder"|\\"kind\\":\\"builder\\"/);
    const exhausted = await post('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: plan, network: 'eth' } } }, { 'x-client-ip': '203.0.113.4' });
    assert.equal(exhausted.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP discovery still works after the client exhausts its inspection quota', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-mcp-discovery-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), communityDailyUnits: 100, communityMonthlyUnits: 100, communityClientDailyRequests: 1, credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
  const base = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = message => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-client-ip': '203.0.113.44' }, body: JSON.stringify(message) });
  try {
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: plan, network: 'eth' } } };
    assert.equal((await post(call)).status, 200);
    assert.equal((await post(call)).status, 429);
    const initialized = await post({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'quota-test', version: '1.0' } } });
    assert.equal(initialized.status, 200);
    const list = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.equal(list.status, 200);
    assert.match(await list.text(), /"name":"inspect"/);
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
    const unavailableMcpSimulation = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-client-ip': '203.0.113.2' }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'inspect', arguments: { input: `0x${'a'.repeat(64)}`, network: 'eth', simulate: true } } }) });
    assert.equal(unavailableMcpSimulation.status, 503);
    assert.match((await unavailableMcpSimulation.json()).error, /not configured/);
    const invalid = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-ip': '203.0.113.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'inspect_json', arguments: { transaction: {}, network: 'eth' } } }) });
    assert.equal(invalid.status, 200);
    assert.match(await invalid.text(), /isError.*true|"isError":true/);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted MCP simulation is explicit, metered, and hides private Tenderly links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-mcp-sim-'));
  const calls = [];
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), communityDailyUnits: 200, communityMonthlyUnits: 200, communitySimulationClientDaily: 1, credentialReader: async () => ({ SAFE_API_KEY: 'test-key', TENDERLY_ACCESS_KEY: 'test-tenderly-key', TENDERLY_ACCOUNT: 'account', TENDERLY_PROJECT: 'project' }), inspectionResolver: async (_input, _network, options) => {
    calls.push(options);
    return { kind: 'transaction', simulation: { success: true, stateDiffAvailable: true, url: 'https://dashboard.tenderly.co/private/project/simulator/1' }, effects: [{ kind: 'storage', before: '0', after: '1' }] };
  } });
  const base = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = (ip, args) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'x-client-ip': ip }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'inspect', arguments: args } }) });
  const readMcp = async response => {
    const body = await response.text();
    const message = body.startsWith('event:') ? body.split('\n').find(line => line.startsWith('data: '))?.slice(6) : body;
    return JSON.parse(message);
  };
  const args = { input: `0x${'a'.repeat(64)}`, network: 'eth', simulate: true };
  try {
    const response = await post('203.0.113.10', args);
    assert.equal(response.status, 200);
    const data = await readMcp(response);
    assert.equal(data.result.structuredContent.simulation.success, true);
    assert.deepEqual(data.result.structuredContent.effects, [{ kind: 'storage', before: '0', after: '1' }]);
    assert.doesNotMatch(JSON.stringify(data), /dashboard\.tenderly\.co|test-tenderly-key/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].simulate, true);
    assert.equal(calls[0].fetchState, true);
    const repeated = await post('203.0.113.10', args);
    assert.equal(repeated.status, 429);
    assert.equal(calls.length, 1);
    const invalidRpc = await post('203.0.113.11', { ...args, rpcUrl: 'https://attacker.example/rpc' });
    assert.equal(invalidRpc.status, 400);
    assert.match((await invalidRpc.json()).error, /RPC URLs/);
    assert.equal(calls.length, 1);
    const web = await fetch(`http://127.0.0.1:${server.address().port}/api/inspect`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-client-ip': '203.0.113.12' }, body: JSON.stringify({ input: args.input, network: 'eth', simulate: true }) });
    assert.equal(web.status, 200);
    assert.equal((await web.json()).simulation.url, undefined);
    assert.equal(calls[1].simulate, true);
    assert.equal(calls[1].fetchState, true);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted simulation allows three requests per IP each day and rejects the fourth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-three-sim-'));
  const calls = [];
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), communityDailyUnits: 1000, communityMonthlyUnits: 1000, credentialReader: async () => ({ SAFE_API_KEY: 'test-key', TENDERLY_ACCESS_KEY: 'test-tenderly-key', TENDERLY_ACCOUNT: 'account', TENDERLY_PROJECT: 'project' }), inspectionResolver: async (_input, _network, options) => {
    calls.push(options);
    return { kind: 'transaction', simulation: { success: true, stateDiffAvailable: true }, effects: [] };
  } });
  try {
    const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/inspect`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-client-ip': '203.0.113.88' }, body: JSON.stringify({ input: `0x${'a'.repeat(64)}`, network: 'eth', simulate: true }) });
    for (let i = 0; i < 3; i++) assert.equal((await post()).status, 200);
    const fourth = await post();
    assert.equal(fourth.status, 429);
    const exhausted = await fourth.json();
    assert.equal(exhausted.code, 'SIMULATION_LIMIT');
    assert.match(exhausted.error, /3 simulation requests/i);
    assert.ok(Number(fourth.headers.get('retry-after')) > 0);
    assert.equal(calls.length, 3);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a remote MCP client can connect and decode through the public endpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-mcp-client-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`), { requestInit: { headers: { 'x-client-ip': '203.0.113.9' } } }));
    const tools = (await client.listTools()).tools;
    assert.ok(tools.some(tool => tool.name === 'inspect_json'));
    assert.equal(tools.find(tool => tool.name === 'inspect')?.inputSchema?.properties?.simulate?.type, 'boolean');
    assert.equal(tools.find(tool => tool.name === 'inspect')?.inputSchema?.properties?.rpcUrl, undefined);
    const result = await client.callTool({ name: 'inspect_json', arguments: { transaction: plan, network: 'eth' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.kind, 'builder');
    await assert.rejects(client.callTool({ name: 'inspect_json', arguments: { transaction: plan, network: 'eth', rpcUrl: 'http://127.0.0.1:8545' } }), /Caller-supplied RPC URLs/);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('hosted MCP rejects complex or malformed inputs before invoking tools', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-invalid-'));
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }) });
  const base = `http://127.0.0.1:${server.address().port}/mcp`;
  const post = message => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', 'x-client-ip': '203.0.113.19' }, body: JSON.stringify(message) });
  try {
    const deep = JSON.parse(`${'{"next":'.repeat(40)}0${'}'.repeat(40)}`);
    for (const params of [
      { name: 'inspect_json', arguments: { transaction: deep, network: 'eth' } },
      { name: 'inspect', arguments: { input: 'https://evil.test', network: 'eth' } },
      { name: 'inspect', arguments: 'bad' },
      { name: '__proto__', arguments: {} },
    ]) {
      const response = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
      assert.equal(response.status, 400);
    }
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('community HTTP rejects hostile JSON as a client error without recording its payload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-json-'));
  const incidents = [];
  const server = await serve({ port: 0, publicOrigin: origin, communityMode: true, communityQuotaFile: join(directory, 'quota.json'), credentialReader: async () => ({ SAFE_API_KEY: 'test-key' }), incidentReporter: incident => incidents.push(incident) });
  const deep = JSON.parse(`${'{"next":'.repeat(40)}0${'}'.repeat(40)}`);
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/inspect`, { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-client-ip': '203.0.113.41' }, body: JSON.stringify({ input: deep, network: 'eth' }) });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /too complex/);
    assert.deepEqual(incidents, []);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
