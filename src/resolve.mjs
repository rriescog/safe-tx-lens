import { analyze, analyzeHash, executionStatusWithSource } from './analyze.mjs';
import { parseInput } from './inputs.mjs';
import { fetchSafeTransactions, safeGet } from './safe-api.mjs';
import { analyzeExecutionHash, contractPresence, discoverExecutionNetworks, fetchRecentExecutions, findRecentExecutionBySafeHash, rpcDetailsFor } from './onchain.mjs';
import { analyzeBuilderExport, isBuilderExport } from './builder.mjs';
import { analyzeMonitorStorage, isMonitorStorage } from './monitor-import.mjs';
import { fetchMonitorStorage, localCredentials } from './tenderly-storage.mjs';
import { CHAINS, chainId } from './chains.mjs';
import { findIndexedExecution } from './execution-index.mjs';

// Testnets are available by explicit selection, but automatic hash/address
// discovery stays on production chains to bound latency and API usage.
const AUTO_NETWORKS = Object.keys(CHAINS).filter(network => !['sep', 'amoy', 'imx'].includes(network));

async function detectNetwork(parsed, options = {}) {
  // Neither a 32-byte hash nor a 20-byte address contains a chain ID. Every
  // inferred network below must come from a source that actually saw it.
  if (parsed.kind === 'json') {
    const id = parsed.transaction.chainId ?? parsed.transaction.transaction?.chainId;
    const chain = Object.entries(CHAINS).find(([, value]) => String(value) === String(id))?.[0];
    if (chain) return chain;
    // JSON can carry a valid chain ID even when this chain has no named UI
    // integration. The local EIP-712 calculation needs no Safe index or RPC.
    if (id !== undefined) {
      try { chainId(String(id)); return String(id); } catch { /* Invalid or unsafe chain ID. */ }
    }
  } else {
    const snapshot = options.monitorFallback === true ? await fetchMonitorStorage().catch(() => null) : null;
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
        for (const network of AUTO_NETWORKS) {
          try {
            const safe = await safeGet(network, `/safes/${parsed.address}/`);
            if (safe.address?.toLowerCase() === parsed.address.toLowerCase()) networks.add(network);
          } catch { /* No Safe on this chain, or its service is unavailable. */ }
          await new Promise(done => setTimeout(done, 220));
        }
      }
      if (networks.size === 1) return [...networks][0];
      // The same Safe address may be deployed on several chains. Return every
      // observed match and let the UI ask which network the reviewer wants.
      if (networks.size > 1) return [...networks];
    }
    if (parsed.kind === 'hash') {
      const executionNetworks = await discoverExecutionNetworks(parsed.hash, AUTO_NETWORKS, options);
      if (executionNetworks.length === 1) return { network: executionNetworks[0], source: 'execution_receipt' };
      if (executionNetworks.length > 1) throw new Error(`Execution hash appeared on multiple networks (${executionNetworks.join(', ')}). Select the network explicitly.`);
      for (const network of AUTO_NETWORKS) {
        try { if (await findIndexedExecution(parsed.hash, network)) return network; }
        catch { /* This chain may be unsupported or temporarily unavailable in the index. */ }
      }
      if (hasSafeKey) {
        for (const network of AUTO_NETWORKS) {
          try {
            const proposal = await safeGet(network, `/multisig-transactions/${parsed.hash}/`);
            if (proposal.safeTxHash?.toLowerCase() === parsed.hash.toLowerCase()) return network;
          } catch { /* Continue searching other chains. */ }
          await new Promise(done => setTimeout(done, 220));
        }
      }
    }
  }
  throw new Error('The hash or address does not reveal its network. Available sources did not identify it; a provider outage or unsupported chain may also explain this. Select a network, or provide a Safe URL with chain prefix. Pending proposals require an accessible offchain source.');
}

async function monitorReports(network, options) {
  const snapshot = await fetchMonitorStorage();
  if (!snapshot) return null;
  const result = await analyzeMonitorStorage(snapshot, network, options);
  return { ...result, reports: result.reports.map(report => ({ ...report, evidence: { source: 'tenderly_monitor', retrievedAt: new Date().toISOString(), ...(options.safeHash ? { requestedHash: options.safeHash } : {}) } })) };
}

export async function resolve(input, network = 'eth', options = {}) {
  const parsed = parseInput(input, network);
  if (parsed.network === 'auto') {
    const detected = await detectNetwork(parsed, options);
    if (detected?.source === 'execution_receipt') {
      // The receipt proves this is an execution hash on the detected chain.
      // Safe Transaction Service expects a Safe transaction hash instead, so
      // querying it here wastes quota and can mask a transient RPC failure.
      const rpcProvenance = rpcDetailsFor(detected.network, options.rpcUrl);
      const settings = { ...options, rpcUrl: rpcProvenance.url, rpcProvenance, verifyTargets: options.verifyTargets ?? true, decodeCandidates: options.decodeCandidates ?? false, enrichTokens: options.enrichTokens ?? true };
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await (options.analyzeExecution ?? analyzeExecutionHash)(parsed.hash, detected.network, settings); }
        catch (error) {
          if (/RPC chain does not match|not a Safe execTransaction|Safe execution event with transaction hash was not found|Could not recover Safe nonce/.test(error.message)) throw error;
        }
      }
      throw new Error('Onchain execution source unavailable after the Safe receipt identified its network. Retry shortly or configure a reliable RPC for that network locally.');
    }
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
  const rpcProvenance = rpcDetailsFor(parsed.network, options.rpcUrl);
  const settings = { ...options, rpcUrl: rpcProvenance.url, rpcProvenance, verifyTargets: options.verifyTargets ?? true, decodeCandidates: options.decodeCandidates ?? false, enrichTokens: options.enrichTokens ?? true };
  if (parsed.kind === 'hash') {
    let safeError;
    try { return await analyzeHash(parsed.hash, parsed.network, { ...settings, expectedSafe: parsed.expectedSafe }); }
    catch (error) {
      if (/Safe API returned a different hash|Safe URL address does not match/.test(error.message)) throw error;
      safeError = error;
    }
    // An indexed event is a discovery hint. The execution calldata, Safe
    // address, and recomputed Safe hash still have to match onchain.
    try {
      const indexed = await findIndexedExecution(parsed.hash, parsed.network);
      if (indexed) {
        if (parsed.expectedSafe && indexed.safe.toLowerCase() !== parsed.expectedSafe.toLowerCase()) throw new Error('Indexed Safe address differs from the supplied Safe URL');
        const executed = await analyzeExecutionHash(indexed.executionHash, parsed.network, settings);
        if (executed.hash.toLowerCase() !== parsed.hash.toLowerCase() || executed.transaction.safe.toLowerCase() !== indexed.safe.toLowerCase()) throw new Error('Indexed execution does not match the requested Safe hash and address');
        return { ...executed, evidence: { ...executed.evidence, discoveredBy: 'etherscan_index', requestedHash: parsed.hash } };
      }
    } catch (error) {
      if (/differs|does not match/.test(error.message)) throw error;
    }
    let monitorFound = false;
    if (options.monitorFallback === true) {
      try {
        const monitor = await monitorReports(parsed.network, { ...settings, safeHash: parsed.hash, safeAddress: parsed.expectedSafe });
        monitorFound = Boolean(monitor);
        if (monitor?.reports.length) {
          const report = monitor.reports[0];
          if (settings.rpcUrl) {
            try {
              const executed = await findRecentExecutionBySafeHash(report.transaction.safe, report.hash, parsed.network, settings);
              if (executed) return { ...executed, evidence: { ...executed.evidence, requestedHash: parsed.hash } };
            } catch { /* Keep the monitor report with its source warning. */ }
          }
          return { ...report, warnings: [`Safe services did not return this transaction (${safeError.message}). Explicit Tenderly monitor fallback supplied an incomplete record; its Safe hash cannot be verified. Do not sign based on this report alone.`, ...report.warnings] };
        }
      } catch { /* Continue with onchain execution lookup. */ }
    }
    if (settings.rpcUrl) {
      try { return await analyzeExecutionHash(parsed.hash, parsed.network, settings); }
      catch { /* A pending Safe hash cannot be recovered from an EVM RPC. */ }
    }
    if (safeError.message.includes('anonymous monthly quota exhausted')) {
      throw new Error(`${monitorFound ? 'Hash not found in the explicitly enabled Tenderly monitor snapshot. ' : ''}No matching indexed execution was found. Safe API quota is exhausted, so this hash alone cannot reveal an unindexed pending proposal. Supply its transaction JSON or use an authenticated Safe API key.`);
    }
    throw new Error(`${safeError.message.replace(/\.+$/, '')}. For an offchain proposal without Safe API access, paste or import its transaction JSON. An RPC can only recover transactions already executed onchain.`);
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
  let addressAbsent = false;
  const usedSources = new Set();
  for (const part of scopes) {
    try {
      const page = await fetchSafeTransactions(parsed.address, parsed.network, part, limit);
      safe = page.safe;
      source = page.source;
      usedSources.add(page.source);
      sourceAvailable = true;
      truncated ||= page.truncated;
      if (part === 'pending' && page.source === 'safe_api_untrusted') warnings.push('Showing unsigned 1/1 records from Safe Transaction Service. These records have no trusted owner signature; independently compare the complete fields and Safe hash before signing.');
      if (part === 'pending' && Number(page.safe?.threshold) === 1 && !page.transactions.length) warnings.push('No published 1/1 proposal was returned. If the first signature has not been submitted, import the complete Safe transaction JSON to review it before signing; a hash alone cannot reveal unindexed calldata.');
      for (const tx of page.transactions) {
        const report = await analyze(tx, parsed.network, { ...settings, verifyTargets: false, decodeCandidates: false, enrichTokens: false, safeInfo: page.safe });
        reports.push({ ...report, executionStatus: executionStatusWithSource(report, page.source), evidence: { source: page.source, retrievedAt: new Date().toISOString() } });
      }
    } catch (error) {
      if (error.message.includes('Safe API 404') && await contractPresence(parsed.address, parsed.network, { rpcUrl: settings.rpcUrl, fetchImpl: options.fetchImpl }) === 'absent') {
        addressAbsent = true;
        warnings.push(`No contract is deployed at ${parsed.address} on ${parsed.network} according to the selected RPC. Check the network in the Safe URL or choose another chain.`);
        continue;
      }
      if (part === 'pending' && options.monitorFallback === true) {
        try {
          const monitor = await monitorReports(parsed.network, { ...settings, safeAddress: parsed.address, limit });
          if (monitor?.reports.length) {
            for (const report of monitor.reports) {
              let executed = null;
              if (settings.rpcUrl) {
                try { executed = await findRecentExecutionBySafeHash(parsed.address, report.hash, parsed.network, settings); }
                catch (rpcError) { warnings.push(`Could not cross-check nonce ${report.transaction.nonce} onchain: ${rpcError.message}`); }
              }
              if (executed) warnings.push(`Monitor snapshot is stale: nonce ${report.transaction.nonce} (${report.hash}) has executed onchain. Open executed history to review it.`);
              else reports.push({ ...report, warnings: [`Safe services unavailable (${error.message}). This explicit monitor fallback cannot verify the Safe hash. Do not sign based on this report alone.`, ...report.warnings] });
            }
            source = 'tenderly_monitor';
            usedSources.add(source);
            sourceAvailable = true;
            truncated ||= monitor.truncated;
            warnings.push(`Safe services unavailable (${error.message}). Showing the explicitly enabled Tenderly monitor snapshot; it omits fields required to verify Safe transaction hashes.`);
            warnings.push(...monitor.warnings);
            continue;
          }
        } catch (monitorError) { warnings.push(`Tenderly monitor fallback unavailable: ${monitorError.message}`); }
      }
      if (part === 'history' && settings.rpcUrl) {
        const recent = await fetchRecentExecutions(parsed.address, parsed.network, { ...settings, limit });
        reports.push(...recent.reports);
        truncated = true;
        source = 'recent_rpc';
        usedSources.add(source);
        sourceAvailable = true;
        warnings.push(`Safe API unavailable (${error.message}). RPC scanned blocks ${recent.fromBlock}–${recent.toBlock}; older history is not included.`);
      } else warnings.push(`${part} unavailable: ${error.message}`);
    }
  }
  return { kind: 'queue', scope, source: sourceAvailable ? usedSources.size > 1 ? 'multiple_sources' : source : 'unavailable', availability: sourceAvailable ? 'available' : addressAbsent ? 'absent' : 'unavailable', network: parsed.network, safe: parsed.address, safeState: safe ? { nonce: safe.nonce, threshold: safe.threshold, owners: safe.owners } : null, truncated, warnings, reports, reviewedAt: new Date().toISOString() };
}
