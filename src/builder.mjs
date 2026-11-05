import { getAddress, isAddress } from 'ethers';
import { chainId } from './chains.mjs';
import { decodeCall, summarizeCalls } from './decode.mjs';
import { classifyIntent } from './analyze.mjs';
import { assessRisk } from './risk.mjs';
import { fetchTransaction } from './safe-api.mjs';
import { analyze } from './analyze.mjs';
import { findRecentExecutionBySafeHash } from './onchain.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function isBuilderExport(value) {
  return value && typeof value === 'object' && Array.isArray(value.transactions) && value.meta && value.chainId;
}

function normalizeCall(value) {
  if (!isAddress(value?.to) || !/^\d+$/.test(String(value.value ?? '0')) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data ?? '0x')) throw new Error('Builder export contains an invalid transaction');
  return { to: getAddress(value.to), value: String(value.value ?? '0'), data: value.data ?? '0x', operation: Number(value.operation ?? 0) };
}

export function compareCalls(builderCalls, report) {
  // Builder metadata has no Safe nonce or gas fields. Compare the actual
  // top-level operations byte-for-byte after retrieving a real Safe tx.
  const actual = report.call.method === 'multiSend(bytes)' ? report.call.children : [report.call];
  if (actual.length !== builderCalls.length) return { status: 'mismatch', detail: `Builder has ${builderCalls.length} top-level calls; Safe transaction has ${actual.length}.` };
  for (let i = 0; i < actual.length; i++) {
    const expected = builderCalls[i];
    const observed = actual[i];
    if (expected.to.toLowerCase() !== observed.to.toLowerCase() || BigInt(expected.value) !== BigInt(observed.value) || expected.data.toLowerCase() !== observed.data.toLowerCase() || expected.operation !== observed.operation) {
      return { status: 'mismatch', detail: `Top-level call ${i + 1} differs in target, value, operation, or calldata.` };
    }
  }
  return { status: 'match', detail: 'Builder calls match the recovered Safe transaction exactly, in order.' };
}

export async function analyzeBuilderExport(exported, network, options = {}) {
  // An export is a plan until the optional Safe hash comparison succeeds.
  if (String(exported.chainId) !== String(chainId(network))) throw new Error(`Builder export is for chain ${exported.chainId}; selected network is ${network} (${chainId(network)}).`);
  if (!exported.transactions.length || exported.transactions.length > 100) throw new Error('Builder export needs 1–100 transactions');
  const calls = exported.transactions.map(normalizeCall);
  const metaSafe = exported.meta?.createdFromSafeAddress;
  const safe = options.safeAddress || metaSafe || null;
  if (safe && !isAddress(safe)) throw new Error('Invalid Safe address for Builder export');
  const warnings = [];
  if (options.safeAddress && metaSafe && options.safeAddress.toLowerCase() !== metaSafe.toLowerCase()) warnings.push('Entered Safe address differs from the Builder export metadata. Verify which Safe will execute this batch.');
  const decoded = calls.map(call => decodeCall(call));
  const actions = decoded.flatMap((call, index) => summarizeCalls(call).map(action => ({ ...action, path: `${index + 1}.${action.path}` })));
  const findings = decoded.flatMap((call, index) => classifyIntent(call).map(finding => ({ ...finding, path: `${index + 1}.${finding.path}` })));
  const risk = assessRisk({ call: { method: null, children: [] }, actions, findings, effects: [], checks: [], simulation: null, transaction: { operation: 0, isExecuted: false } });
  const expectedHash = options.safeHash?.trim() || null;
  if (expectedHash && !HASH.test(expectedHash)) throw new Error('Safe transaction hash must be 0x followed by 64 hex characters');
  let comparison = { status: 'not_requested', detail: 'This Builder export has no nonce or Safe gas fields, so it cannot determine a Safe transaction hash by itself.' };
  if (expectedHash) {
    let report;
    try {
      const raw = await fetchTransaction(expectedHash, network);
      report = await analyze(raw, network, options);
    } catch (apiError) {
      try { if (safe) report = await findRecentExecutionBySafeHash(safe, expectedHash, network, options); }
      catch (rpcError) { warnings.push(`Onchain hash lookup unavailable: ${rpcError.message}`); }
      if (!report) comparison = { status: 'unavailable', detail: `Could not retrieve Safe transaction ${expectedHash}. Safe API: ${apiError.message}. Recent RPC search found no execution; queued proposals need Safe API access or complete transaction JSON.` };
    }
    if (report) {
      if (report.hash.toLowerCase() !== expectedHash.toLowerCase() || report.checks[0]?.status !== 'pass') comparison = { status: 'mismatch', detail: 'Recovered Safe transaction hash failed independent EIP-712 verification.' };
      else if (safe && report.transaction.safe.toLowerCase() !== safe.toLowerCase()) comparison = { status: 'mismatch', detail: 'Recovered transaction belongs to a different Safe address.' };
      else comparison = { ...compareCalls(calls, report), safeHash: report.hash, nonce: report.transaction.nonce, executionHash: report.transaction.transactionHash };
    }
  }
  return { kind: 'builder', network, chainId: chainId(network), name: exported.meta?.name ?? 'Safe Transaction Builder export', safe, expectedHash, calls: decoded, actions, findings, risk, comparison, warnings, reviewedAt: new Date().toISOString() };
}
