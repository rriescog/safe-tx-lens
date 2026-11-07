import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { decodeCall, enrichVerifiedCalls, summarizeCalls } from '../src/decode.mjs';
import { enrichTokenCalls } from '../src/token-metadata.mjs';

const token = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const erc20 = new Interface(['function transfer(address to,uint256 amount)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const call = () => decodeCall({ to: token, value: '0', operation: 0, data: erc20.encodeFunctionData('transfer', [recipient, 1234567n]) });

test('token call path uses bounded onchain symbol and decimals without claiming identity verification', async () => {
  const node = call();
  const requests = [];
  const provider = { getNetwork: async () => ({ chainId: 1n }), call: async request => {
    requests.push(request);
    return request.data === erc20.encodeFunctionData('symbol', []) ? erc20.encodeFunctionResult('symbol', ['TEST']) : erc20.encodeFunctionResult('decimals', [6]);
  } };
  await enrichTokenCalls(node, 'eth', { provider });
  assert.equal(requests.length, 2);
  assert.equal(node.token.amount, '1.234567');
  assert.match(node.token.source, /unverified token identity/);
  assert.match(summarizeCalls(node)[0].label, /Transfer 1.234567 TEST/);
});

test('wrong-chain or malformed token metadata cannot create a token identity', async () => {
  const wrong = call();
  await enrichTokenCalls(wrong, 'eth', { provider: { getNetwork: async () => ({ chainId: 137n }), call: async () => { throw new Error('should not call'); } } });
  assert.equal(wrong.token, undefined);
  const malformed = call();
  await enrichTokenCalls(malformed, 'eth', { provider: { getNetwork: async () => ({ chainId: 1n }), call: async request => request.data === erc20.encodeFunctionData('symbol', []) ? erc20.encodeFunctionResult('symbol', ['<script>']) : erc20.encodeFunctionResult('decimals', [6]) } });
  assert.equal(malformed.token, undefined);
});

test('unnamed verified ERC-20 ABI retains recipient and raw amount at the execution block', async () => {
  const node = call();
  enrichVerifiedCalls(node, [{ address: token, status: 'verified', source: 'verified source', verifiedFunctions: [{ selector: node.selector, abi: 'function transfer(address,uint256)' }] }]);
  assert.deepEqual(node.args.map(arg => arg.name), ['to', 'amount']);
  const requests = [];
  const provider = { getNetwork: async () => ({ chainId: 1n }), call: async request => {
    requests.push(request);
    return request.data === erc20.encodeFunctionData('symbol', []) ? erc20.encodeFunctionResult('symbol', ['DAI']) : erc20.encodeFunctionResult('decimals', [6]);
  } };
  await enrichTokenCalls(node, 'eth', { provider, blockTag: 123 });
  assert.deepEqual(requests.map(request => request.blockTag), [123, 123]);
  assert.equal(node.token.amount, '1.234567');
  assert.match(summarizeCalls(node)[0].label, /Transfer 1.234567 DAI to 0x3333/);
});

test('DAI-style dst and wad ABI names still identify the recipient and amount', async () => {
  const node = call();
  enrichVerifiedCalls(node, [{ address: token, status: 'verified', source: 'verified source', verifiedFunctions: [{ selector: node.selector, abi: 'function transfer(address dst,uint256 wad)' }] }]);
  assert.deepEqual(node.args.map(arg => arg.name), ['dst', 'wad']);
  const provider = { getNetwork: async () => ({ chainId: 1n }), call: async request => request.data === erc20.encodeFunctionData('symbol', []) ? erc20.encodeFunctionResult('symbol', ['DAI']) : erc20.encodeFunctionResult('decimals', [6]) };
  await enrichTokenCalls(node, 'eth', { provider });
  assert.equal(node.token.amount, '1.234567');
  assert.match(summarizeCalls(node)[0].label, /Transfer 1.234567 DAI to 0x3333/);
});
