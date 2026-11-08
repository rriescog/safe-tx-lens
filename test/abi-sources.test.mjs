import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { CHAINS } from '../src/chains.mjs';
import { ABI_SOURCES, ETHERSCAN_CHAINS, lookupContractSource } from '../src/abi-sources.mjs';
import { inspectTargetCode } from '../src/target-code.mjs';
import { enrichVerifiedCalls, decodeCall } from '../src/decode.mjs';
import { assessConfidence } from '../src/confidence.mjs';

const ADDRESS = '0x2222222222222222222222222222222222222222';
const runtimeCode = '0x60016000';
const contractAbi = ['function setDelay(uint256)'];
const calldata = new Interface(contractAbi).encodeFunctionData('setDelay', [60]);
const response = value => new Response(JSON.stringify(value), { status: 200 });
const credentialsReader = async () => ({ ETHERSCAN_API_KEY: 'test-key', OKLINK_API_KEY: 'test-key' });

test('every advertised network has a source route beyond the signature database', () => {
  assert.deepEqual(Object.keys(ABI_SOURCES).sort(), Object.keys(CHAINS).sort());
  for (const [network, sources] of Object.entries(ABI_SOURCES)) {
    assert.ok(sources.includes('sourcify'), network);
    assert.ok(sources.some(source => source !== 'sourcify'), network);
    assert.ok(sources.includes(ETHERSCAN_CHAINS.includes(network) ? 'etherscan' : network === 'imx' ? 'blockscout' : 'oklink'), network);
  }
});

test('matching Sourcify bytecode wins over an explorer-only ABI', async () => {
  const urls = [];
  const request = async url => {
    urls.push(String(url));
    return response({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: runtimeCode }, abi: contractAbi });
  };
  const source = await lookupContractSource('eth', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.runtimeMatch, 'exact_match');
  assert.equal(urls.length, 1);
});

test('Etherscan V2 ABI decodes on a supported chain without claiming bytecode verification', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('sourcify.dev')) return new Response('', { status: 404 });
    return response({ status: '1', result: [{ ABI: JSON.stringify(contractAbi), SourceCode: 'contract Example {}', Implementation: '' }] });
  };
  const lookup = (_network, address, options) => lookupContractSource('eth', address, { ...options, request, credentialsReader, useCache: false });
  const provider = { getNetwork: async () => ({ chainId: 1n }), getCode: async () => runtimeCode, getStorage: async () => '0x' };
  const root = decodeCall({ to: ADDRESS, data: calldata, value: '0' });
  const [target] = await inspectTargetCode(root, 'eth', { provider, sourceLookup: lookup });
  assert.equal(target.status, 'explorer_abi');
  assert.equal(target.sourceProvider, 'etherscan');
  assert.ok(calls.some(call => call.url.includes('chainid=1') && call.url.includes('action=getsourcecode')));
  enrichVerifiedCalls(root, [target]);
  assert.equal(root.method, 'setDelay(uint256)');
  assert.equal(root.decodeBasis, 'explorer_abi');
  assert.ok(assessConfidence({ call: root, targetChecks: [target] }).gaps.some(gap => gap.kind === 'decode'));
});

test('Immutable Blockscout ABI and deployed bytecode can independently match RPC', async () => {
  const request = async url => String(url).includes('sourcify.dev')
    ? new Response('', { status: 404 })
    : response({ abi: contractAbi, is_verified: true, deployed_bytecode: runtimeCode });
  const source = await lookupContractSource('imx', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.sourceProvider, 'blockscout');
  assert.equal(source.runtimeBytecode.onchainBytecode, runtimeCode);
});

test('X Layer OKLink ABI remains explicitly unverified without explorer bytecode', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('sourcify.dev')) return new Response('', { status: 404 });
    return response({ code: '0', data: [{ contractAbi: JSON.stringify(contractAbi), sourceCode: 'contract Example {}' }] });
  };
  const source = await lookupContractSource('xlayer', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.sourceProvider, 'oklink');
  assert.equal(source.explorerAbi, true);
  assert.equal(source.runtimeBytecode, undefined);
  assert.ok(calls.some(call => call.url.includes('chainShortName=XLAYER') && call.options.headers['OK-ACCESS-KEY'] === 'test-key'));
});

test('Blockscout ABI without a verified source flag cannot certify runtime code', async () => {
  const request = async url => String(url).includes('sourcify.dev')
    ? new Response('', { status: 404 })
    : response({ abi: contractAbi, is_verified: false, deployed_bytecode: runtimeCode });
  const source = await lookupContractSource('imx', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.explorerAbi, true);
  assert.equal(source.runtimeBytecode, undefined);
});

test('unverified explorer response does not invent an ABI', async () => {
  const request = async url => String(url).includes('sourcify.dev')
    ? new Response('', { status: 404 })
    : response({ status: '0', result: 'Contract source code not verified' });
  assert.equal(await lookupContractSource('eth', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false }), null);
});

test('historical bytecode mismatch cannot be promoted by a current explorer ABI', async () => {
  const request = async url => String(url).includes('sourcify.dev')
    ? response({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60026000' }, abi: contractAbi })
    : response({ status: '1', result: [{ ABI: JSON.stringify(contractAbi), SourceCode: 'contract Example {}', Implementation: '' }] });
  const source = await lookupContractSource('eth', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.sourceProvider, 'etherscan');
  assert.equal(source.explorerAbi, true);
});
