import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeMonitorStorage, isMonitorStorage } from '../src/monitor-import.mjs';

const tx = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
const record = {
  prefix: 'eth', safeAddress: tx.safe, txStatus: 'AWAITING_CONFIRMATIONS',
  txData: { to: { value: tx.to }, value: tx.value, hexData: tx.data, operation: tx.operation },
  detailedExecutionInfo: {
    safeTxHash: tx.safeTxHash, nonce: tx.nonce, safeTxGas: tx.safeTxGas,
    baseGas: tx.baseGas, gasPrice: tx.gasPrice, gasToken: tx.gasToken,
    refundReceiver: { value: tx.refundReceiver }, confirmations: [],
  },
};

test('complete monitor records recalculate the Safe hash before trusting its label', async () => {
  const storage = { [`multisig_${tx.safe}_${tx.safeTxHash}`]: record };
  assert.equal(isMonitorStorage(storage), true);
  const result = await analyzeMonitorStorage(storage, 'eth');
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].checks[0].status, 'pass');
  assert.equal(result.reports[0].hash, tx.safeTxHash);
});

test('monitor import rejects malformed storage and never treats incomplete records as verified', async () => {
  await assert.rejects(() => analyzeMonitorStorage({ PENDING_TXN_DATA: '[]' }, 'eth'), /JSON object/);
  await assert.rejects(() => analyzeMonitorStorage({}, 'eth', { safeHash: 'bad' }), /Invalid Safe hash/);
  const incomplete = { [`multisig_${tx.safe}_${tx.safeTxHash}`]: { ...record, txData: { ...record.txData, to: null } } };
  const result = await analyzeMonitorStorage(incomplete, 'eth');
  assert.equal(result.availability, 'unavailable');
  assert.match(result.warnings.join(' '), /cannot be decoded/);
});
