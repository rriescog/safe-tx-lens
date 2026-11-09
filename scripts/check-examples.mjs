#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from '../src/resolve.mjs';

// This is an explicit live smoke check, not a CI gate. It makes at most one
// inspection per catalog network and does not request Tenderly simulation.
const catalog = JSON.parse(await readFile(new URL('../web/network-examples.json', import.meta.url), 'utf8'));
if (!process.argv.includes('--live')) {
  console.error(`Dry run: ${catalog.networks.filter(row => row.examples.length).length} Safe lookups, one per network. Pass --live to query upstream services.`);
} else {
  let failures = 0;
  for (const row of catalog.networks) {
    const sample = row.examples[0];
    if (!sample) {
      console.log(JSON.stringify({ network: row.network, result: 'no_example' }));
      continue;
    }
    try {
      const report = await resolve(sample.hash, row.network, { verifyTargets: true, decodeCandidates: true, simulate: false });
      console.log(JSON.stringify({
        network: row.network,
        result: 'inspected',
        score: report.confidence?.score ?? null,
        rpcHashCheck: report.checks?.find(check => check.method === 'onchain_rpc')?.status ?? 'absent',
        targetCode: report.targetChecks?.map(check => check.status) ?? [],
        pendingChecks: report.confidence?.gaps?.map(gap => gap.kind) ?? [],
      }));
    } catch (error) {
      failures++;
      console.log(JSON.stringify({ network: row.network, result: 'failed', reason: String(error.message).slice(0, 200) }));
    }
  }
  // A failed public RPC can leave ethers provider retry timers alive even
  // after the inspection resolved. The one-shot smoke check must terminate.
  process.exit(failures ? 1 : 0);
}
