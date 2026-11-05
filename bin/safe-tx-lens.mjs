#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from '../src/resolve.mjs';
import { serve } from '../src/server.mjs';
import { parseInput } from '../src/inputs.mjs';
import { fetchTransaction } from '../src/safe-api.mjs';

function help() {
  console.log(`safe-tx-lens <inspect|watch|serve> [input] [options]

Inputs: Safe tx hash, onchain execution tx hash, Safe address, app.safe.global URL, or JSON file (@path)
Options:
  --network <auto|eth|gno|pol|arb1|oeth|base|sep|zkevm|bnb|avax>
  --rpc <url>          Verify against the Safe contract; historical simulation
  --simulate           Simulate with Tenderly when standard EOA signatures suffice
  --json               Machine-readable output
  --interval <seconds> Watch polling interval (minimum 15)
  --once               Watch one poll and exit
  --port <number>      Local UI port (default 4173)
  --scope <pending|history|both>  Safe address listing (default pending)
  --safe-address <address>  Safe address to use when checking Builder JSON
  --safe-hash <hash>      Compare Builder JSON with this Safe transaction hash

Environment: SAFE_API_KEY, TENDERLY_ACCESS_KEY, TENDERLY_ACCOUNT, TENDERLY_PROJECT, TENDERLY_MONITOR_ENV_FILE, RPC_URL
`);
}

function args(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--network', '--rpc', '--interval', '--port', '--scope', '--safe-address', '--safe-hash'].includes(arg)) {
      if (!argv[i + 1]) throw new Error(`Missing value for ${arg}`);
      result[arg.slice(2)] = argv[++i];
    } else if (['--simulate', '--json', '--once', '--help'].includes(arg)) result[arg.slice(2)] = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else result._.push(arg);
  }
  return result;
}

function printReport(result, json) {
  if (json) return console.log(JSON.stringify(result, null, 2));
  if (result.kind === 'builder') {
    console.log(`Builder plan: ${result.name} · Safe ${result.safe ?? 'not supplied'} · ${result.calls.length} top-level calls`);
    console.log(`  RISK ${result.risk.reviewPriority.toUpperCase()} review priority · ${result.risk.impactLevel.toUpperCase()} potential impact`);
    for (const action of result.risk.actionRatings) console.log(`  ${action.stage === 'schedule' ? 'SCHEDULE' : 'CALL'} [${action.level.toUpperCase()}] ${action.label} → ${action.to}`);
    console.log(`  SAFE HASH ${result.comparison.status.toUpperCase()}: ${result.comparison.detail}`);
    for (const warning of result.warnings) console.log(`  WARNING ${warning}`);
    return;
  }
  const reports = result.kind === 'queue' ? result.reports : [result];
  if (result.kind === 'queue') {
    console.log(`Safe ${result.safe} · ${result.availability === 'unavailable' ? 'SOURCE UNAVAILABLE' : `${reports.length} ${result.scope} transactions`} · ${result.networks?.join(', ') ?? result.network}${result.truncated ? ' · more transactions available' : ''}`);
    for (const warning of result.warnings ?? []) console.log(`  WARNING ${warning}`);
  }
  for (const report of reports) {
    console.log(`\n${report.status} ${report.hash} (${report.network})`);
    if (report.evidence?.source) console.log(`  SOURCE ${report.evidence.source}${report.evidence.retrievedAt ? ` · retrieved ${report.evidence.retrievedAt}` : ''}`);
    console.log(`  RISK ${report.risk.reviewPriority.toUpperCase()} review priority · ${report.risk.impactLevel.toUpperCase()} potential impact (${report.risk.basis})`);
    for (const action of report.risk.actionRatings) console.log(`  ${action.stage === 'schedule' ? 'SCHEDULE' : 'CALL'} [${action.level.toUpperCase()}] ${action.label} → ${action.to}`);
    for (const reason of report.risk.reasons.filter(item => !/^(Called|Scheduled):/.test(item.message))) console.log(`  RISK REASON ${reason.message}`);
    console.log(`  ${report.transaction.operation === 1 ? 'DELEGATECALL' : 'CALL'} ${report.transaction.to} · ${report.transaction.value} wei · nonce ${report.transaction.nonce}`);
    console.log(`  ${report.call.method ?? report.call.selector}${report.call.children.length ? ` · ${report.call.children.length} inner calls` : ''}`);
    for (const check of report.checks) console.log(`  ${check.status.toUpperCase()} ${check.name}: ${check.detail}`);
    for (const finding of report.findings) console.log(`  ${finding.severity.toUpperCase()} ${finding.code} ${finding.path}: ${finding.message}`);
    for (const effect of report.effects) console.log(`  EFFECT ${effect.kind} ${effect.address} ${effect.label ?? ''}: ${effect.before} → ${effect.after}${effect.amount ? ` amount ${effect.amount}` : ''}`);
    if (report.simulation) console.log(`  Simulation: ${report.simulation.unavailable ?? (report.simulation.success === true ? 'Safe execution succeeded' : report.simulation.success === false ? 'Safe execution failed' : 'EVM completed; Safe inner result unverified')}${report.simulation.url ? ` ${report.simulation.url}` : ''}`);
    for (const warning of report.warnings) console.log(`  WARNING ${warning}`);
  }
}

async function watch(input, network, options, interval, once) {
  const parsed = parseInput(input, network);
  if (parsed.kind !== 'safe') throw new Error('watch needs a Safe address or Safe URL');
  const seen = new Map();
  const poll = async () => {
    const queue = await resolve(parsed.address, parsed.network, { ...options, scope: 'pending', limit: 100 });
    if (queue.availability === 'unavailable') throw new Error(queue.warnings.join('; '));
    const current = new Set(queue.reports.map(report => report.hash));
    for (const hash of [...seen.keys()]) {
      if (current.has(hash)) continue;
      let tx;
      try { tx = await fetchTransaction(hash, parsed.network); }
      catch { seen.delete(hash); continue; }
      if (tx.isExecuted) {
        const report = await resolve(tx, parsed.network, options);
        printReport(report, true);
        seen.delete(hash);
      } else if (queue.safeState?.nonce != null && BigInt(tx.nonce) < BigInt(queue.safeState.nonce)) {
        console.log(JSON.stringify({ event: 'superseded', hash, network: parsed.network, safe: parsed.address, nonce: tx.nonce }));
        seen.delete(hash);
      }
    }
    for (const report of queue.reports) {
      const fingerprint = JSON.stringify([report.hash, report.transaction.confirmations?.length, report.transaction.isExecuted]);
      if (seen.get(report.hash) === fingerprint) continue;
      seen.set(report.hash, fingerprint);
      printReport(report, true);
    }
    if (queue.truncated) console.error('Queue exceeds first 100 proposals; pagination is not monitored.');
  };
  do {
    try { await poll(); } catch (error) { console.error(`Watch poll failed: ${error.message}`); if (once) throw error; }
    if (once) break;
    await new Promise(r => setTimeout(r, Math.max(15, interval) * 1000));
  } while (true);
}

try {
  const [command, ...rest] = process.argv.slice(2);
  const flags = args(rest);
  if (!command || flags.help || command === 'help') help();
  else if (command === 'serve') await serve({ port: Number(flags.port ?? 4173), rpcUrl: flags.rpc ?? process.env.RPC_URL, simulate: flags.simulate });
  else if (command === 'inspect' || command === 'watch') {
    if (!flags._[0]) throw new Error(`${command} needs an input`);
    let input = flags._[0];
    if (input.startsWith('@')) input = JSON.parse(await readFile(input.slice(1), 'utf8'));
    const options = { rpcUrl: flags.rpc ?? process.env.RPC_URL, simulate: flags.simulate, scope: flags.scope, safeAddress: flags['safe-address'], safeHash: flags['safe-hash'] };
    if (command === 'inspect') printReport(await resolve(input, flags.network ?? (typeof input === 'string' && /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(input) ? 'auto' : 'eth'), options), flags.json);
    else await watch(input, flags.network ?? 'eth', options, Number(flags.interval ?? 30), flags.once);
  } else throw new Error(`Unknown command ${command}`);
} catch (error) {
  console.error(`safe-tx-lens: ${error.message}`);
  process.exitCode = 1;
}
