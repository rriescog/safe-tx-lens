import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/analyze.mjs';

const SAFE = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';
const transaction = { safe: SAFE, to: TARGET, value: '0', data: '0x', operation: 0, nonce: 7, safeTxGas: '0', baseGas: '0', gasPrice: '0', signatures: `0x${'11'.repeat(65)}` };
const safeInfo = { owners: [SAFE], threshold: 1, nonce: '7', source: 'safe_api' };
const outputTrue = `0x${'0'.repeat(63)}1`;

async function withTenderlyStub(response, run) {
  const previous = { fetch: globalThis.fetch, key: process.env.TENDERLY_ACCESS_KEY, account: process.env.TENDERLY_ACCOUNT, project: process.env.TENDERLY_PROJECT };
  process.env.TENDERLY_ACCESS_KEY = 'test-only-key';
  process.env.TENDERLY_ACCOUNT = 'test-account';
  process.env.TENDERLY_PROJECT = 'test-project';
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await run(requests); }
  finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [['TENDERLY_ACCESS_KEY', previous.key], ['TENDERLY_ACCOUNT', previous.account], ['TENDERLY_PROJECT', previous.project]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('simulation sends one exact Safe execution and exposes measured storage changes', async () => withTenderlyStub({
  simulation: { id: 'simulation-id' },
  transaction: { status: true, output: outputTrue, transaction_info: { state_diff: [
    { address: SAFE, soltype: { name: 'threshold' }, original: 1, dirty: 2 },
    { address: TARGET, raw: [{ key: `0x${'0'.repeat(64)}`, original: '0x01', dirty: '0x02' }] },
  ], asset_changes: [{ type: 'ERC20', token_address: TARGET, from: SAFE, to: TARGET, amount: '5' }] } },
}, async requests => {
  const report = await analyze(transaction, 'eth', { safeInfo, simulate: true });
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/account\/test-account\/project\/test-project\/simulate$/);
  assert.equal(requests[0].init.headers['X-Access-Key'], 'test-only-key');
  const submitted = JSON.parse(requests[0].init.body);
  assert.equal(submitted.to, SAFE);
  assert.match(submitted.input, /^0x6a761202/);
  assert.equal(submitted.network_id, '1');
  assert.equal(submitted.save, true);
  assert.equal(report.simulation.success, true);
  assert.equal(report.simulation.stateDiffAvailable, true);
  assert.equal(report.effects.length, 3);
  assert.ok(report.effects.some(effect => effect.kind === 'authority_or_control' && effect.label === 'threshold' && effect.before === '1' && effect.after === '2'));
  assert.ok(report.effects.some(effect => effect.kind === 'asset_transfer' && effect.amount === '5'));
  assert.equal(report.risk.reviewPriority, 'critical');
}));

test('simulation reports missing storage data instead of claiming no changes', async () => withTenderlyStub({
  transaction: { status: true, output: outputTrue, transaction_info: {} },
}, async () => {
  const report = await analyze(transaction, 'eth', { safeInfo, simulate: true });
  assert.equal(report.simulation.success, true);
  assert.equal(report.simulation.stateDiffAvailable, false);
  assert.deepEqual(report.effects, []);
}));

test('insufficient signatures and a failed hash prevent simulation requests', async () => withTenderlyStub({}, async requests => {
  const unsigned = await analyze({ ...transaction, signatures: null }, 'eth', { safeInfo: { ...safeInfo, threshold: 2 }, simulate: true });
  assert.match(unsigned.simulation.unavailable, /Insufficient standard EOA signatures/);
  const badHash = await analyze({ ...transaction, safeTxHash: `0x${'ff'.repeat(32)}` }, 'eth', { safeInfo, simulate: true });
  assert.match(badHash.simulation.unavailable, /hash verification failed/);
  assert.equal(badHash.status, 'BLOCK');
  assert.equal(requests.length, 0);
}));

test('historical simulation refuses to guess the transaction sender', async () => withTenderlyStub({}, async requests => {
  const report = await analyze({ ...transaction, isExecuted: true, transactionHash: `0x${'aa'.repeat(32)}` }, 'eth', { safeInfo, simulate: true });
  assert.match(report.simulation.unavailable, /Historical executor unknown/);
  assert.equal(requests.length, 0);
}));
