import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { readFile } from 'node:fs/promises';
import { analyze, calculateHash, classifyEffects } from '../src/analyze.mjs';
import { decodeCall, unpackMultiSend } from '../src/decode.mjs';
import { parseInput } from '../src/inputs.mjs';
import { analyzeBuilderExport, compareCalls } from '../src/builder.mjs';
import { gatewayTransaction } from '../src/safe-api.mjs';
import { resolve } from '../src/resolve.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const tx = { safe: SAFE, to: TARGET, value: '0', data: '0x', operation: 0, nonce: 4, safeTxGas: '0', baseGas: '0', gasPrice: '0' };

test('an offline transaction reports its computed hash without claiming remote verification', async () => {
  const report = await analyze(tx, 'eth', { fetchState: false });
  assert.match(report.calculatedHash, /^0x[0-9a-f]{64}$/);
  assert.equal(report.checks[0].status, 'unverified');
  assert.equal(report.checks[0].method, 'local_eip712');
  assert.equal(report.simulation, null);
});

test('a mismatched supplied hash blocks signing', async () => {
  const report = await analyze({ ...tx, safeTxHash: `0x${'00'.repeat(32)}` }, 'eth', { fetchState: false });
  assert.equal(report.status, 'BLOCK');
  assert.equal(report.checks[0].status, 'fail');
});

test('delegatecall is critical even when calldata looks benign', async () => {
  const iface = new Interface(['function transfer(address,uint256)']);
  const report = await analyze({ ...tx, operation: 1, data: iface.encodeFunctionData('transfer', [SAFE, 1]) }, 'eth', { fetchState: false });
  assert.equal(report.status, 'REVIEW');
  assert.ok(report.findings.some(f => f.code === 'DELEGATECALL'));
  assert.equal(report.risk.reviewPriority, 'critical');
});

test('Safe singleton storage change is classified by effect', () => {
  const effects = classifyEffects({ storageDiffs: [{ address: SAFE, label: `0x${'0'.repeat(64)}`, from: '0x01', to: '0x02' }] }, SAFE);
  assert.equal(effects[0].kind, 'safe_singleton');
  assert.equal(effects[0].severity, 'critical');
});

test('simulated asset movement is classified separately from function names', () => {
  const effects = classifyEffects({ assetChanges: [{ type: 'ERC20', token: TARGET, from: SAFE, to: TARGET, amount: '100' }] }, SAFE);
  assert.equal(effects[0].kind, 'asset_transfer');
  assert.equal(effects[0].amount, '100');
});

test('MultiSend rejects truncated records and exposes nested calls', () => {
  assert.throws(() => unpackMultiSend('0x01'), /Truncated/);
  const child = `00${TARGET.slice(2)}${'0'.repeat(64)}${'0'.repeat(64)}`;
  const iface = new Interface(['function multiSend(bytes)']);
  const decoded = decodeCall({ to: TARGET, value: '0', operation: 1, data: iface.encodeFunctionData('multiSend', [`0x${child}`]) });
  assert.equal(decoded.children.length, 1);
  assert.equal(decoded.children[0].to, TARGET);
});

test('Safe URL parser uses the embedded network and hash', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const parsed = parseInput(`https://app.safe.global/transactions/tx?safe=pol:${SAFE}&id=multisig_${SAFE}_${hash}`, 'eth');
  assert.equal(parsed.network, 'pol');
  assert.equal(parsed.hash, hash);
  assert.throws(() => parseInput(`https://evil.example/?safe=eth:${SAFE}`), /Only app.safe.global/);
});

test('public PoS Council examples reproduce their Safe transaction hashes', async () => {
  for (const path of ['examples/2026-11-05-pos-council-nonce-242-executed.json', 'examples/2026-11-05-pos-council-nonce-243-rejection.json']) {
    const transaction = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(calculateHash(transaction, 'eth').toLowerCase(), transaction.safeTxHash.toLowerCase());
  }
});

test('PoS Council nested governance calls expose the actual action and its risk', async () => {
  const transaction = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-242-executed.json', 'utf8'));
  const report = await analyze(transaction, 'eth', { fetchState: false });
  assert.deepEqual(report.actions.map(action => action.stage), ['schedule', 'call']);
  assert.deepEqual(report.actions.map(action => action.method), ['forceUnstake(uint256)', 'forceUnstake(uint256)']);
  assert.ok(report.actions.every(action => action.label === 'Force unstake validator #106'));
  assert.equal(report.call.children[0].children[0].method, 'update(address,bytes)');
  assert.equal(report.call.children[0].children[0].children[0].method, 'forceUnstake(uint256)');
  assert.equal(report.risk.impactLevel, 'high');
  assert.equal(report.risk.reviewPriority, 'high');
  assert.ok(report.risk.reasons.some(reason => /MultiSend uses delegatecall/.test(reason.message)));
});

test('a nonce-only Safe rejection has medium review priority', async () => {
  const transaction = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
  const report = await analyze(transaction, 'eth', { fetchState: false });
  assert.equal(report.actions[0].label, 'Empty call / Safe nonce consumption');
  assert.equal(report.risk.reviewPriority, 'medium');
});

test('Builder exports decode without a Safe nonce and compare exact calls when a Safe transaction is available', async () => {
  const transaction = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-242-executed.json', 'utf8'));
  const actual = await analyze(transaction, 'eth', { fetchState: false });
  const transactions = actual.call.children.map(({ to, value, data, operation }) => ({ to, value, data, operation }));
  const builder = { version: '1.0', chainId: '1', meta: { createdFromSafeAddress: transaction.safe }, transactions };
  const preview = await analyzeBuilderExport(builder, 'eth');
  assert.equal(preview.kind, 'builder');
  assert.equal(preview.comparison.status, 'not_requested');
  assert.ok(preview.actions.some(action => action.label === 'Force unstake validator #106'));
  assert.equal(compareCalls(transactions, actual).status, 'match');
  assert.equal(compareCalls([{ ...transactions[0], value: '1' }, transactions[1]], actual).status, 'mismatch');
});

test('Builder timelock batches reveal proxy upgrades and validator reinitialization', async () => {
  const timelock = new Interface(['function scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)']);
  const proxy = new Interface(['function updateImplementation(address)']);
  const governance = new Interface(['function update(address,bytes)']);
  const validator = new Interface(['function reinitializeValidatorState(uint256)']);
  const zero = `0x${'0'.repeat(64)}`;
  const data = timelock.encodeFunctionData('scheduleBatch', [[TARGET, SAFE], [0, 0], [proxy.encodeFunctionData('updateImplementation', [SAFE]), governance.encodeFunctionData('update', [TARGET, validator.encodeFunctionData('reinitializeValidatorState', [123])])], zero, zero, 0]);
  const builder = { chainId: '1', meta: { createdFromSafeAddress: SAFE }, transactions: [{ to: TARGET, value: '0', data }] };
  const preview = await analyzeBuilderExport(builder, 'eth');
  assert.deepEqual(preview.actions.map(action => action.method), ['updateImplementation(address)', 'reinitializeValidatorState(uint256)']);
  assert.ok(preview.actions.every(action => action.stage === 'schedule'));
  assert.equal(preview.risk.reviewPriority, 'critical');
});

test('Gateway transaction mapping preserves every field used by the Safe hash', async () => {
  const original = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-242-executed.json', 'utf8'));
  const gateway = { safeAddress: original.safe, txHash: original.transactionHash, txStatus: 'SUCCESS', executedAt: 1,
    txData: { to: { value: original.to }, value: original.value, hexData: original.data, operation: original.operation },
    detailedExecutionInfo: { safeTxHash: original.safeTxHash, nonce: original.nonce, safeTxGas: original.safeTxGas, baseGas: original.baseGas, gasPrice: original.gasPrice, gasToken: original.gasToken, refundReceiver: { value: original.refundReceiver }, confirmations: [] } };
  const mapped = gatewayTransaction(gateway);
  const report = await analyze(mapped, 'eth', { fetchState: false });
  assert.equal(report.checks[0].status, 'pass');
  assert.throws(() => gatewayTransaction({ ...gateway, detailedExecutionInfo: { ...gateway.detailedExecutionInfo, baseGas: undefined } }), /lacks fields/);
});

test('Tenderly monitor storage decodes offchain payloads without claiming an unverified Safe hash', async () => {
  const original = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-242-executed.json', 'utf8'));
  const id = `multisig_${original.safe}_${original.safeTxHash}`;
  const stored = { [id]: { prefix: 'eth', safeAddress: original.safe, txStatus: 'AWAITING_CONFIRMATIONS', txData: { to: { value: original.to }, value: original.value, hexData: original.data, operation: original.operation }, detailedExecutionInfo: { safeTxHash: original.safeTxHash, nonce: original.nonce, confirmations: [] } } };
  const queue = await resolve(stored, 'eth', { safeAddress: original.safe });
  assert.equal(queue.source, 'tenderly_storage');
  assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].actions[0].label, 'Force unstake validator #106');
  assert.equal(queue.reports[0].checks[0].status, 'unverified');
  assert.equal(queue.reports[0].calculatedHash, null);
  const wrapped = await resolve({ PENDING_TXN_DATA: JSON.stringify(stored) }, 'eth', { safeHash: original.safeTxHash });
  assert.equal(wrapped.reports.length, 1);
  const missing = await resolve(stored, 'eth', { safeHash: `0x${'00'.repeat(32)}` });
  assert.equal(missing.reports.length, 0);
  assert.match(missing.warnings[0], /not found/);
});
