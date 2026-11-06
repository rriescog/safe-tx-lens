import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import { calculateHash, normalizeTransaction } from '../src/analyze.mjs';
import { analyzeExecutionHash, fetchRecentExecutions, findRecentExecutionBySafeHash } from '../src/onchain.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const ZERO = '0x0000000000000000000000000000000000000000';
const EXECUTION_HASH = `0x${'33'.repeat(32)}`;
const EXEC = new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)']);
const STATE = new Interface(['function nonce() view returns (uint256)']);
const transaction = { safe: SAFE, to: TARGET, value: '0', data: '0x', operation: 0, nonce: 4, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO };
const safeHash = calculateHash(normalizeTransaction(transaction), 'eth');
const outer = { from: TARGET, to: SAFE, data: EXEC.encodeFunctionData('execTransaction', [TARGET, 0, '0x', 0, 0, 0, 0, ZERO, ZERO, '0x']) };
const log = { address: SAFE, transactionHash: EXECUTION_HASH, topics: [id('ExecutionSuccess(bytes32,uint256)'), safeHash], data: '0x' };
const receipt = { blockNumber: 500, logs: [log] };

function provider(overrides = {}) {
  return {
    getNetwork: async () => ({ chainId: 1n }),
    getTransaction: async () => outer,
    getTransactionReceipt: async () => receipt,
    call: async () => STATE.encodeFunctionResult('nonce', [4]),
    getBlock: async () => ({ timestamp: 1_700_000_000 }),
    getBlockNumber: async () => 500,
    getLogs: async filter => {
      assert.equal(filter.address, SAFE);
      return [log];
    },
    ...overrides,
  };
}

test('onchain execution reconstructs calldata and nonce before accepting a Safe hash', async () => {
  const options = { provider: provider(), rpcUrl: '', fetchState: false };
  const report = await analyzeExecutionHash(EXECUTION_HASH, 'eth', options);
  assert.equal(report.hash, safeHash);
  assert.equal(report.transaction.nonce, '4');
  assert.equal(report.transaction.safe, SAFE);
  assert.equal(report.transaction.executor, TARGET);
  assert.equal(report.evidence.source, 'onchain_execution');
  assert.equal(report.evidence.blockNumber, 500);
  assert.equal(report.checks[0].status, 'pass');

  const found = await findRecentExecutionBySafeHash(SAFE, safeHash, 'eth', options);
  assert.equal(found.hash, safeHash);
  const recent = await fetchRecentExecutions(SAFE, 'eth', { ...options, limit: 1 });
  assert.equal(recent.reports.length, 1);
  assert.equal(recent.reports[0].evidence.executionHash, EXECUTION_HASH);
});

test('onchain reconstruction rejects the wrong chain, missing Safe event, and unmatchable nonce', async () => {
  const base = { rpcUrl: '', fetchState: false };
  await assert.rejects(() => analyzeExecutionHash(EXECUTION_HASH, 'eth', { ...base, provider: provider({ getNetwork: async () => ({ chainId: 100n }) }) }), /RPC chain/);
  await assert.rejects(() => analyzeExecutionHash(EXECUTION_HASH, 'eth', { ...base, provider: provider({ getTransactionReceipt: async () => ({ blockNumber: 500, logs: [] }) }) }), /Safe execution event/);
  const wrongLog = { ...log, topics: [log.topics[0], `0x${'ff'.repeat(32)}`] };
  await assert.rejects(() => analyzeExecutionHash(EXECUTION_HASH, 'eth', { ...base, provider: provider({ getTransactionReceipt: async () => ({ blockNumber: 500, logs: [wrongLog] }) }) }), /Could not recover Safe nonce/);
});

test('onchain reconstruction can recover the nonce when archive RPC state is unavailable', async () => {
  const calls = [];
  const rpc = provider({
    call: async request => {
      calls.push(request.blockTag ?? 'latest');
      if (request.blockTag !== undefined) throw new Error('archive state unavailable');
      return STATE.encodeFunctionResult('nonce', [6]);
    },
    getBlock: async () => null,
  });
  const report = await analyzeExecutionHash(EXECUTION_HASH, 'eth', { provider: rpc, rpcUrl: '', fetchState: false });
  assert.equal(report.transaction.nonce, '4');
  assert.equal(report.evidence.blockTime, null);
  assert.deepEqual(calls.slice(0, 2), [499, 'latest']);
});
