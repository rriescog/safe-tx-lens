import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, concat, getAddress, keccak256 } from 'ethers';
import { analyze, calculateHashComponents, normalizeTransaction } from '../src/analyze.mjs';
import { decodeCall, unpackMultiSend } from '../src/decode.mjs';
import { parseInput } from '../src/inputs.mjs';
import { analyzeBuilderExport, compareCalls } from '../src/builder.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const OTHER = '0x3333333333333333333333333333333333333333';
const transaction = { safe: SAFE, to: TARGET, value: '0', data: '0x', operation: 0, nonce: 7, safeTxGas: '0', baseGas: '0', gasPrice: '0' };

function packedCall({ operation = 0, to = TARGET, value = 0n, data = '0x' } = {}) {
  return `0x${operation.toString(16).padStart(2, '0')}${to.slice(2)}${value.toString(16).padStart(64, '0')}${((data.length - 2) / 2).toString(16).padStart(64, '0')}${data.slice(2)}`;
}

test('domain and message hashes recombine to the final Safe EIP-712 hash', async () => {
  const report = await analyze(transaction, 'eth', { fetchState: false });
  const { domainHash, messageHash } = calculateHashComponents(normalizeTransaction(transaction), 'eth');
  assert.equal(keccak256(concat(['0x1901', domainHash, messageHash])), report.calculatedHash);
  assert.deepEqual(report.hashComponents, { domainHash, messageHash });
  const otherNetwork = await analyze(transaction, 'gno', { fetchState: false });
  assert.notEqual(otherNetwork.calculatedHash, report.calculatedHash);
});

test('invalid Safe fields fail before decoding or simulation', () => {
  const invalid = [
    [{ ...transaction, safe: '0x123' }, /valid safe/],
    [{ ...transaction, data: '0xabc' }, /calldata/],
    [{ ...transaction, data: '0xzz' }, /calldata/],
    [{ ...transaction, operation: 2 }, /operation/],
    [{ ...transaction, nonce: -1 }, /nonce/],
    [{ ...transaction, gasToken: '0x123' }, /address/],
  ];
  for (const [value, error] of invalid) assert.throws(() => normalizeTransaction(value), error);
});

test('Safe URL parsing rejects a mismatched origin, malformed Safe, and unknown chain', () => {
  const valid = parseInput(`https://app.safe.global/home?safe=eth:${SAFE}`, 'auto');
  assert.deepEqual({ kind: valid.kind, network: valid.network, address: valid.address }, { kind: 'safe', network: 'eth', address: SAFE });
  for (const input of [
    `https://app.safe.global.evil.example/home?safe=eth:${SAFE}`,
    `https://app.safe.global/home?safe=eth:0x123`,
    `https://app.safe.global/home?safe=unknown:${SAFE}`,
    '0x123',
  ]) assert.throws(() => parseInput(input, 'auto'));
  assert.throws(() => parseInput(null, 'auto'), /Input must be/);
  assert.deepEqual(parseInput(' {"nonce":7} ', 'eth').transaction, { nonce: 7 });
  assert.throws(() => parseInput('{broken', 'eth'), /JSON/);
  assert.equal(parseInput(`https://app.safe.global/transactions/tx?safe=eth:${SAFE}&id=malformed`, 'auto').kind, 'safe');
  const lowercaseSafe = '0xc74efc7fdb3bec9c6930e91ffdf761b160df79db';
  assert.equal(parseInput(lowercaseSafe, 'auto').address, getAddress(lowercaseSafe));
  assert.equal(parseInput(`https://app.safe.global/home?safe=eth:${lowercaseSafe}`, 'auto').address, getAddress(lowercaseSafe));
});

test('MultiSend accepts exact packed boundaries and rejects malformed records', () => {
  const first = packedCall({ value: 5n, data: '0x1234' });
  const second = packedCall({ operation: 1, to: OTHER });
  assert.deepEqual(unpackMultiSend(`0x${first.slice(2)}${second.slice(2)}`).map(call => [call.operation, call.to, call.value, call.data]), [
    [0, TARGET, '5', '0x1234'], [1, OTHER, '0', '0x'],
  ]);
  assert.throws(() => unpackMultiSend('0x0'), /hex/);
  assert.throws(() => unpackMultiSend('0xzz'), /hex/);
  assert.throws(() => unpackMultiSend(packedCall({ operation: 2 })), /operation/);
  assert.throws(() => unpackMultiSend(first.slice(0, -2)), /length/);
  assert.throws(() => unpackMultiSend(`0x${packedCall().slice(2).repeat(101)}`), /over 100 calls/);
});

test('nested decoding stops at its depth boundary', () => {
  const iface = new Interface(['function multiSend(bytes transactions)']);
  let data = '0x12345678';
  for (let i = 0; i < 10; i++) data = iface.encodeFunctionData('multiSend', [packedCall({ to: TARGET, data })]);
  let node = decodeCall({ to: TARGET, value: '0', operation: 0, data });
  for (let i = 0; i < 9; i++) node = node.children[0];
  assert.match(node.decodeError, /Nested decode limit reached/);
  assert.equal(node.children.length, 0);
});

test('unknown selectors remain unknown and do not become trusted from a familiar target', async () => {
  const data = '0xdeadbeef';
  const call = decodeCall({ to: TARGET, value: '0', operation: 0, data });
  assert.equal(call.method, null);
  const report = await analyze({ ...transaction, data }, 'eth', { fetchState: false });
  assert.ok(report.findings.some(finding => finding.code === 'UNKNOWN_SELECTOR'));
  assert.equal(report.risk.uncertain, true);
});

test('Builder comparison checks exact call order, operation, target, value, and calldata', async () => {
  const interface_ = new Interface(['function transfer(address,uint256)']);
  const data = interface_.encodeFunctionData('transfer', [OTHER, 5]);
  const report = await analyze({ ...transaction, data }, 'eth', { fetchState: false });
  const matching = [{ to: TARGET, value: '0', operation: 0, data }];
  assert.equal(compareCalls(matching, report).status, 'match');
  for (const changed of [
    { ...matching[0], to: OTHER }, { ...matching[0], value: '1' },
    { ...matching[0], operation: 1 }, { ...matching[0], data: '0x' },
  ]) assert.equal(compareCalls([changed], report).status, 'mismatch');
  assert.equal(compareCalls([...matching, ...matching], report).status, 'mismatch');
  await assert.rejects(() => analyzeBuilderExport({ chainId: '100', meta: {}, transactions: matching }, 'eth'), /chain/);
  await assert.rejects(() => analyzeBuilderExport({ chainId: '1', meta: {}, transactions: [] }, 'eth'), /1–100/);
});
