import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';

// One process owns this durable budget. Client IPs are salted and retained
// only in memory for the current day; the quota file contains aggregate units.
export function communityQuota({ file, dailyUnits = 600, monthlyUnits = 10000, clientDailyRequests = 20, simulationClientDaily = 3, simulationMonthly = 100, now = () => Date.now() }) {
  if (!file || ![dailyUnits, monthlyUnits, clientDailyRequests, simulationClientDaily, simulationMonthly].every(value => Number.isInteger(value) && value > 0)) throw new Error('Invalid community quota configuration');
  const salt = randomBytes(16);
  const clients = new Map();
  const controlClients = new Map();
  let active = false;
  const date = () => new Date(now()).toISOString().slice(0, 10);
  const retryAfter = () => Math.max(1, Math.ceil((Date.parse(`${date()}T00:00:00Z`) + 86400000 - now()) / 1000));
  const monthRetryAfter = () => { const [year, month] = date().split('-').map(Number); return Math.max(1, Math.ceil((Date.UTC(year, month, 1) - now()) / 1000)); };
  function read() {
    let record;
    try { record = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { day: date(), month: date().slice(0, 7), dayUnits: 0, monthUnits: 0, monthSimulations: 0 };
      throw new Error('Community quota state unavailable');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(record?.day) || !/^\d{4}-\d{2}$/.test(record?.month) || !Number.isInteger(record.dayUnits) || record.dayUnits < 0 || !Number.isInteger(record.monthUnits) || record.monthUnits < 0 || !Number.isInteger(record.monthSimulations ?? 0) || (record.monthSimulations ?? 0) < 0) throw new Error('Community quota state unavailable');
    return { day: date(), month: date().slice(0, 7), dayUnits: record.day === date() ? record.dayUnits : 0, monthUnits: record.month === date().slice(0, 7) ? record.monthUnits : 0, monthSimulations: record.month === date().slice(0, 7) ? record.monthSimulations ?? 0 : 0 };
  }
  return {
    // MCP initialize, ping, and tool discovery never contact upstream APIs.
    // Give them a separate short window so clients can reconnect after their
    // inspection allowance is exhausted, while bounding reconnect floods.
    takeControl(clientIp) {
      if (!isIP(clientIp)) return { allowed: false, reason: 'invalid_request' };
      const minute = Math.floor(now() / 60_000);
      const key = createHash('sha256').update(salt).update(clientIp).digest('hex');
      const previous = controlClients.get(key);
      const used = previous?.minute === minute ? previous.used : 0;
      if (used >= 60) return { allowed: false, reason: 'control_limit', retryAfterSeconds: Math.max(1, Math.ceil(((minute + 1) * 60_000 - now()) / 1000)) };
      if (controlClients.size >= 10_000) {
        for (const [identity, record] of controlClients) if (record.minute !== minute) controlClients.delete(identity);
        if (controlClients.size >= 10_000 && !controlClients.has(key)) return { allowed: false, reason: 'busy', retryAfterSeconds: 2 };
      }
      controlClients.set(key, { minute, used: used + 1 });
      return { allowed: true };
    },
    take(clientIp, cost, { simulation = false } = {}) {
      if (!isIP(clientIp) || !Number.isInteger(cost) || cost < 1 || cost > dailyUnits) return { allowed: false, reason: 'invalid_request' };
      if (active) return { allowed: false, reason: 'busy', retryAfterSeconds: 2 };
      const day = date();
      const clientKey = createHash('sha256').update(salt).update(clientIp).digest('hex');
      const client = clients.get(clientKey);
      if (client?.day === day && client.used >= clientDailyRequests) return { allowed: false, reason: 'client_limit', retryAfterSeconds: retryAfter() };
      if (simulation && client?.day === day && client.simulations >= simulationClientDaily) return { allowed: false, reason: 'simulation_client_limit', limit: simulationClientDaily, retryAfterSeconds: retryAfter() };
      const record = read();
      if (record.dayUnits + cost > dailyUnits) return { allowed: false, reason: 'daily_limit', retryAfterSeconds: retryAfter() };
      if (record.monthUnits + cost > monthlyUnits) return { allowed: false, reason: 'monthly_limit', retryAfterSeconds: monthRetryAfter() };
      if (simulation && record.monthSimulations >= simulationMonthly) return { allowed: false, reason: 'simulation_monthly_limit', retryAfterSeconds: monthRetryAfter() };
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ day, month: day.slice(0, 7), dayUnits: record.dayUnits + cost, monthUnits: record.monthUnits + cost, monthSimulations: record.monthSimulations + Number(simulation) }), { mode: 0o600 });
      renameSync(temporary, file);
      clients.set(clientKey, { day, used: client?.day === day ? client.used + 1 : 1, simulations: (client?.day === day ? client.simulations ?? 0 : 0) + Number(simulation) });
      active = true;
      return { allowed: true };
    },
    release() { active = false; },
  };
}
