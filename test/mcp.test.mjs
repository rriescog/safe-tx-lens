import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('MCP exposes read-only tools and inspects an offchain rejection without keys', async () => {
  const client = new Client({ name: 'safe-tx-lens-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/safe-tx-lens-mcp.mjs'] }));
  try {
    const list = await client.listTools();
    assert.deepEqual(list.tools.map(tool => tool.name), ['inspect', 'inspect_json', 'inspect_execution', 'list_pending', 'list_history']);
    assert.ok(list.tools.every(tool => tool.annotations?.readOnlyHint === true));
    assert.match(JSON.stringify(list.tools.find(tool => tool.name === 'inspect_execution')?.inputSchema?.properties?.network), /kat|xlayer/);
    const transaction = JSON.parse(await readFile('examples/safe-pending.json', 'utf8'));
    const result = await client.callTool({ name: 'inspect_json', arguments: { transaction } });
    assert.equal(result.isError, undefined);
    const report = result.structuredContent ?? JSON.parse(result.content[0].text);
    assert.equal(report.checks[0].status, 'pass');
    assert.equal(report.executionStatus, 'execution_not_established');
    assert.ok(report.findings.some(finding => finding.code === 'SAFE_REJECTION'));
    const invalid = await client.callTool({ name: 'inspect_json', arguments: { transaction: { unexpected: true } } });
    assert.equal(invalid.isError, true);
    assert.match(invalid.content[0].text, /valid safe and to addresses/);
  } finally { await client.close(); }
});
