import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { decodeCall, enrichCandidateCalls, lookupSelectorCandidates } from '../src/decode.mjs';
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
  assert.ok(confidence.gaps.some(gap => gap.kind === 'decode' && /Match each decoded selector/.test(gap.label)));
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

test('4byte.directory backs up an empty Sourcify lookup without claiming verification', async () => {
  const abi = new Interface(['function rotateCouncilVault(address vault,uint256 epoch)']);
  const calldata = abi.encodeFunctionData('rotateCouncilVault', [target, 9]);
  const selector = calldata.slice(0, 10).toLowerCase();
  const urls = [];
  const request = async url => {
    urls.push(String(url));
    return String(url).includes('sourcify.dev')
      ? new Response(JSON.stringify({ result: { function: { [selector]: [] } } }))
      : new Response(JSON.stringify({ count: 1, results: [{ hex_signature: selector, text_signature: 'rotateCouncilVault(address,uint256)' }] }));
  };
  const result = await lookupSelectorCandidates(selector, { request });
  assert.deepEqual(result, { names: ['rotateCouncilVault(address,uint256)'], source: '4byte.directory' });
  assert.equal(urls.length, 2);
  const call = decodeCall({ to: target, data: calldata, value: '0' });
  await enrichCandidateCalls(call, { lookup: async () => result });
  assert.equal(call.method, 'rotateCouncilVault(address,uint256)');
  assert.equal(call.decodeBasis, 'selector_candidate');
  assert.equal(call.decodeCandidateSource, '4byte.directory');
  assert.equal(call.args[1].value, '9');
});

test('a Sourcify result avoids an extra 4byte.directory request', async () => {
  const selector = '0x1234abce';
  const urls = [];
  const request = async url => {
    urls.push(String(url));
    return new Response(JSON.stringify({ result: { function: { [selector]: [{ name: 'foo(uint256)', filtered: false }] } } }));
  };
  assert.deepEqual(await lookupSelectorCandidates(selector, { request }), { names: ['foo(uint256)'], source: 'Sourcify 4byte' });
  assert.equal(urls.length, 1);
});

test('incomplete 4byte.directory pages cannot produce a falsely unique candidate', async () => {
  const selector = '0x1234abcd';
  const request = async url => String(url).includes('sourcify.dev')
    ? new Response('', { status: 503 })
    : new Response(JSON.stringify({ count: 2, next: 'page=2', results: [{ hex_signature: selector, text_signature: 'foo(uint256)' }] }));
  assert.deepEqual(await lookupSelectorCandidates(selector, { request }), { names: [], source: null });
});
