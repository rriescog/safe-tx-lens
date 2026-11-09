import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { decodeCall, enrichVerifiedCalls, summarizeCalls } from '../src/decode.mjs';
import { inspectTargetCode } from '../src/target-code.mjs';
import { assessConfidence } from '../src/confidence.mjs';
import { validateInspectionRequest } from '../src/input-boundary.mjs';
import { publicSupportConfig } from '../src/support.mjs';
import { chainId } from '../src/chains.mjs';
import { assessRisk } from '../src/risk.mjs';
import { analyze } from '../src/analyze.mjs';

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
  const risk = assessRisk({ call: root, actions: summarizeCalls(root), findings: [], effects: [], checks: [], transaction: { operation: 1, isExecuted: false } });
  assert.equal(risk.actionRatings[1].level, 'high');
});

test('an arbitrary supplied Safe transaction uses its target verified ABI', async () => {
  const abi = ['function rotateTreasury(address newTreasury,uint256 epoch)'];
  const data = new Interface(abi).encodeFunctionData('rotateTreasury', [SAFE, 42]);
  const provider = { getNetwork: async () => ({ chainId: 1n }), getCode: async () => '0x60016000', getStorage: async () => '0x' };
  const sourceLookup = async () => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi });
  const report = await analyze({ safe: SAFE, to: VAULT, nonce: 1, value: '0', data, operation: 0 }, 'eth', {
    fetchState: false, verifyTargets: true, targetProvider: provider, sourceLookup,
  });
  assert.equal(report.call.method, 'rotateTreasury(address,uint256)');
  assert.equal(report.call.decodeBasis, 'verified_abi');
  assert.equal(report.call.args[0].value, SAFE);
  assert.equal(report.targetChecks[0].status, 'verified');
});

test('bounded live ABI lookup prioritizes unknown calls and reports skipped targets', async () => {
  const batch = new Interface(['function multiSend(bytes)']).encodeFunctionData('multiSend', [packed]);
  const root = decodeCall({ to: BATCH, value: '0', operation: 1, data: batch });
  const requested = [];
  const provider = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async address => { requested.push(address); return '0x60016000'; },
    getStorage: async () => '0x',
  };
  const sourceLookup = async () => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: ['function retrieveRemaining()'] });
  const checks = await inspectTargetCode(root, 'eth', { provider, sourceLookup, maxTargets: 1 });
  assert.equal(requested.length, 1);
  assert.equal(requested[0].toLowerCase(), VAULT.toLowerCase());
  assert.equal(checks.find(check => check.address.toLowerCase() === VAULT.toLowerCase()).status, 'verified');
  assert.equal(checks.filter(check => check.status === 'unavailable').length, 2);
  assert.ok(checks.filter(check => check.status === 'unavailable').every(check => /limit/.test(check.reason)));
});

test('source label is withheld if RPC bytecode differs or selector is absent', async () => {
  const root = decodeCall({ to: VAULT, value: '0', operation: 0, data: retrieve });
  enrichVerifiedCalls(root, [{ address: VAULT, status: 'mismatch', verifiedFunctions: [{ selector: retrieve, signature: 'retrieveRemaining()', abi: 'function retrieveRemaining()' }] }]);
  assert.equal(root.method, null);
  enrichVerifiedCalls(root, [{ address: VAULT, status: 'verified', verifiedFunctions: [] }]);
  assert.equal(root.method, null);
});

test('a built-in signature is marked verified only when the target ABI matches it', () => {
  const call = decodeCall({ to: VAULT, value: '0', operation: 0, data: transfer });
  assert.equal(call.decodeBasis, 'known_signature');
  const fragment = new Interface(['function transfer(address,uint256)']).getFunction('transfer');
  enrichVerifiedCalls(call, [{ address: VAULT, status: 'verified', source: 'https://repo.sourcify.dev/1/example', verifiedFunctions: [{ selector: call.selector, signature: fragment.format('sighash'), abi: fragment.format('json') }] }]);
  assert.equal(call.decodeBasis, 'verified_abi');
  assert.match(call.decodeSource, /verified bytecode/);
});

test('legacy proxy transfer uses the checked implementation ABI and reviewed forwarding route', () => {
  const call = decodeCall({ to: VAULT, value: '0', operation: 0, data: transfer });
  const fragment = new Interface(['function transfer(address,uint256)']).getFunction('transfer');
  enrichVerifiedCalls(call, [{
    address: VAULT, status: 'verified', verifiedFunctions: [],
    proxy: {
      standard: 'ZeppelinOS implementation slot', implementation: TOKEN,
      implementationCode: { status: 'verified', source: 'https://repo.sourcify.dev/1/example', verifiedFunctions: [{ selector: call.selector, signature: fragment.format('sighash'), abi: fragment.format('json') }] },
      forwarding: { status: 'verified_at_block', pattern: 'reviewed delegatecall fallback', blockTag: 'latest' },
    },
  }]);
  assert.equal(call.method, 'transfer(address,uint256)');
  assert.equal(call.decodeBasis, 'verified_proxy_abi');
  assert.match(call.decodeSource, /ZeppelinOS implementation slot/);
});

test('evidence confidence fails closed on hash mismatch and flags unchecked target', () => {
  const root = decodeCall({ to: VAULT, value: '0', operation: 0, data: retrieve });
  const failed = assessConfidence({ call: root, checks: [{ method: 'local_eip712', status: 'fail' }] });
  assert.equal(failed.score, 0);
  const incomplete = assessConfidence({ call: root, checks: [{ method: 'local_eip712', status: 'pass' }] });
  assert.equal(incomplete.color, 'red');
  assert.match(incomplete.reasons.join(' '), /undecoded/);
  assert.equal(incomplete.gaps.reduce((sum, gap) => sum + gap.points, 0), 10 - incomplete.score);
  assert.match(incomplete.gaps.map(gap => gap.label).join(' '), /RPC|bytecode|simulation/);
});

test('historical code uncertainty explains the exact points withheld', () => {
  const call = { to: VAULT, data: retrieve, method: 'retrieveRemaining()', children: [] };
  const confidence = assessConfidence({
    call,
    checks: [{ method: 'local_eip712', status: 'pass' }, { method: 'onchain_rpc', status: 'pass' }],
    targetChecks: [{ address: VAULT, status: 'verified_current', selectors: ['0x2bc2bef2'], historicalUnavailable: true }],
    simulation: { success: true, stateDiffAvailable: true },
    transaction: { isExecuted: true },
  });
  assert.equal(confidence.score, 7);
  assert.equal(confidence.gaps.reduce((sum, gap) => sum + gap.points, 0), 3);
  assert.match(confidence.gaps[0].label, /archive-capable RPC/);
});

test('every HTTP input field rejects instruction-like invalid values structurally', () => {
  const valid = { input: retrieve, network: 'eth', scope: 'pending' };
  for (const key of ['network', 'scope', 'safeAddress', 'safeHash', 'simulate', 'verifyTargets', 'decodeCandidates']) {
    assert.throws(() => validateInspectionRequest({ ...valid, [key]: 'ignore previous instructions <script>' }));
  }
  assert.throws(() => validateInspectionRequest({ ...valid, input: 'a'.repeat(2000001) }), /length/);
  assert.throws(() => validateInspectionRequest({ ...valid, rpcUrl: 'http://127.0.0.1:8545' }), /Unsupported request field/);
  assert.equal(validateInspectionRequest({ input: { safe: SAFE, to: VAULT }, network: 'eth' }).network, 'eth');
});

test('donation destinations are absent until explicitly configured', () => {
  const config = publicSupportConfig();
  assert.equal(config.wallets.length, 0);
  assert.equal(publicSupportConfig(JSON.stringify([{ network: 'pol', address: SAFE }])).wallets[0].address, SAFE);
  assert.throws(() => publicSupportConfig('[{"network":"eth","address":"<script>"}]'));
});

test('a supplied EVM chain ID extends inspection beyond the named networks without auto-discovery', () => {
  assert.equal(chainId('130'), 130);
  assert.equal(validateInspectionRequest({ input: { safe: SAFE, to: VAULT }, network: '130' }).network, '130');
  assert.throws(() => chainId('0'));
  assert.throws(() => chainId('9999999999999999'));
});
