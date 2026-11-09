import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { inspectTargetCode, recognizeGetterFallback, recognizeLegacyFallback, sourcifyLookup } from '../src/target-code.mjs';
import { analyze } from '../src/analyze.mjs';
import { assessConfidence } from '../src/confidence.mjs';

const TARGET = '0x2222222222222222222222222222222222222222';
const LOGIC = '0x3333333333333333333333333333333333333333';
const data = new Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [LOGIC, 1]);
const call = { to: TARGET, selector: data.slice(0, 10), data, operation: 0, children: [] };
const abi = ['function transfer(address,uint256)'];
const sourceLookup = async () => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi });
const provider = ({ code = '0x60016000', chainId = 1n, implementation = '0x' } = {}) => ({
  getNetwork: async () => ({ chainId }),
  getCode: async () => code,
  getStorage: async () => implementation,
});

test('target verification compares RPC bytecode with independently verified source and ABI', async () => {
  const [target] = await inspectTargetCode(call, 'eth', { provider: provider(), sourceLookup });
  assert.equal(target.status, 'verified');
  assert.equal(target.bytecodeHash, keccak256('0x60016000'));
  assert.equal(target.abiSelectors[0].present, true);
  assert.match(target.source, /^https:\/\/repo\.sourcify\.dev\/1\//);
});

test('target verification reports mismatches, missing code, unavailable RPC and chain errors', async () => {
  const mismatch = await inspectTargetCode(call, 'eth', { provider: provider({ code: '0x60026000' }), sourceLookup });
  assert.equal(mismatch[0].status, 'mismatch');
  const empty = await inspectTargetCode(call, 'eth', { provider: provider({ code: '0x' }), sourceLookup });
  assert.equal(empty[0].status, 'no_code');
  const unavailable = await inspectTargetCode(call, '1101');
  assert.equal(unavailable[0].status, 'unavailable');
  const wrongChain = await inspectTargetCode(call, 'eth', { provider: provider({ chainId: 100n }) });
  assert.match(wrongChain[0].reason, /RPC chain/);
});

test('ERC-1967 implementation is inspected separately', async () => {
  const slot = `0x${'0'.repeat(24)}${LOGIC.slice(2)}`;
  const [target] = await inspectTargetCode(call, 'eth', { provider: provider({ implementation: slot }), sourceLookup });
  assert.equal(target.proxy.implementation, LOGIC);
  assert.equal(target.proxy.implementationCode.status, 'verified');
});

test('verified legacy ZeppelinOS proxy resolves its implementation without assuming its fallback route', async () => {
  const legacySlot = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
  const outerCode = `0x7f${legacySlot.slice(2)}6000`;
  const implementationSlotValue = `0x${'0'.repeat(24)}${LOGIC.slice(2)}`;
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async address => address.toLowerCase() === TARGET.toLowerCase() ? outerCode : '0x60016000',
    getStorage: async (_address, slot) => slot === legacySlot ? implementationSlotValue : '0x',
  };
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: address.toLowerCase() === TARGET.toLowerCase() ? outerCode : '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? ['function implementation() view returns (address)', 'function admin() view returns (address)', { type: 'fallback', stateMutability: 'payable' }] : abi });
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, sourceLookup: lookup });
  assert.equal(target.proxy.standard, 'ZeppelinOS implementation slot');
  assert.equal(target.proxy.implementation, LOGIC);
  assert.equal(target.proxy.implementationCode.abiSelectors[0].present, true);
  assert.equal(target.proxy.forwarding, undefined);
  const reviewed = recognizeLegacyFallback({ ...target, bytecodeHash: '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505' });
  assert.equal(reviewed.status, 'verified_at_block');
  assert.equal(recognizeLegacyFallback({ ...target, status: 'verified_current', bytecodeHash: '0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505' }), null);
});

test('SafeProxy slot-0 singleton ABI is inspected instead of treating proxy ABI as target ABI', async () => {
  const slot = `0x${'0'.repeat(24)}${LOGIC.slice(2)}`;
  const rpc = { ...provider(), getStorage: async (_address, index) => index === 0 ? slot : '0x' };
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? ['function masterCopy() view returns (address)'] : abi });
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, sourceLookup: lookup });
  assert.equal(target.proxy.standard, 'SafeProxy');
  assert.equal(target.proxy.implementation, LOGIC);
  assert.equal(target.abiSelectors[0].present, false);
  assert.equal(target.proxy.implementationCode.abiSelectors[0].present, true);
  const review = await analyze({ safe: TARGET, to: TARGET, value: '0', data, operation: 0, nonce: 1 }, 'eth', { fetchState: false, verifyTargets: true, targetProvider: rpc, sourceLookup: lookup });
  assert.equal(review.findings.some(item => item.code === 'TARGET_ABI_MISMATCH'), false);
});

test('verified fallback proxy follows its implementation getter before judging the call ABI', async () => {
  const getter = new Interface(['function implementation() view returns (address)']);
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async () => '0x60016000',
    getStorage: async () => '0x',
    call: async () => getter.encodeFunctionResult('implementation', [LOGIC]),
  };
  const proxyAbi = ['function implementation() view returns (address)', 'function proxyType() view returns (uint256)', { type: 'fallback', stateMutability: 'payable' }];
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? proxyAbi : abi });
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, sourceLookup: lookup });
  assert.equal(target.status, 'verified');
  assert.equal(target.abiSelectors[0].present, false);
  assert.equal(target.proxy.standard, 'implementation() fallback');
  assert.equal(target.proxy.implementation, LOGIC);
  assert.equal(target.proxy.implementationCode.abiSelectors[0].present, true);
  const review = await analyze({ safe: TARGET, to: TARGET, value: '0', data, operation: 0, nonce: 1 }, 'eth', { fetchState: false, verifyTargets: true, targetProvider: rpc, sourceLookup: lookup });
  assert.equal(review.call.decodeBasis, 'proxy_candidate_abi');
  assert.equal(review.findings.some(item => item.code === 'TARGET_ABI_MISMATCH'), false);
  assert.ok(assessConfidence({ call: review.call, checks: [], targetChecks: review.targetChecks, transaction: review.transaction }).gaps.some(gap => gap.kind === 'proxy'));
});

test('reviewed proxy route requires matching historical proxy and implementation bytecode', () => {
  for (const bytecodeHash of [
    '0x16a91aacbcdd1004cdf64fae29bcb2647e0b8652868adba817af4db0944a9a69',
    '0x21e86e6f958f52aed4a68a4741a2ee6fce762ba95648aabb9fdb07b4647b6e9a',
  ]) {
    const check = { status: 'verified', bytecodeHash, blockTag: 99, proxy: { standard: 'implementation() fallback', implementationCode: { status: 'verified' } } };
    assert.equal(recognizeGetterFallback(check).status, 'verified_at_block');
    assert.equal(recognizeGetterFallback({ ...check, status: 'verified_current' }), null);
    assert.equal(recognizeGetterFallback({ ...check, proxy: { ...check.proxy, implementationCode: { status: 'verified_current' } } }), null);
    assert.equal(recognizeGetterFallback({ ...check, bytecodeHash: keccak256('0x60016000') }), null);
  }
});

test('historical proxy getter resolves the implementation from before execution', async () => {
  const getter = new Interface(['function implementation() view returns (address)']);
  const currentLogic = '0x4444444444444444444444444444444444444444';
  const calls = [];
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async () => '0x60016000',
    getStorage: async () => '0x',
    call: async request => {
      calls.push(request);
      return getter.encodeFunctionResult('implementation', [request.blockTag === 99 ? LOGIC : currentLogic]);
    },
  };
  const proxyAbi = ['function implementation() view returns (address)', 'function proxyType() view returns (uint256)', { type: 'fallback', stateMutability: 'payable' }];
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? proxyAbi : abi });
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, sourceLookup: lookup, blockTag: 99 });
  assert.equal(calls[0].blockTag, 99);
  assert.equal(target.proxy.implementation, LOGIC);
  assert.equal(target.proxy.implementationCode.blockTag, 99);
});

test('a proxy administration selector is valid in the outer ABI even when absent from its implementation ABI', async () => {
  const update = new Interface(['function updateImplementation(address newImplementation)']).encodeFunctionData('updateImplementation', [LOGIC]);
  const getter = new Interface(['function implementation() view returns (address)']);
  const rpc = { getNetwork: async () => ({ chainId: 1n }), getCode: async () => '0x60016000', getStorage: async () => '0x', call: async () => getter.encodeFunctionResult('implementation', [LOGIC]) };
  const proxyAbi = ['function implementation() view returns (address)', 'function proxyType() view returns (uint256)', 'function updateImplementation(address newImplementation)', { type: 'fallback', stateMutability: 'payable' }];
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? proxyAbi : abi });
  const review = await analyze({ safe: TARGET, to: TARGET, value: '0', data: update, operation: 0, nonce: 1 }, 'eth', { fetchState: false, verifyTargets: true, targetProvider: rpc, sourceLookup: lookup });
  assert.equal(review.call.decodeBasis, 'verified_abi');
  assert.equal(review.targetChecks[0].abiSelectors[0].present, true);
  assert.equal(review.targetChecks[0].proxy.implementationCode.abiSelectors[0].present, false);
  assert.equal(review.findings.some(item => item.code === 'TARGET_ABI_MISMATCH'), false);
});

test('verified ABI parameter aliases preserve upgrade target and check the proposed implementation', async () => {
  const timelock = '0x4444444444444444444444444444444444444444';
  const nextLogic = '0x5555555555555555555555555555555555555555';
  const batch = new Interface(['function executeBatch(address[] targets,uint256[] values,bytes[] datas,bytes32 predecessor,bytes32 salt)']);
  const upgrade = new Interface(['function updateImplementation(address newImplementation)']);
  const validator = new Interface(['function reinitializeValidatorState(uint256 expectedIncrease)']);
  const zero = `0x${'0'.repeat(64)}`;
  const payload = batch.encodeFunctionData('executeBatch', [[TARGET, TARGET], [0, 0], [upgrade.encodeFunctionData('updateImplementation', [nextLogic]), validator.encodeFunctionData('reinitializeValidatorState', [123])], zero, zero]);
  const getter = new Interface(['function implementation() view returns (address)']);
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async () => '0x60016000',
    getStorage: async () => '0x',
    call: async () => getter.encodeFunctionResult('implementation', [LOGIC]),
  };
  const source = async (_network, address) => ({
    runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' },
    abi: address.toLowerCase() === timelock.toLowerCase() ? ['function executeBatch(address[] targets,uint256[] values,bytes[] datas,bytes32 predecessor,bytes32 salt)']
      : address.toLowerCase() === TARGET.toLowerCase() ? ['function implementation() view returns (address)', 'function proxyType() view returns (uint256)', 'function updateImplementation(address _newProxyTo)', { type: 'fallback', stateMutability: 'payable' }]
        : address.toLowerCase() === nextLogic.toLowerCase() ? ['function reinitializeValidatorState(uint256 expectedIncrease)'] : ['function oldValidatorAction(uint256)'],
  });
  const review = await analyze({ safe: timelock, to: timelock, value: '0', data: payload, operation: 0, nonce: 1 }, 'eth', { fetchState: false, verifyTargets: true, targetProvider: rpc, sourceLookup: source });
  assert.equal(review.actions[0].label, `Update proxy implementation to ${nextLogic}`);
  const checkedProxy = review.targetChecks.find(item => item.address.toLowerCase() === TARGET.toLowerCase());
  assert.equal(checkedProxy.plannedImplementation, nextLogic);
  assert.equal(checkedProxy.plannedImplementationCode.status, 'verified');
  assert.ok(review.findings.some(item => item.code === 'UPGRADE_TARGET_ABI_CONDITIONAL'));
  assert.equal(review.findings.some(item => item.code === 'TARGET_ABI_MISMATCH'), false);
  const missingSource = async (network, address) => {
    const entry = await source(network, address);
    return address.toLowerCase() === nextLogic.toLowerCase() ? { ...entry, abi: ['function unrelated(uint256)'] } : entry;
  };
  const unresolved = await analyze({ safe: timelock, to: timelock, value: '0', data: payload, operation: 0, nonce: 1 }, 'eth', { fetchState: false, verifyTargets: true, targetProvider: rpc, sourceLookup: missingSource });
  assert.ok(unresolved.findings.some(item => item.code === 'TARGET_ABI_MISMATCH'));
  assert.equal(unresolved.findings.some(item => item.code === 'UPGRADE_TARGET_ABI_CONDITIONAL'), false);
});

test('assembly SafeProxy with constructor and fallback ABI resolves singleton', async () => {
  const slot = `0x${'0'.repeat(24)}${LOGIC.slice(2)}`;
  const proxyCode = '0x7fa619486e600054';
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async address => address.toLowerCase() === TARGET.toLowerCase() ? proxyCode : '0x60016000',
    getStorage: async (_address, index) => index === 0 ? slot : '0x',
  };
  const lookup = async (_network, address) => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: address.toLowerCase() === TARGET.toLowerCase() ? proxyCode : '0x60016000' }, abi: address.toLowerCase() === TARGET.toLowerCase() ? [{ type: 'constructor', inputs: [{ name: '_singleton', type: 'address' }] }, { type: 'fallback', stateMutability: 'payable' }] : abi });
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, sourceLookup: lookup });
  assert.equal(target.proxy.standard, 'SafeProxy');
  assert.equal(target.proxy.implementationCode.abiSelectors[0].present, true);
});

test('archive RPC failure is disclosed for proxy and implementation alike', async () => {
  const slot = `0x${'0'.repeat(24)}${LOGIC.slice(2)}`;
  const rpc = {
    getNetwork: async () => ({ chainId: 1n }),
    getCode: async (_address, blockTag) => { if (blockTag !== 'latest') throw new Error('archive unavailable'); return '0x60016000'; },
    getStorage: async () => slot,
  };
  const [target] = await inspectTargetCode(call, 'eth', { provider: rpc, blockTag: 12345, sourceLookup });
  assert.equal(target.status, 'verified_current');
  assert.equal(target.proxy.implementationCode.status, 'verified_current');
  assert.equal(target.historicalUnavailable, true);
  assert.equal(target.proxy.implementationCode.historicalUnavailable, true);
});

test('verified bytecode remains verified when source ABI is malformed', async () => {
  const [target] = await inspectTargetCode(call, 'eth', {
    provider: provider(),
    sourceLookup: async () => ({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: ['function ('] }),
  });
  assert.equal(target.status, 'verified');
  assert.match(target.abiWarning, /could not be parsed/);
});

test('Sourcify lookup distinguishes absence, outage, and a successful response', async () => {
  const original = globalThis.fetch;
  try {
    const urls = [];
    globalThis.fetch = async url => { urls.push(String(url)); return new Response('', { status: 404 }); };
    assert.equal(await sourcifyLookup('eth', TARGET), null);
    assert.match(urls[0], /\/1\/0x2222/);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await assert.rejects(() => sourcifyLookup('eth', TARGET), /Source API sourcify.dev 503/);
    globalThis.fetch = async () => new Response(JSON.stringify({ runtimeMatch: 'exact_match' }), { status: 200 });
    assert.equal((await sourcifyLookup('eth', TARGET)).runtimeMatch, 'exact_match');
  } finally { globalThis.fetch = original; }
});

test('target verification reports unverified source details without inventing a match', async () => {
  const inspect = async sourceLookup => (await inspectTargetCode(call, 'eth', { provider: provider(), sourceLookup }))[0];
  assert.equal((await inspect(async () => null)).status, 'unverified');
  assert.match((await inspect(async () => ({ runtimeMatch: 'exact_match' }))).reason, /did not return runtime bytecode/);
  assert.match((await inspect(async () => ({ runtimeMatch: 'partial_match', runtimeBytecode: { onchainBytecode: '0x60016000' } }))).reason, /no recognized runtime match/);
  assert.match((await inspect(async () => { throw new Error('offline'); })).reason, /offline/);
  const absentSelector = await inspect(async () => ({ runtimeMatch: 'match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: ['function approve(address,uint256)'] }));
  assert.equal(absentSelector.status, 'verified');
  assert.equal(absentSelector.abiSelectors[0].present, false);
});

test('target verification contains bad RPC responses and archive failure', async () => {
  const badCode = await inspectTargetCode(call, 'eth', { provider: provider({ code: 'not hex' }) });
  assert.equal(badCode[0].status, 'unavailable');
  const noArchive = { getNetwork: async () => ({ chainId: 1n }), getCode: async () => { throw new Error('offline'); } };
  const archive = await inspectTargetCode(call, 'eth', { provider: noArchive, blockTag: 123 });
  assert.match(archive[0].reason, /Historical and current/);
  const latest = await inspectTargetCode(call, 'eth', { provider: noArchive });
  assert.match(latest[0].reason, /RPC bytecode unavailable/);
  const slotFail = await inspectTargetCode(call, 'eth', { provider: { ...provider(), getStorage: async () => { throw new Error('archive storage missing'); } }, sourceLookup });
  assert.match(slotFail[0].proxyCheck, /archive storage missing/);
});

test('target verification deduplicates addresses and rejects oversized call graphs', async () => {
  const duplicate = { ...call, children: [{ ...call, children: [] }] };
  const results = await inspectTargetCode(duplicate, 'eth', { provider: provider(), sourceLookup });
  assert.equal(results.length, 1);
  const many = { ...call, children: Array.from({ length: 33 }, (_, index) => ({
    to: `0x${(index + 1).toString(16).padStart(40, '0')}`, operation: 0, selector: '0x12345678', children: [],
  })) };
  await assert.rejects(() => inspectTargetCode(many, 'eth', { provider: provider(), sourceLookup }), /more than 32/);
});

test('target graph skips invalid addresses and accepts Sourcify match field without ABI', async () => {
  const root = { to: 'not-an-address', selector: 'invalid', operation: 0, children: [call] };
  const reports = await inspectTargetCode(root, 'eth', {
    provider: provider(), sourceLookup: async () => ({ match: 'match', runtimeBytecode: { onchainBytecode: '0x60016000' }, abi: [] }),
  });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'verified');
  assert.equal(reports[0].abiSelectors[0].present, false);
});
