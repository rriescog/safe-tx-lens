import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, keccak256 } from 'ethers';
import { inspectTargetCode } from '../src/target-code.mjs';

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
