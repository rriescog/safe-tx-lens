import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { decodeCall, enrichCandidateCalls } from '../src/decode.mjs';
import { assessConfidence } from '../src/confidence.mjs';
import { assessRisk } from '../src/risk.mjs';
import { summarizeCalls } from '../src/decode.mjs';

const target = '0x2222222222222222222222222222222222222222';
const iface = new Interface(['function setDelay(uint256 delay)']);
const data = iface.encodeFunctionData('setDelay', [60n]);

test('a unique 4byte candidate decodes arguments but remains explicitly unverified', async () => {
  const call = decodeCall({ to: target, data, value: '0' });
  assert.equal(call.method, null);
  await enrichCandidateCalls(call, { lookup: async () => ['setDelay(uint256)'] });
  assert.equal(call.method, 'setDelay(uint256)');
  assert.equal(call.args[0].value, '60');
  assert.equal(call.decodeBasis, 'selector_candidate');
  assert.equal(call.decodeSource, undefined);
  const confidence = assessConfidence({ call, transaction: {}, checks: [], targetChecks: [] });
  assert.ok(confidence.gaps.some(gap => /Decode every call selector/.test(gap.label)));
  const risk = assessRisk({ call, actions: summarizeCalls(call), findings: [], effects: [], checks: [], transaction: { operation: 0, isExecuted: false } });
  assert.equal(risk.reviewPriority, 'high');
  assert.equal(risk.uncertain, true);
});

test('a candidate whose ABI cannot reproduce calldata does not become a decoded action', async () => {
  const call = decodeCall({ to: target, data, value: '0' });
  await enrichCandidateCalls(call, { lookup: async () => ['setDelay(address)'] });
  assert.equal(call.method, null);
});

test('signature fallback caps distinct upstream lookups for a large call tree', async () => {
  const root = decodeCall({ to: target, data: '0x', value: '0' });
  root.children = Array.from({ length: 20 }, (_, index) => decodeCall({ to: target, data: `0x${(index + 1).toString(16).padStart(8, '0')}`, value: '0' }));
  const lookedUp = [];
  await enrichCandidateCalls(root, { lookup: async selector => { lookedUp.push(selector); return []; } });
  assert.equal(lookedUp.length, 8);
  assert.equal(new Set(lookedUp).size, 8);
});
