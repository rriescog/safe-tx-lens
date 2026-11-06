import { readFileSync, renameSync, writeFileSync } from 'node:fs';

// This is a deliberately small, process-local gate backed by a durable file.
// Run one app replica on the VPS; several replicas need a shared atomic store.
export function publicQuota({ file, dailyLimit = 5, now = () => Date.now() }) {
  if (!file || !Number.isInteger(dailyLimit) || dailyLimit < 1) throw new Error('Invalid public quota configuration');
  let active = false;
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const read = () => {
    try {
      const record = JSON.parse(readFileSync(file, 'utf8'));
      return record.day === day() && Number.isInteger(record.used) && record.used >= 0 ? record.used : 0;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw new Error(`Public quota state unavailable: ${error.message}`);
    }
  };
  return {
    take() {
      if (active) return { allowed: false, reason: 'busy' };
      const used = read();
      if (used >= dailyLimit) return { allowed: false, reason: 'daily_limit' };
      // Reserve before upstream work so failed lookups still consume budget.
      // Atomic rename prevents a partial file after a process interruption.
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ day: day(), used: used + 1 }), { mode: 0o600 });
      renameSync(temporary, file);
      active = true;
      return { allowed: true, remaining: dailyLimit - used - 1 };
    },
    release() { active = false; },
  };
}
