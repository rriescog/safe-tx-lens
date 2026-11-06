import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { getAddress } from 'ethers';
import { unpackMultiSend, decodeCall } from '../src/decode.mjs';
import { parseInput } from '../src/inputs.mjs';
import { calculateHash, normalizeTransaction } from '../src/analyze.mjs';

const SEED = Number(process.env.FUZZ_SEED ?? 20261106);
const RUNS = Number(process.env.FUZZ_RUNS ?? 1000);
const hex = bytes => Buffer.from(bytes).toString('hex');
const address = fc.uint8Array({ minLength: 20, maxLength: 20 }).map(bytes => `0x${hex(bytes)}`);
const calldata = fc.uint8Array({ maxLength: 128 }).map(bytes => `0x${hex(bytes)}`);
const call = fc.record({ operation: fc.constantFrom(0, 1), to: address, value: fc.bigInt({ min: 0n, max: (1n << 128n) - 1n }), data: calldata });

function pack(item) {
  return `${item.operation.toString(16).padStart(2, '0')}${item.to.slice(2)}${item.value.toString(16).padStart(64, '0')}${((item.data.length - 2) / 2).toString(16).padStart(64, '0')}${item.data.slice(2)}`;
}

test('fuzz: MultiSend packed records round-trip exactly across call sequences', () => {
  fc.assert(fc.property(fc.array(call, { maxLength: 12 }), calls => {
    const decoded = unpackMultiSend(`0x${calls.map(pack).join('')}`);
    assert.deepEqual(decoded, calls.map(item => ({ operation: item.operation, to: getAddress(item.to), value: item.value.toString(), data: item.data })));
  }), { seed: SEED, numRuns: RUNS, endOnFailure: true });
});

test('fuzz: truncated MultiSend records are rejected at every cut point', () => {
  fc.assert(fc.property(call, item => {
    const packed = pack(item);
    for (let cut = 2; cut < packed.length; cut += 2) {
      assert.throws(() => unpackMultiSend(`0x${packed.slice(0, cut)}`));
    }
  }), { seed: SEED + 1, numRuns: Math.min(RUNS, 200), endOnFailure: true });
});

test('fuzz: malformed MultiSend operation and claimed length never become calls', () => {
  fc.assert(fc.property(call, fc.integer({ min: 2, max: 255 }), fc.bigInt({ min: 1n, max: 1000001n }), (item, operation, excess) => {
    const packed = pack(item);
    assert.throws(() => unpackMultiSend(`0x${operation.toString(16).padStart(2, '0')}${packed.slice(2)}`), /operation/);
    const requestedLength = BigInt((item.data.length - 2) / 2) + excess;
    const badLength = `${packed.slice(0, 106)}${requestedLength.toString(16).padStart(64, '0')}${packed.slice(170)}`;
    assert.throws(() => unpackMultiSend(`0x${badLength}`), /data length/);
  }), { seed: SEED + 4, numRuns: RUNS, endOnFailure: true });
});

test('fuzz: address and calldata changes alter the Safe EIP-712 hash', () => {
  fc.assert(fc.property(address, address, calldata, fc.uint8Array({ minLength: 1, maxLength: 32 }), (safe, to, data, mutation) => {
    const tx = normalizeTransaction({ safe, to, data, nonce: '1', value: '0', operation: 0 });
    const original = calculateHash(tx, 'eth');
    assert.notEqual(calculateHash({ ...tx, nonce: '2' }, 'eth'), original);
    assert.notEqual(calculateHash({ ...tx, value: '1' }, 'eth'), original);
    assert.notEqual(calculateHash({ ...tx, data: `0x${hex(mutation)}` }, 'eth'), original);
  }), { seed: SEED + 5, numRuns: RUNS, endOnFailure: true });
});

test('fuzz: Safe URL preserves chain, address and exact hash', () => {
  fc.assert(fc.property(address, fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.constantFrom('eth', 'gno', 'pol', 'arb1', 'oeth', 'base', 'sep', 'bnb', 'avax'), (safe, hashBytes, chain) => {
    const hash = `0x${hex(hashBytes)}`;
    const url = `https://app.safe.global/transactions/tx?safe=${chain}:${safe}&id=multisig_${safe}_${hash}`;
    const parsed = parseInput(url, 'auto');
    assert.equal(parsed.kind, 'hash');
    assert.equal(parsed.hash, hash);
    assert.equal(parsed.network, chain);
    assert.equal(parsed.expectedSafe.toLowerCase(), safe.toLowerCase());
  }), { seed: SEED + 2, numRuns: RUNS, endOnFailure: true });
});

test('fuzz: normalized Safe fields keep a stable EIP-712 hash', () => {
  fc.assert(fc.property(address, address, calldata, fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (safe, to, data, nonce) => {
    const raw = { safe, to, data, nonce: nonce.toString(), value: '0', operation: 0 };
    const normalized = normalizeTransaction(raw);
    assert.deepEqual(normalizeTransaction(normalized), normalized);
    assert.equal(calculateHash(normalized, 'eth'), calculateHash(normalizeTransaction(raw), 'eth'));
    assert.notEqual(calculateHash(normalized, 'eth'), calculateHash(normalized, 'pol'));
    assert.equal(decodeCall(normalized).data, data);
  }), { seed: SEED + 3, numRuns: RUNS, endOnFailure: true });
});
