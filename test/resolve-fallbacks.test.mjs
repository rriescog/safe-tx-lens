import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from '../src/resolve.mjs';

const tx = JSON.parse(await readFile('examples/2026-11-05-pos-council-nonce-243-rejection.json', 'utf8'));
const monitorRecord = (prefix = 'eth') => ({
  prefix, safeAddress: tx.safe, txStatus: 'AWAITING_CONFIRMATIONS',
  txData: { to: { value: tx.to }, value: tx.value, hexData: tx.data, operation: tx.operation },
  detailedExecutionInfo: { safeTxHash: tx.safeTxHash, nonce: tx.nonce, confirmations: [] },
});
const monitor = records => ({ PENDING_TXN_DATA: JSON.stringify(records) });
const noEtherscan = () => new Response(JSON.stringify({ status: '0', message: 'No records found', result: [] }), { status: 200 });

async function withSources({ records = {}, safePages = false } = {}, run) {
  const old = { fetch: globalThis.fetch, safe: process.env.SAFE_API_KEY, etherscan: process.env.ETHERSCAN_API_KEY, tenderly: process.env.TENDERLY_ACCESS_KEY, account: process.env.TENDERLY_ACCOUNT, project: process.env.TENDERLY_PROJECT };
  process.env.SAFE_API_KEY = 'resolve-test-key';
  process.env.ETHERSCAN_API_KEY = 'resolve-test-index-key';
  process.env.TENDERLY_ACCESS_KEY = 'resolve-test-monitor-key';
  process.env.TENDERLY_ACCOUNT = 'resolve-test-account';
  process.env.TENDERLY_PROJECT = 'resolve-test-project';
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('api.tenderly.co')) return new Response(JSON.stringify([{ key: 'PENDING_TXN_DATA', value: monitor(records).PENDING_TXN_DATA }]), { status: 200 });
    if (value.includes('api.etherscan.io')) return noEtherscan();
    if (value.includes('api.safe.global')) {
      if (!safePages) return new Response('unavailable', { status: 503 });
      if (value.endsWith(`/safes/${tx.safe}/`)) return new Response(JSON.stringify({ address: tx.safe, nonce: tx.nonce, threshold: 1, owners: [tx.safe] }), { status: 200 });
      if (value.includes(`/safes/${tx.safe}/multisig-transactions/`)) return new Response(JSON.stringify({ results: [tx], next: null }), { status: 200 });
      if (value.endsWith(`/multisig-transactions/${tx.safeTxHash}/`)) return new Response(JSON.stringify(tx), { status: 200 });
    }
    return new Response('unavailable', { status: 503 });
  };
  try { return await run(); }
  finally {
    globalThis.fetch = old.fetch;
    for (const [name, previous] of [['SAFE_API_KEY', old.safe], ['ETHERSCAN_API_KEY', old.etherscan], ['TENDERLY_ACCESS_KEY', old.tenderly], ['TENDERLY_ACCOUNT', old.account], ['TENDERLY_PROJECT', old.project]]) {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
}

test('monitor resolves an unknown Safe hash and an address before Safe service lookup', async () => withSources({ records: { multisig_first: monitorRecord() } }, async () => {
  const report = await resolve(tx.safeTxHash, 'auto', { rpcUrl: '', verifyTargets: false, fetchState: false });
  assert.equal(report.network, 'eth');
  assert.equal(report.hash, tx.safeTxHash);
  const queue = await resolve(tx.safe, 'eth', { rpcUrl: '', verifyTargets: false, fetchState: false });
  assert.equal(queue.source, 'tenderly_monitor');
  assert.equal(queue.reports.length, 1);
  assert.match(queue.warnings.join(' '), /snapshot/);
}));

test('ambiguous monitor chains never silently choose a network', async () => withSources({ records: { multisig_a: monitorRecord('eth'), multisig_b: monitorRecord('matic') } }, async () => {
  await assert.rejects(() => resolve(tx.safeTxHash, 'auto', { rpcUrl: '' }), /multiple networks/);
}));

test('Safe address can fetch both queue and history with source attribution', async () => withSources({ safePages: true }, async () => {
  const queue = await resolve(tx.safe, 'eth', { scope: 'both', limit: 1, rpcUrl: '', verifyTargets: false, fetchState: false });
  assert.equal(queue.availability, 'available');
  assert.equal(queue.source, 'safe_api');
  assert.equal(queue.reports.length, 2);
  assert.ok(queue.reports.every(report => report.evidence.source === 'safe_api'));
  assert.equal(queue.safeState.threshold, 1);
}));

test('failed queue sources are unavailable, while JSON chain detection stays offline', async () => withSources({}, async () => {
  const queue = await resolve(tx.safe, 'eth', { rpcUrl: '', verifyTargets: false });
  assert.equal(queue.availability, 'unavailable');
  assert.match(queue.warnings.join(' '), /pending unavailable/);
  const builder = { chainId: '1', meta: {}, transactions: [{ to: tx.to, value: '0', data: '0x' }] };
  const plan = await resolve(builder, 'auto', { rpcUrl: '' });
  assert.equal(plan.network, 'eth');
  await assert.rejects(() => resolve({ ...builder, chainId: '999999' }, 'auto'), /does not reveal its network/);
}));
