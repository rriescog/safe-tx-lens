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
  const result = await lookupContractSource('eth', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(result.noSource, true);
  assert.equal(result.abi, undefined);
  assert.deepEqual(result.evidence.map(item => [item.provider, item.outcome]), [['sourcify', 'not_verified'], ['etherscan', 'not_verified']]);
});

test('historical bytecode mismatch cannot be promoted by a current explorer ABI', async () => {
  const request = async url => String(url).includes('sourcify.dev')
    ? response({ runtimeMatch: 'exact_match', runtimeBytecode: { onchainBytecode: '0x60026000' }, abi: contractAbi })
    : response({ status: '1', result: [{ ABI: JSON.stringify(contractAbi), SourceCode: 'contract Example {}', Implementation: '' }] });
  const source = await lookupContractSource('eth', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false });
  assert.equal(source.sourceProvider, 'etherscan');
  assert.equal(source.explorerAbi, true);
});

const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
const OTHER_CODE = '0x60026000';
const explorerRow = { status: '1', result: [{ ABI: JSON.stringify(contractAbi), SourceCode: 'contract Example {}', ContractName: 'Example', CompilerVersion: 'v0.8.20+commit.a1b79de6', Implementation: '' }] };

test('report states each source answer: Sourcify has other bytecode, explorer has ABI only, import rejected', async () => {
  const calls = [];
  const request = async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method ?? 'GET', body: options.body });
    if (href.includes('/v2/contract/')) return json({ match: 'exact_match', runtimeMatch: 'exact_match', verifiedAt: '2024-08-08T11:22:32Z', compilation: { name: 'Example', compilerVersion: '0.5.11' }, runtimeBytecode: { onchainBytecode: OTHER_CODE }, abi: contractAbi });
    if (href.includes('/v2/verify/etherscan/')) return json({ verificationId: 'job-1' }, 202);
    if (href.includes('/v2/verify/job-1')) return json({ isJobCompleted: true, contract: { match: null }, error: { customCode: 'already_verified', message: "The contract is already verified and the job didn't yield a better match." } });
    return json(explorerRow);
  };
  const source = await lookupContractSource('pol', ADDRESS, { runtimeCode, request, credentialsReader, useCache: false, importWaitMs: 0 });
  assert.equal(source.sourceProvider, 'etherscan');
  assert.deepEqual(source.evidence.map(item => [item.provider, item.outcome]), [['sourcify', 'different_bytecode'], ['etherscan', 'abi_only'], ['sourcify_import', 'rejected']]);
  assert.match(source.evidence[0].detail, /4 bytes .* versus 4 bytes/);
  assert.match(source.evidence[0].detail, /2024-08-08/);
  assert.equal(source.evidence[1].label, 'PolygonScan (Etherscan API)');
  assert.match(source.evidence[2].detail, /keeps serving the earlier version/);
  const post = calls.find(call => call.method === 'POST');
  assert.match(post.href, /\/v2\/verify\/etherscan\/137\/0x2222/);
  assert.ok(!String(post.body).includes('test-key'), 'our Etherscan key must never be sent to Sourcify');
  const provider = { getNetwork: async () => ({ chainId: 137n }), getCode: async () => runtimeCode, getStorage: async () => '0x' };
  const [target] = await inspectTargetCode(decodeCall({ to: ADDRESS, data: calldata, value: '0' }), 'pol', { provider, sourceLookup: () => source });
  assert.equal(target.status, 'explorer_abi');
  assert.match(target.reason, /Sourcify: Has a verified source .* different runtime bytecode/);
  assert.match(target.reason, /PolygonScan \(Etherscan API\): Verified source and ABI available/);
  assert.equal(target.sourceEvidence.length, 3);
});

test('a successful Sourcify import of the explorer source verifies the target', async () => {
  let imported = false;
  const request = async (url, options = {}) => {
    const href = String(url);
    if (href.includes('/v2/contract/')) return imported ? json({ match: 'match', runtimeMatch: 'match', runtimeBytecode: { onchainBytecode: runtimeCode }, abi: contractAbi }) : new Response('', { status: 404 });
    if (href.includes('/v2/verify/etherscan/')) return json({ verificationId: 'job-2' }, 202);
    if (href.includes('/v2/verify/job-2')) { imported = true; return json({ isJobCompleted: true, contract: { match: 'match', runtimeMatch: 'match' } }); }
    return json(explorerRow);
  };
  const source = await lookupContractSource('eth', '0x3333333333333333333333333333333333333333', { runtimeCode, request, credentialsReader, useCache: false, importWaitMs: 0 });
  assert.equal(source.runtimeBytecode.onchainBytecode, runtimeCode);
  assert.equal(source.importedFrom, 'Etherscan (Etherscan API)');
  assert.deepEqual(source.evidence.map(item => [item.provider, item.outcome]), [['sourcify', 'not_verified'], ['etherscan', 'abi_only'], ['sourcify_import', 'match']]);
});

test('rate limits and outages are reported as such, retried once, and not hidden', async () => {
  let sourcifyCalls = 0;
  const request = async url => {
    if (String(url).includes('/v2/contract/')) { sourcifyCalls++; return new Response('', { status: 429, headers: { 'retry-after': '0' } }); }
    return json({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' });
  };
  const result = await lookupContractSource('eth', '0x4444444444444444444444444444444444444444', { runtimeCode, request, credentialsReader, useCache: false, sourcifyImport: false });
  assert.equal(sourcifyCalls, 2);
  assert.equal(result.noSource, true);
  assert.deepEqual(result.evidence.map(item => [item.provider, item.outcome]), [['sourcify', 'rate_limited'], ['etherscan', 'rate_limited']]);
  assert.match(result.evidence[0].detail, /HTTP 429/);
});

test('missing explorer key is stated instead of reported as unverified', async () => {
  const request = async () => new Response('', { status: 404 });
  const result = await lookupContractSource('eth', '0x5555555555555555555555555555555555555555', { runtimeCode, request, credentialsReader: async () => ({}), useCache: false });
  assert.deepEqual(result.evidence.map(item => [item.provider, item.outcome]), [['sourcify', 'not_verified'], ['etherscan', 'not_configured']]);
});
