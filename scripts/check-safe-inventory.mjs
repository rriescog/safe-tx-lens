#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { getAddress } from 'ethers';
import { fetchSafeTransactions } from '../src/safe-api.mjs';
import { analyze } from '../src/analyze.mjs';

// Read an existing inventory in memory. No transaction bodies or credentials
// are written to disk; the command only prints the per-Safe verification result.
const [inventoryPath, requestedCount = '20', requestedNetworks] = process.argv.slice(2);
if (!inventoryPath || !/^\d+$/.test(requestedCount) || Number(requestedCount) < 1) {
  console.error('Usage: node scripts/check-safe-inventory.mjs <inventory.json> [count] [network,network...]');
  process.exitCode = 2;
} else {
  const chain = new Map([[1, 'eth'], [100, 'gno'], [137, 'pol'], [42161, 'arb1'], [10, 'oeth'], [8453, 'base'], [11155111, 'sep'], [1101, 'zkevm'], [56, 'bnb'], [43114, 'avax']]);
  const networks = requestedNetworks ? new Set(requestedNetworks.split(',')) : null;
  if (networks && [...networks].some(network => ![...chain.values()].includes(network))) throw new Error('Unknown network filter');
  const document = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const items = Array.isArray(document) ? document : document.safes;
  if (!Array.isArray(items)) throw new Error('Inventory must be an array or an object with a safes array');
  const supported = items.filter(item => chain.has(Number(item.chain_id)) && (!networks || networks.has(chain.get(Number(item.chain_id)))));
  const priority = item => /Protocol Council|AggLayer Rollup Multisig|Polygon_Security_Multisig|Polygon_Engineering_Multisig/i.test(item.name ?? '');
  const selected = [...supported.filter(priority), ...supported.filter(item => !priority(item))].slice(0, Number(requestedCount));
  if (selected.length !== Number(requestedCount)) throw new Error(`Inventory has only ${selected.length} supported multisigs`);
  let passed = 0;
  let failed = 0;
  let decoded = 0;
  for (const [index, item] of selected.entries()) {
    const network = chain.get(Number(item.chain_id));
    const safe = getAddress(item.address);
    const statuses = [];
    for (const scope of ['pending', 'history']) {
      try {
        const page = await fetchSafeTransactions(safe, network, scope, 1);
        if (page.transactions.length) {
          const report = await analyze(page.transactions[0], network, { verifyTargets: false, fetchState: false, safeInfo: page.safe });
          if (report.checks[0].status !== 'pass') throw new Error(`Local Safe hash check: ${report.checks[0].status}`);
          if (report.transaction.safe.toLowerCase() !== safe.toLowerCase()) throw new Error('Safe address mismatch');
          decoded++;
          statuses.push(`${scope}:hash-pass/${report.status}`);
        } else statuses.push(`${scope}:empty`);
        passed++;
      } catch (error) {
        failed++;
        statuses.push(`${scope}:ERROR ${error.message.slice(0, 120)}`);
      }
    }
    console.log(`${index + 1}/${selected.length} ${network} ${item.name ?? safe}: ${statuses.join(' · ')}`);
  }
  console.log(JSON.stringify({ safes: selected.length, scopeChecks: passed + failed, passed, failed, decoded }));
  if (failed) process.exitCode = 1;
}
