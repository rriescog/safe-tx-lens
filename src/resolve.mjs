import { analyze, analyzeHash } from './analyze.mjs';
import { parseInput } from './inputs.mjs';
import { fetchSafeTransactions, safeGet } from './safe-api.mjs';
import { analyzeExecutionHash, fetchRecentExecutions, findRecentExecutionBySafeHash, PUBLIC_RPC } from './onchain.mjs';
import { analyzeBuilderExport, isBuilderExport } from './builder.mjs';
import { analyzeMonitorStorage, isMonitorStorage } from './monitor-import.mjs';
import { fetchMonitorStorage, localCredentials } from './tenderly-storage.mjs';
import { CHAINS } from './chains.mjs';
import { findIndexedExecution } from './execution-index.mjs';

async function detectNetwork(parsed) {
  if (parsed.kind === 'json') {
    const id = parsed.transaction.chainId ?? parsed.transaction.transaction?.chainId;
    const chain = Object.entries(CHAINS).find(([, value]) => String(value) === String(id))?.[0];
    if (chain) return chain;
  } else {
    const snapshot = await fetchMonitorStorage().catch(() => null);
    let monitoredNetworks = [];
    if (snapshot) {
      const raw = snapshot.PENDING_TXN_DATA;
      const records = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const prefixes = { matic: 'pol', gnosis: 'gno' };
      const matches = Object.values(records ?? {}).filter(record => record && typeof record === 'object' && (
        parsed.kind === 'hash'
          ? record.detailedExecutionInfo?.safeTxHash?.toLowerCase() === parsed.hash.toLowerCase()
          : record.safeAddress?.toLowerCase() === parsed.address.toLowerCase()
      ));
      monitoredNetworks = [...new Set(matches.map(record => prefixes[record.prefix] ?? record.prefix).filter(prefix => Object.hasOwn(CHAINS, prefix)))];
      if (parsed.kind === 'hash' && monitoredNetworks.length === 1) return monitoredNetworks[0];
      if (parsed.kind === 'hash' && monitoredNetworks.length > 1) throw new Error('This hash appears on multiple networks in the monitor. Select the network explicitly.');
    }
    const hasSafeKey = Boolean((await localCredentials()).SAFE_API_KEY);
    if (parsed.kind === 'safe') {
      const networks = new Set(monitoredNetworks);
      if (hasSafeKey) {
        for (const network of Object.keys(CHAINS)) {
          try {
            const safe = await safeGet(network, `/safes/${parsed.address}/`);
            if (safe.address?.toLowerCase() === parsed.address.toLowerCase()) networks.add(network);
          } catch { /* No Safe on this chain, or its service is unavailable. */ }
          await new Promise(done => setTimeout(done, 220));
        }
      }
      if (networks.size === 1) return [...networks][0];
      if (networks.size > 1) return [...networks];
    }
    if (parsed.kind === 'hash') {
      for (const network of Object.keys(CHAINS)) {
        try { if (await findIndexedExecution(parsed.hash, network)) return network; }
        catch { /* This chain may be unsupported or temporarily unavailable in the index. */ }
      }
      if (hasSafeKey) {
        for (const network of Object.keys(CHAINS)) {
          try {
            const proposal = await safeGet(network, `/multisig-transactions/${parsed.hash}/`);
            if (proposal.safeTxHash?.toLowerCase() === parsed.hash.toLowerCase()) return network;
          } catch { /* Continue searching other chains. */ }
          await new Promise(done => setTimeout(done, 220));
        }
      }
    }
  }
  throw new Error('The hash or address does not reveal its network. No matching proposal or execution was found on supported chains. Select a network, or provide a Safe URL with chain prefix. Pending proposals require an accessible offchain source.');
}

async function monitorReports(network, options) {
  const snapshot = await fetchMonitorStorage();
  return snapshot ? analyzeMonitorStorage(snapshot, network, options) : null;
}

export async function resolve(input, network = 'eth', options = {}) {
  const parsed = parseInput(input, network);
  if (parsed.network === 'auto') {
    const detected = await detectNetwork(parsed);
    if (!Array.isArray(detected)) return resolve(input, detected, options);
    const results = await Promise.all(detected.map(chain => resolve(input, chain, options)));
    return {
      kind: 'queue', scope: options.scope ?? 'pending', source: 'multiple_networks',
      availability: results.some(result => result.availability === 'available') ? 'available' : 'unavailable',
      network: 'multiple', networks: detected, safe: parsed.address, safeState: null,
      truncated: results.some(result => result.truncated),
      warnings: [`This Safe address was found on ${detected.join(', ')}. Results show each transaction's network. Discovery is limited to configured sources and supported chains; use a Safe URL to inspect one chain.`, ...results.flatMap(result => result.warnings.map(warning => `${result.network}: ${warning}`))],
      reports: results.flatMap(result => result.reports), reviewedAt: new Date().toISOString(),
    };
  }
  const settings = { ...options, rpcUrl: options.rpcUrl ?? PUBLIC_RPC[parsed.network] };
  if (parsed.kind === 'hash') {
    let monitorFound = false;
    try {
      const monitor = await monitorReports(parsed.network, { ...settings, safeHash: parsed.hash, safeAddress: parsed.expectedSafe });
      monitorFound = Boolean(monitor);
      if (monitor?.reports.length) {
        const report = monitor.reports[0];
        if (settings.rpcUrl) {
          try {
            const executed = await findRecentExecutionBySafeHash(report.transaction.safe, report.hash, parsed.network, settings);
            if (executed) return executed;
          } catch { /* Keep the monitor report with its source warning. */ }
        }
        return report;
      }
    } catch { /* Continue with Safe services and onchain execution lookup. */ }
    try {
      const indexed = await findIndexedExecution(parsed.hash, parsed.network);
      if (indexed) {
        if (parsed.expectedSafe && indexed.safe.toLowerCase() !== parsed.expectedSafe.toLowerCase()) throw new Error('Indexed Safe address differs from the supplied Safe URL');
        const executed = await analyzeExecutionHash(indexed.executionHash, parsed.network, settings);
        if (executed.hash.toLowerCase() !== parsed.hash.toLowerCase() || executed.transaction.safe.toLowerCase() !== indexed.safe.toLowerCase()) throw new Error('Indexed execution does not match the requested Safe hash and address');
        return { ...executed, evidence: { ...executed.evidence, discoveredBy: 'etherscan_index' } };
      }
    } catch (error) {
      if (/differs|does not match/.test(error.message)) throw error;
    }
    try { return await analyzeHash(parsed.hash, parsed.network, { ...settings, expectedSafe: parsed.expectedSafe }); }
    catch (safeError) {
      if (settings.rpcUrl) {
        try { return await analyzeExecutionHash(parsed.hash, parsed.network, settings); }
        catch { /* A pending Safe hash cannot be recovered from an EVM RPC. */ }
      }
      if (safeError.message.includes('anonymous monthly quota exhausted')) {
        throw new Error(`${monitorFound ? 'Hash not found in the configured Tenderly monitor snapshot. ' : ''}No matching indexed execution was found. Safe API quota is exhausted, so this hash alone cannot reveal an unindexed pending proposal. Supply its transaction JSON or connect a proposal source that contains it.`);
      }
      throw new Error(`${safeError.message.replace(/\.+$/, '')}. For an offchain proposal without Safe API access, paste or import its transaction JSON. An RPC can only recover transactions already executed onchain.`);
    }
  }
  if (parsed.kind === 'json') return isMonitorStorage(parsed.transaction) ? analyzeMonitorStorage(parsed.transaction, parsed.network, settings) : isBuilderExport(parsed.transaction) ? analyzeBuilderExport(parsed.transaction, parsed.network, settings) : analyze(parsed.transaction, parsed.network, settings);
  const scope = options.scope ?? 'pending';
  if (!['pending', 'history', 'both'].includes(scope)) throw new Error('Invalid transaction scope');
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? 20)));
  const scopes = scope === 'both' ? ['pending', 'history'] : [scope];
  const reports = [];
  const warnings = [];
  let safe = null;
  let truncated = false;
  let source = 'safe_api';
  let sourceAvailable = false;
  for (const part of scopes) {
    if (part === 'pending') {
      try {
        const monitor = await monitorReports(parsed.network, { ...settings, safeAddress: parsed.address, limit });
        if (monitor?.reports.length) {
          for (const report of monitor.reports) {
            let executed = null;
            if (settings.rpcUrl) {
              try { executed = await findRecentExecutionBySafeHash(parsed.address, report.hash, parsed.network, settings); }
              catch (error) { warnings.push(`Could not cross-check nonce ${report.transaction.nonce} onchain: ${error.message}`); }
            }
            if (executed) {
              warnings.push(`Monitor snapshot is stale: nonce ${report.transaction.nonce} (${report.hash}) has executed onchain. Open executed history to review it.`);
            } else reports.push(report);
          }
          source = 'tenderly_monitor';
          sourceAvailable = true;
          truncated ||= monitor.truncated;
          warnings.push('Pending proposals come from the Tenderly monitor snapshot. Its last refresh time and completeness are not independently verified; Safe hash recalculation requires fields omitted by this snapshot.');
          warnings.push(...monitor.warnings);
          continue;
        }
      } catch (error) { warnings.push(`Tenderly monitor unavailable: ${error.message}`); }
    }
    try {
      const page = await fetchSafeTransactions(parsed.address, parsed.network, part, limit);
      safe = page.safe;
      source = page.source;
      sourceAvailable = true;
      truncated ||= page.truncated;
      for (const tx of page.transactions) {
        const report = await analyze(tx, parsed.network, { ...settings, safeInfo: page.safe });
        reports.push({ ...report, evidence: { source: page.source, retrievedAt: new Date().toISOString() } });
      }
    } catch (error) {
      if (part === 'history' && settings.rpcUrl) {
        const recent = await fetchRecentExecutions(parsed.address, parsed.network, { ...settings, limit });
        reports.push(...recent.reports);
        truncated = true;
        source = 'recent_rpc';
        sourceAvailable = true;
        warnings.push(`Safe API unavailable (${error.message}). RPC scanned blocks ${recent.fromBlock}–${recent.toBlock}; older history is not included.`);
      } else warnings.push(`${part} unavailable: ${error.message}`);
    }
  }
  return { kind: 'queue', scope, source: sourceAvailable ? source : 'unavailable', availability: sourceAvailable ? 'available' : 'unavailable', network: parsed.network, safe: parsed.address, safeState: safe ? { nonce: safe.nonce, threshold: safe.threshold, owners: safe.owners } : null, truncated, warnings, reports, reviewedAt: new Date().toISOString() };
}
