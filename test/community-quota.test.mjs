import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { communityQuota } from '../src/community-quota.mjs';

test('MCP control messages have a separate bounded allowance without consuming inspection units', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-control-'));
  const file = join(directory, 'quota.json');
  let time = Date.parse('2026-11-09T12:00:00Z');
  try {
    const gate = communityQuota({ file, dailyUnits: 1, monthlyUnits: 1, clientDailyRequests: 1, now: () => time });
    for (let i = 0; i < 60; i++) assert.equal(gate.takeControl('203.0.113.1').allowed, true);
    assert.equal(gate.takeControl('203.0.113.1').reason, 'control_limit');
    assert.equal(gate.take('203.0.113.1', 1).allowed, true);
    gate.release();
    time += 60_000;
    assert.equal(gate.takeControl('203.0.113.1').allowed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('community budget limits each IP, survives restarts globally, and resets on UTC boundaries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-quota-'));
  const file = join(directory, 'quota.json');
  let time = Date.parse('2026-11-06T12:00:00Z');
  try {
    const gate = communityQuota({ file, dailyUnits: 6, monthlyUnits: 9, clientDailyRequests: 2, now: () => time });
    assert.equal(gate.take('203.0.113.1', 2).allowed, true);
    assert.equal(gate.take('203.0.113.2', 1).reason, 'busy');
    gate.release();
    assert.equal(gate.take('203.0.113.1', 2).allowed, true);
    gate.release();
    assert.equal(gate.take('203.0.113.1', 1).reason, 'client_limit');
    assert.ok(gate.take('203.0.113.1', 1).retryAfterSeconds > 0);
    assert.equal(gate.take('203.0.113.2', 2).allowed, true);
    gate.release();
    assert.equal(gate.take('203.0.113.3', 1).reason, 'daily_limit');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { day: '2026-11-06', month: '2026-11', dayUnits: 6, monthUnits: 6, monthSimulations: 0 });
    const restarted = communityQuota({ file, dailyUnits: 6, monthlyUnits: 9, now: () => time });
    assert.equal(restarted.take('203.0.113.4', 1).reason, 'daily_limit');
    time = Date.parse('2026-11-07T00:00:00Z');
    assert.equal(restarted.take('203.0.113.4', 3).allowed, true);
    restarted.release();
    assert.equal(restarted.take('203.0.113.5', 1).reason, 'monthly_limit');
    time = Date.parse('2026-12-01T00:00:00Z');
    assert.equal(restarted.take('203.0.113.5', 1).allowed, true);
    assert.doesNotMatch(JSON.stringify(JSON.parse(await readFile(file, 'utf8'))), /203\.0\.113/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('community quota rejects invalid configuration, malformed state, and spoofable identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-community-quota-invalid-'));
  const file = join(directory, 'quota.json');
  try {
    assert.throws(() => communityQuota({ file, dailyUnits: 0 }), /Invalid community quota/);
    const gate = communityQuota({ file });
    assert.equal(gate.take('not-an-ip', 1).reason, 'invalid_request');
    assert.equal(gate.take('203.0.113.1', 0).reason, 'invalid_request');
    await writeFile(file, '{');
    assert.throws(() => gate.take('203.0.113.1', 1), /quota state unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('simulation has its own per-IP and monthly budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'safe-sim-quota-'));
  const file = join(directory, 'quota.json');
  try {
    const gate = communityQuota({ file, dailyUnits: 100, monthlyUnits: 100, simulationClientDaily: 1, simulationMonthly: 2 });
    assert.equal(gate.take('203.0.113.1', 10, { simulation: true }).allowed, true);
    gate.release();
    assert.equal(gate.take('203.0.113.1', 10, { simulation: true }).reason, 'simulation_client_limit');
    assert.equal(gate.take('203.0.113.2', 10, { simulation: true }).allowed, true);
    gate.release();
    assert.equal(gate.take('203.0.113.3', 10, { simulation: true }).reason, 'simulation_monthly_limit');
    assert.equal(gate.take('203.0.113.3', 1).allowed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
