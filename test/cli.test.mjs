import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const SAFE = '0x1111111111111111111111111111111111111111';
const builder = JSON.stringify({ chainId: '1', meta: { name: 'Offline inspection' }, transactions: [{ to: SAFE, value: '0', data: '0x', operation: 0 }] });
function cli(...args) {
  return spawnSync(process.execPath, ['bin/safe-tx-lens.mjs', ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RPC_URL: '' } });
}
function cliStub(...args) {
  return spawnSync(process.execPath, ['--import', resolve('test/support/mock-safe-api.mjs'), 'bin/safe-tx-lens.mjs', ...args], { encoding: 'utf8', timeout: 10000, env: { ...process.env, SAFE_API_KEY: 'test-only-key', RPC_URL: '' } });
}

test('CLI help, validation errors, and unknown command exit cleanly', () => {
  assert.match(cli('help').stdout, /safe-tx-lens <inspect\|watch\|serve>/);
  assert.equal(cli('inspect').status, 1);
  assert.match(cli('inspect', '--network').stderr, /Missing value/);
  assert.match(cli('inspect', '--surprise').stderr, /Unknown option/);
  assert.match(cli('watch', builder).stderr, /watch needs a Safe/);
  assert.match(cli('serve', '--simulate').stderr, /open one transaction/);
  assert.match(cli('serve', '--public', '--port', '0').stderr, /public/i);
  assert.match(cli('other').stderr, /Unknown command/);
});

test('CLI inspects an offline Builder plan as text or machine readable JSON', () => {
  const plain = cli('inspect', builder, '--network', 'eth');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /Builder plan: Offline inspection/);
  assert.match(plain.stdout, /SAFE HASH/);
  const machine = cli('inspect', builder, '--json');
  assert.equal(machine.status, 0, machine.stderr);
  const report = JSON.parse(machine.stdout);
  assert.equal(report.kind, 'builder');
  assert.equal(report.calls.length, 1);
});

test('CLI prints one transaction, a Safe queue, and one watch poll from a stubbed source', () => {
  const txPath = '@examples/2026-11-05-pos-council-nonce-243-rejection.json';
  const report = cliStub('inspect', txPath, '--network', 'eth');
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /RISK/);
  assert.match(report.stdout, /SOURCE|DELEGATECALL|CALL/);
  const safe = '0xFa7D2a996aC6350f4b56C043112Da0366a59b74c';
  const queue = cliStub('inspect', safe, '--network', 'eth', '--scope', 'both');
  assert.equal(queue.status, 0, queue.stderr);
  assert.match(queue.stdout, /Safe .* transactions/);
  const watch = cliStub('watch', safe, '--network', 'eth', '--once');
  assert.equal(watch.status, 0, watch.stderr);
  assert.match(watch.stdout, /"hash"/);
});
