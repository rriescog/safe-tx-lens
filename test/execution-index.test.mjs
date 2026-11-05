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
