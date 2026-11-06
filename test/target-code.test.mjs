import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { inspectTargetCode, sourcifyLookup } from '../src/target-code.mjs';

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
  const unavailable = await inspectTargetCode(call, 'zkevm');
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
    await assert.rejects(() => sourcifyLookup('eth', TARGET), /Sourcify 503/);
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
