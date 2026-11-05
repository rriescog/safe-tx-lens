import { isAddress } from 'ethers';
import { chainId } from './chains.mjs';
import { analyze, classifyIntent } from './analyze.mjs';
import { decodeCall, summarizeCalls } from './decode.mjs';
import { assessRisk } from './risk.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const PREFIX = { matic: 'pol', gnosis: 'gno' };

export function isMonitorStorage(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'PENDING_TXN_DATA')) return true;
  const entries = value?.PENDING_TXN_DATA ?? value;
  return entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).some(key => key.startsWith('multisig_'));
}

function storageEntries(value) {
  const entries = value.PENDING_TXN_DATA ?? value;
  return typeof entries === 'string' ? JSON.parse(entries) : entries;
}

function hasHashFields(info) {
  return info && ['nonce', 'safeTxGas', 'baseGas', 'gasPrice', 'gasToken', 'refundReceiver'].every(key => info[key] != null);
}

async function monitorTransaction(id, record, network) {
  const data = record?.txData;
  const info = record?.detailedExecutionInfo;
  const safe = record?.safeAddress;
  const to = data?.to?.value;
  const hash = info?.safeTxHash ?? id.match(/0x[0-9a-fA-F]{64}$/)?.[0];
  if (!isAddress(safe) || !isAddress(to) || !HASH.test(hash ?? '') || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data.hexData ?? '0x')) return null;
  const transaction = {
    safe, to, data: data.hexData ?? '0x', value: String(data.value ?? '0'), operation: Number(data.operation ?? 0), nonce: String(info.nonce ?? '?'),
    isExecuted: ['SUCCESS', 'FAILED'].includes(record.txStatus), isSuccessful: record.txStatus === 'SUCCESS' ? true : record.txStatus === 'FAILED' ? false : null,
    transactionHash: record.txHash ?? null, confirmations: (info.confirmations ?? []).map(c => ({ owner: c.signer?.value, signature: c.signature ?? null })),
  };
  if (hasHashFields(info)) {
    const complete = { ...transaction, safeTxHash: hash, safeTxGas: info.safeTxGas, baseGas: info.baseGas, gasPrice: info.gasPrice, gasToken: info.gasToken, refundReceiver: info.refundReceiver?.value ?? info.refundReceiver };
    return analyze(complete, network, { fetchState: false });
  }
  const call = decodeCall(transaction);
  const actions = summarizeCalls(call);
  const findings = classifyIntent(call);
  const checks = [{ name: 'Safe hash from Tenderly monitor', status: 'unverified', detail: 'Monitor storage omits Safe gas fields; this hash cannot be recalculated from the stored payload.' }];
  const risk = assessRisk({ call, actions, findings, effects: [], checks, simulation: null, transaction });
  return { network, chainId: chainId(network), hash, calculatedHash: null, status: findings.some(f => f.severity === 'critical') ? 'REVIEW' : 'INSPECT', risk, checks, transaction, safeState: null, call, actions, findings, simulation: null, effects: [], warnings: ['Imported from Tenderly monitor storage. Calldata is decoded locally, but this record lacks fields needed to verify its Safe hash independently.'], reviewedAt: new Date().toISOString() };
}

export async function analyzeMonitorStorage(value, network, options = {}) {
  const storage = storageEntries(value);
  if (!storage || typeof storage !== 'object' || Array.isArray(storage)) throw new Error('Tenderly monitor storage must contain a JSON object of transactions');
  if (options.safeHash && !HASH.test(options.safeHash)) throw new Error('Invalid Safe hash for monitor comparison');
  const filtered = Object.entries(storage).filter(([id, record]) => {
    if (!id.startsWith('multisig_') || !record || typeof record !== 'object') return false;
    const prefix = PREFIX[record.prefix] ?? record.prefix;
    return (!prefix || prefix === network) && (!options.safeAddress || record.safeAddress?.toLowerCase() === options.safeAddress.toLowerCase()) && (!options.safeHash || record.detailedExecutionInfo?.safeTxHash?.toLowerCase() === options.safeHash.toLowerCase());
  });
  const reports = [];
  let skipped = 0;
  for (const [id, record] of filtered.slice(0, options.limit ?? 20)) {
    const report = await monitorTransaction(id, record, network);
    if (report) reports.push(report); else skipped++;
  }
  const warnings = [];
  if (skipped) warnings.push(`${skipped} monitor record(s) contain only an ID or incomplete payload; they cannot be decoded until the action has fetched their details.`);
  if (options.safeHash && !filtered.length) warnings.push('The supplied Safe hash was not found in this monitor snapshot. The snapshot may be stale or filtered to another Safe.');
  if (!reports.length) warnings.push('No complete monitor transaction records matched this network and Safe address.');
  return { kind: 'queue', scope: 'pending', source: 'tenderly_storage', availability: reports.length ? 'available' : 'unavailable', network, safe: options.safeAddress ?? (new Set(reports.map(r => r.transaction.safe)).size === 1 ? reports[0]?.transaction.safe : 'Multiple Safes'), safeState: null, truncated: filtered.length > (options.limit ?? 20), warnings, reports, reviewedAt: new Date().toISOString() };
}
