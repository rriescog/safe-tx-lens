import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
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
  assert.match(report.stdout, /EXECUTION EXECUTION NOT ESTABLISHED/);
  assert.match(report.stdout, /SOURCE|DELEGATECALL|CALL/);
  assert.match(report.stdout, /\[local_eip712\]/);
  const safe = '0xFa7D2a996aC6350f4b56C043112Da0366a59b74c';
  const queue = cliStub('inspect', safe, '--network', 'eth', '--scope', 'both');
  assert.equal(queue.status, 0, queue.stderr);
  assert.match(queue.stdout, /Safe .* transactions/);
  const watch = cliStub('watch', safe, '--network', 'eth', '--once');
  assert.equal(watch.status, 0, watch.stderr);
  assert.match(watch.stdout, /"hash"/);
});

test('CLI watch reports execution and nonce supersession after a proposal leaves the queue', () => {
  const safe = '0xFa7D2a996aC6350f4b56C043112Da0366a59b74c';
  for (const outcome of ['executed', 'superseded']) {
    const result = spawnSync(process.execPath, ['--import', resolve('test/support/watch-flow.mjs'), 'bin/safe-tx-lens.mjs', 'watch', safe, '--network', 'eth', '--interval', '15'], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, TEST_WATCH_OUTCOME: outcome, SAFE_API_KEY: 'test-only-key', RPC_URL: '' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, outcome === 'executed' ? /"isExecuted":\s*true/ : /"event":"superseded"/);
  }
});

test('CLI serve starts the local UI on a random port', async () => {
  const child = spawn(process.execPath, ['bin/safe-tx-lens.mjs', 'serve', '--port', '0'], {
    env: { ...process.env, RPC_URL: '' },
  });
  let out = '';
  try {
    await new Promise((resolveStarted, rejectStarted) => {
      const timer = setTimeout(() => rejectStarted(new Error(`Timed out waiting for the startup banner. Output so far: ${out}`)), 10000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        out += chunk;
        if (/Safe Tx Lens: http:\/\/127\.0\.0\.1:/.test(out)) { clearTimeout(timer); resolveStarted(); }
      });
      child.once('error', error => { clearTimeout(timer); rejectStarted(error); });
      child.once('exit', code => { clearTimeout(timer); rejectStarted(new Error(`CLI exited before printing the banner (code ${code}). Output: ${out}`)); });
    });
  } finally {
    child.kill('SIGKILL');
  }
  assert.match(out, /Safe Tx Lens: http:\/\/127\.0\.0\.1:/);
});
