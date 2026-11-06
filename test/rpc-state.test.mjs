import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Interface } from 'ethers';
import { analyze, calculateHash, normalizeTransaction } from '../src/analyze.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const tx = { safe: SAFE, to: TARGET, data: '0x', value: '0', operation: 0, nonce: '7' };
const hash = calculateHash(normalizeTransaction(tx), 'eth');
const hashInterface = new Interface(['function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)']);
const stateInterface = new Interface(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function nonce() view returns (uint256)']);

async function withRpc(run, overrides = {}) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const reply = item => {
      requests.push(item);
      if (overrides.failArchive && item.method === 'eth_call' && item.params[1] !== 'latest') return { jsonrpc: '2.0', id: item.id, error: { code: -32000, message: 'archive state unavailable' } };
      let result = '0x';
      if (item.method === 'eth_chainId') result = overrides.chainId ?? '0x1';
      else if (item.method === 'eth_getTransactionReceipt') result = null;
      else if (item.method === 'eth_call') {
        const selector = item.params[0].data.slice(0, 10);
        if (selector === hashInterface.getFunction('getTransactionHash').selector) result = hashInterface.encodeFunctionResult('getTransactionHash', [hash]);
        else if (selector === stateInterface.getFunction('getOwners').selector) result = stateInterface.encodeFunctionResult('getOwners', [[SAFE]]);
        else if (selector === stateInterface.getFunction('getThreshold').selector) result = stateInterface.encodeFunctionResult('getThreshold', [1]);
        else if (selector === stateInterface.getFunction('nonce').selector) result = stateInterface.encodeFunctionResult('nonce', [7]);
      }
      return { jsonrpc: '2.0', id: item.id, result };
    };
    const parsed = JSON.parse(body);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(reply) : reply(parsed)));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await run(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('independent local RPC recalculates the onchain hash and supplies Safe state after API outage', async () => withRpc(async (rpcUrl, requests) => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('api.safe.global') ? new Response('unavailable', { status: 503 }) : original(url, options);
  try {
    const report = await analyze(tx, 'eth', { rpcUrl, verifyTargets: false });
    assert.equal(report.checks[0].status, 'unverified');
    assert.equal(report.checks[1].status, 'pass');
    assert.equal(report.safeState.source, 'rpc');
    assert.deepEqual(report.safeState.owners, [SAFE]);
    assert.ok(requests.filter(request => request.method === 'eth_call').length >= 4);
  } finally { globalThis.fetch = original; }
}));

test('Safe state from an RPC on the wrong chain is rejected', async () => withRpc(async rpcUrl => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('api.safe.global') ? new Response('unavailable', { status: 503 }) : original(url, options);
  try {
    const report = await analyze(tx, 'eth', { rpcUrl, verifyTargets: false });
    assert.equal(report.checks[1].status, 'fail');
    assert.equal(report.safeState, null);
    assert.match(report.warnings.join(' '), /RPC chain does not match/);
  } finally { globalThis.fetch = original; }
}, { chainId: '0x89' }));

test('executed Safe state falls back to current RPC state when archive storage is unavailable', async () => withRpc(async rpcUrl => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('api.safe.global') ? new Response('unavailable', { status: 503 }) : original(url, options);
  try {
    const report = await analyze({ ...tx, isExecuted: true, blockNumber: 500, transactionHash: `0x${'aa'.repeat(32)}` }, 'eth', { rpcUrl, verifyTargets: false });
    assert.equal(report.safeState.source, 'rpc_current_fallback');
    assert.match(report.warnings.join(' '), /historical owners and threshold were not independently recovered/);
  } finally { globalThis.fetch = original; }
}, { failArchive: true }));

test('historical simulation refuses to invent a preceding block without receipt or block number', async () => withRpc(async rpcUrl => {
  const report = await analyze({ ...tx, isExecuted: true, executor: TARGET, transactionHash: `0x${'aa'.repeat(32)}`, signatures: `0x${'11'.repeat(65)}` }, 'eth', {
    rpcUrl, verifyTargets: false, simulate: true, safeInfo: { nonce: '7', threshold: 1, owners: [SAFE], source: 'safe_api' },
  });
  assert.match(report.simulation.unavailable, /Historical execution receipt unavailable/);
}));
