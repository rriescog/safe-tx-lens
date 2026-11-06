import test from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { findIndexedExecution } from '../src/execution-index.mjs';

test('an indexed event must contain the requested Safe hash before it identifies an execution', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = 'test-key';
  const requested = `0x${'11'.repeat(32)}`;
  const other = `0x${'22'.repeat(32)}`;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: '1', result: [{ address: `0x${'33'.repeat(20)}`, transactionHash: `0x${'44'.repeat(32)}`, blockNumber: '0x10', topics: [id('ExecutionSuccess(bytes32,uint256)'), other] }] }), { status: 200 });
  try { assert.equal(await findIndexedExecution(requested, 'eth'), null); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ETHERSCAN_API_KEY;
    else process.env.ETHERSCAN_API_KEY = previousKey;
  }
});

test('a matching indexed Safe event identifies the execution and is cached', async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.ETHERSCAN_API_KEY;
  process.env.ETHERSCAN_API_KEY = 'test-key';
  const requested = `0x${'55'.repeat(32)}`;
  const executionHash = `0x${'66'.repeat(32)}`;
  const safe = `0x${'77'.repeat(20)}`;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++;
    const params = new URL(url).searchParams;
    assert.equal(params.get('topic1'), requested);
    assert.equal(params.get('chainid'), '1');
    return new Response(JSON.stringify({ status: '1', result: [
      { address: safe, transactionHash: executionHash, blockNumber: '0x123', topics: [id('ExecutionSuccess(bytes32,uint256)'), requested] },
    ] }), { status: 200 });
  };
  try {
    const first = await findIndexedExecution(requested, 'eth');
    assert.deepEqual(first, { safe, executionHash, blockNumber: 0x123 });
    assert.deepEqual(await findIndexedExecution(requested, 'eth'), first);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ETHERSCAN_API_KEY;
    else process.env.ETHERSCAN_API_KEY = previousKey;
  }
});

test('event index validates hashes and surfaces upstream outages without making up executions', async () => {
  await assert.rejects(() => findIndexedExecution('0x123', 'eth'), /Invalid Safe transaction hash/);
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.ETHERSCAN_API_KEY;
  try {
    process.env.ETHERSCAN_API_KEY = '';
    assert.equal(await findIndexedExecution(`0x${'aa'.repeat(32)}`, 'eth'), null);
    process.env.ETHERSCAN_API_KEY = 'test-key';
    globalThis.fetch = async () => new Response('unavailable', { status: 503 });
    await assert.rejects(() => findIndexedExecution(`0x${'bb'.repeat(32)}`, 'eth'), /event index 503/);
    globalThis.fetch = async () => new Response(JSON.stringify({ status: '0', message: 'Invalid key', result: 'rate limit' }), { status: 200 });
    await assert.rejects(() => findIndexedExecution(`0x${'cc'.repeat(32)}`, 'eth'), /event index unavailable/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.ETHERSCAN_API_KEY; else process.env.ETHERSCAN_API_KEY = previousKey;
  }
});
