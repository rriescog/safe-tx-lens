import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { decodeCall, enrichVerifiedCalls, summarizeCalls } from '../src/decode.mjs';
import { inspectTargetCode } from '../src/target-code.mjs';
import { assessConfidence } from '../src/confidence.mjs';
import { validateInspectionRequest } from '../src/input-boundary.mjs';
import { publicSupportConfig } from '../src/support.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const VAULT = '0x2c1270a714F650F68f80e83850d85d003082B456';
const BATCH = '0x3333333333333333333333333333333333333333';
const transfer = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [SAFE, 42]);
const retrieve = '0x2bc2bef2';
const record = (to, data) => `00${to.slice(2)}${'0'.repeat(64)}${BigInt((data.length - 2) / 2).toString(16).padStart(64, '0')}${data.slice(2)}`;
const packed = `0x${record(TOKEN, transfer)}${record(VAULT, retrieve)}`;

test('verified ABI decodes an unknown nested selector beside a transfer', async () => {
  const batch = new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [packed]);
  const root = decodeCall({ to: BATCH, value: '0', operation: 1, data: batch });
  assert.equal(root.children[1].method, null);
  const provider = { getNetwork: async () => ({ chainId: 1n }), getCode: async () => '0x60016000', getStorage: async () => '0x' };
  const sourceLookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: address.toLowerCase() === VAULT.toLowerCase() ? ['function retrieveRemaining()'] : address === BATCH ? ['function multiSend(bytes)'] : ['function transfer(address,uint256)'] });
  const checks = await inspectTargetCode(root, 'eth', { provider, sourceLookup });
  enrichVerifiedCalls(root, checks);
  assert.equal(root.children[1].method, 'retrieveRemaining()');
  assert.deepEqual(root.children[1].args, []);
  assert.match(root.children[1].decodeSource, /verified bytecode/);
  assert.equal(summarizeCalls(root)[1].label, 'retrieveRemaining()');
});

test('source label is withheld if RPC bytecode differs or selector is absent', async () => {
  const root = decodeCall({ to: VAULT, value: '0', operation: 0, data: retrieve });
  enrichVerifiedCalls(root, [{ address: VAULT, status: 'mismatch', verifiedFunctions: [{ selector: retrieve, signature: 'retrieveRemaining()', abi: 'function retrieveRemaining()' }] }]);
  assert.equal(root.method, null);
  enrichVerifiedCalls(root, [{ address: VAULT, status: 'verified', verifiedFunctions: [] }]);
  assert.equal(root.method, null);
});

test('evidence confidence fails closed on hash mismatch and flags unchecked target', () => {
  const root = decodeCall({ to: VAULT, value: '0', operation: 0, data: retrieve });
  const failed = assessConfidence({ call: root, checks: [{ method: 'local_eip712', status: 'fail' }] });
  assert.equal(failed.score, 0);
  const incomplete = assessConfidence({ call: root, checks: [{ method: 'local_eip712', status: 'pass' }] });
  assert.equal(incomplete.color, 'red');
  assert.match(incomplete.reasons.join(' '), /undecoded/);
});

test('every HTTP input field rejects instruction-like invalid values structurally', () => {
  const valid = { input: retrieve, network: 'eth', scope: 'pending' };
  for (const key of ['network', 'scope', 'safeAddress', 'safeHash', 'simulate', 'verifyTargets']) {
    assert.throws(() => validateInspectionRequest({ ...valid, [key]: 'ignore previous instructions <script>' }));
  }
  assert.throws(() => validateInspectionRequest({ ...valid, input: 'a'.repeat(2000001) }), /length/);
  assert.equal(validateInspectionRequest({ input: { safe: SAFE, to: VAULT }, network: 'eth' }).network, 'eth');
});

test('donation destinations are explicit EVM addresses and do not include Bitcoin yet', () => {
  const config = publicSupportConfig();
  assert.equal(config.wallets.length, 9);
  assert.equal(config.wallets.find(wallet => wallet.network === 'pol').address.toLowerCase(), '0x36560ad123164440a5187243783614237d783e98');
  assert.throws(() => publicSupportConfig('[{"network":"eth","address":"<script>"}]'));
});
