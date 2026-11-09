import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Interface, id } from 'ethers';
import { analyze, calculateHash, normalizeTransaction } from '../src/analyze.mjs';

const nested = '0x9d851f8b8751c5FbC09b9E74E6e68E9950949052';
const outer = '0xFa7D2a996aC6350f4b56C043112Da0366a59b74c';
const approve = new Interface(['function approveHash(bytes32 hashToApprove)']);
const hashCall = new Interface(['function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)']);
const outerTx = JSON.parse(await readFile(new URL('../examples/safe-executed.json', import.meta.url), 'utf8'));
const approvedHash = outerTx.safeTxHash;
const executionHash = `0x${'12'.repeat(32)}`;
const nestedTx = { safe: nested, to: outer, value: '0', data: approve.encodeFunctionData('approveHash', [approvedHash]), operation: 0, nonce: 51, safeTxGas: '0', baseGas: '0', gasPrice: '0', transactionHash: executionHash, isExecuted: true, isSuccessful: true };
nestedTx.safeTxHash = calculateHash(normalizeTransaction(nestedTx), 'eth');
const receipt = { status: 1, logs: [{ address: outer, topics: [id('ApproveHash(bytes32,address)'), approvedHash, `0x${nested.slice(2).padStart(64, '0')}`] }] };
const provider = { async getNetwork() { return { chainId: 1n }; }, async call() { return hashCall.encodeFunctionResult('getTransactionHash', [approvedHash]); }, async getTransactionReceipt() { return receipt; } };

test('nested Safe approval links the approved hash to recomputed outer Safe fields and an onchain event', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => ({ ...outerTx, lookupSource: 'safe_api' }), approvalProvider: provider });
  assert.equal(report.call.method, 'approveHash(bytes32)');
  assert.equal(report.approvals[0].approvedHash, approvedHash);
  assert.equal(report.approvals[0].status, 'rpc_matched');
  assert.equal(report.approvals[0].transaction.nonce, '242');
  assert.equal(report.approvals[0].onchainApproval, 'observed');
  assert.equal(report.approvals[0].transaction.hash, approvedHash);
  assert.equal(report.call.approval.status, 'rpc_matched');
  assert.equal(report.status, 'REVIEW');
});

test('an altered outer transaction never passes the nested approval comparison', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => ({ ...outerTx, nonce: 243 }), approvalProvider: provider });
  assert.equal(report.approvals[0].status, 'mismatch');
  assert.equal(report.status, 'BLOCK');
});

test('a hash belonging to a different Safe is rejected even when its local hash is valid', async () => {
  const other = { ...outerTx, safe: nested };
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => other });
  assert.equal(report.approvals[0].status, 'mismatch');
});

test('unavailable proposal source does not imply the approved hash is safe', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => { throw new Error('Safe API 429'); } });
  assert.equal(report.approvals[0].status, 'unavailable');
  assert.equal(report.approvals[0].onchainApproval, 'unavailable');
});

test('a pending nested proposal is never shown as an onchain approval', async () => {
  const report = await analyze({ ...nestedTx, isExecuted: false, transactionHash: null }, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => outerTx });
  assert.equal(report.approvals[0].status, 'matched_fields');
  assert.equal(report.approvals[0].onchainApproval, 'pending');
});

test('a successful receipt without the exact ApproveHash event is not proof of approval', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => outerTx, approvalProvider: { ...provider, async getTransactionReceipt() { return { status: 1, logs: [] }; } } });
  assert.equal(report.approvals[0].onchainApproval, 'not_observed');
});

test('queue previews name the approved hash without spending an extra proposal lookup', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, verifyTargets: false, approvalLookup: async () => { throw new Error('lookup should not run'); } });
  assert.equal(report.approvals[0].status, 'not_checked');
  assert.equal(report.actions[0].label, `Approve Safe hash ${approvedHash}`);
});

test('a wrong-chain RPC cannot promote a service-only hash match to verified', async () => {
  const report = await analyze(nestedTx, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => outerTx, approvalProvider: { ...provider, async getNetwork() { return { chainId: 137n }; } } });
  assert.equal(report.approvals[0].status, 'matched_fields');
  assert.equal(report.approvals[0].rpc.status, 'unavailable');
  assert.equal(report.approvals[0].onchainApproval, 'unavailable');
});

test('at most four approved hashes trigger proposal lookups in one report', async () => {
  const pack = () => `00${outer.slice(2)}${'0'.repeat(64)}${(36).toString(16).padStart(64, '0')}${approve.encodeFunctionData('approveHash', [approvedHash]).slice(2)}`;
  const batch = new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [`0x${pack().repeat(5)}`]);
  let lookups = 0;
  const report = await analyze({ ...nestedTx, to: '0x9641d764fc13c8B624c04430C7356C1C7C8102e2', data: batch, operation: 1, transactionHash: null, isExecuted: false, safeTxHash: null }, 'eth', { fetchState: false, inspectApprovedHashes: true, approvalLookup: async () => { lookups++; return outerTx; } });
  assert.equal(report.approvals.length, 5);
  assert.equal(lookups, 4);
  assert.equal(report.approvals[4].status, 'limit_reached');
});
