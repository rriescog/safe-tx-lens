import test from 'node:test';
import assert from 'node:assert/strict';
import { assessRisk } from '../src/risk.mjs';

const transaction = { operation: 0, isExecuted: false };
const call = { method: null, children: [] };
function rate(method, selector = '0x12345678', extra = {}) {
  return assessRisk({ call, actions: [{ method, selector, stage: 'call', label: method ?? 'unknown', to: '0x1' }], findings: [], effects: [], checks: [], simulation: null, transaction, ...extra });
}

test('risk levels distinguish upgrades, authority, validator changes, approvals, transfers and unknown calls', () => {
  for (const method of ['upgradeTo', 'addOwnerWithThreshold', 'reinitializeValidatorState']) assert.equal(rate(`${method}(uint256)`).reviewPriority, 'critical');
  for (const method of ['forceUnstake', 'approve', 'transfer', 'cleanMapToken']) assert.equal(rate(`${method}(uint256)`).reviewPriority, 'high');
  assert.equal(rate(null).reviewPriority, 'high');
  assert.equal(rate(null, '0x').reviewPriority, 'medium');
  assert.equal(rate('custom()').reviewPriority, 'medium');
  assert.equal(rate(null).uncertain, true);
  assert.equal(rate(null, '0x').uncertain, false);
  const scheduled = assessRisk({ call, actions: [{ method: 'custom()', selector: '0x12345678', stage: 'schedule', label: 'custom', to: '0x1' }], findings: [], effects: [], checks: [], simulation: null, transaction });
  assert.match(scheduled.reasons[0].message, /^Scheduled:/);
});

test('risk escalates independently for hash failures, changed code, permissions and observed effects', () => {
  const findings = ['GAS_REFUND', 'EXECUTION_MISMATCH', 'TARGET_CODE_MISMATCH', 'TARGET_ABI_MISMATCH', 'TARGET_NO_CODE', 'SAFE_REJECTION'];
  const levels = ['high', 'critical', 'critical', 'high', 'high', 'medium'];
  for (const [index, code] of findings.entries()) {
    const result = rate('noop()', '0x12345678', { findings: [{ code }] });
    assert.equal(result.reviewPriority, levels[index], code);
  }
  assert.equal(rate('noop()', '0x12345678', { checks: [{ status: 'fail' }] }).reviewPriority, 'critical');
  assert.equal(rate('noop()', '0x12345678', { effects: [{ severity: 'critical', kind: 'storage' }] }).reviewPriority, 'critical');
  assert.equal(rate('noop()', '0x12345678', { effects: [{ severity: 'warning', kind: 'asset_transfer' }] }).reviewPriority, 'high');
});

test('decoded MultiSend lowers generic delegatecall alert but retains action risk', () => {
  const findings = [{ code: 'DELEGATECALL' }];
  const batch = rate('noop()', '0x12345678', { findings, transaction: { ...transaction, operation: 1 }, call: { method: 'multiSend(bytes)', children: [{}] } });
  assert.equal(batch.reviewPriority, 'medium');
  const opaque = rate('noop()', '0x12345678', { findings, transaction: { ...transaction, operation: 1 }, call: { method: 'multiSend(bytes)', children: [], decodeError: 'bad' } });
  assert.equal(opaque.reviewPriority, 'critical');
  assert.equal(rate('noop()', '0x12345678', { transaction: { ...transaction, isExecuted: true } }).basis, 'onchain execution and decoded calldata');
  assert.equal(rate('noop()', '0x12345678', { simulation: { success: true } }).basis, 'decoded calldata and simulated effects');
});
