// Evidence coverage, never a probability that signing is safe. A failed hash
// check overrides every positive signal because the report may describe a
// different transaction altogether.
export function assessConfidence({ call, checks = [], targetChecks = [], simulation, transaction }) {
  const reasons = [];
  const gaps = [];
  if (checks.some(check => check.status === 'fail')) return { score: 0, color: 'red', label: 'Hash mismatch', reasons: ['A Safe hash check failed. Do not rely on this report for signing.'], gaps: [{ kind: 'hash_mismatch', title: 'Resolve the hash mismatch', points: 10, label: 'The supplied and calculated hashes disagree. Review the transaction fields before signing.' }] };
  let score = 1;
  const local = checks.find(check => check.method === 'local_eip712');
  if (local?.status === 'pass') { score += 3; reasons.push('Safe hash recomputed from complete transaction fields.'); }
  else { reasons.push('No independently supplied Safe hash to compare with the calculated hash.'); gaps.push({ kind: 'hash', title: 'Compare the Safe hash', points: 3, label: 'Compare the calculated hash with the exact hash on your signing device.' }); }
  const onchain = checks.find(check => check.method === 'onchain_rpc');
  if (onchain?.status === 'pass') { score += 2; reasons.push('Safe contract confirmed the hash via RPC.'); }
  else { reasons.push('Safe contract hash was not confirmed via RPC.'); gaps.push({ kind: 'rpc', title: 'Confirm the onchain hash', points: 2, label: 'Ask the Safe contract for its transaction hash through a working RPC.' }); }
  const nodes = [];
  const visit = node => { nodes.push(node); node.children?.forEach(visit); };
  visit(call);
  const meaningful = nodes.filter(node => node.data && node.data !== '0x');
  const decoded = meaningful.filter(node => node.method && !['selector_candidate', 'proxy_candidate_abi', 'explorer_abi'].includes(node.decodeBasis));
  if (meaningful.length && decoded.length === meaningful.length) { score += 1; reasons.push('Every call selector in the graph has been decoded.'); }
  else { const proxyCandidate = nodes.some(node => node.decodeBasis === 'proxy_candidate_abi'); reasons.push(meaningful.length ? `${meaningful.length - decoded.length} call selector(s) remain undecoded or unconfirmed by matched runtime bytecode; a 4byte, explorer-only, or inferred proxy ABI does not close this gap.` : 'No call selector was available to decode.'); gaps.push(proxyCandidate ? { kind: 'proxy', title: 'Confirm proxy forwarding', points: 1, label: 'The implementation ABI fits the calldata, but the proxy forwarding path has only been inferred. Inspect the verified proxy source.' } : { kind: 'decode', title: 'Confirm ABI against code', points: 1, label: 'Match each decoded selector to the runtime bytecode at the inspected block. Explorer-only ABI labels remain unconfirmed.' }); }
  const called = targetChecks.filter(target => target.selectors?.length);
  const verified = called.filter(target => ['verified', 'verified_current'].includes(target.status) && (!target.proxy || ['verified', 'verified_current'].includes(target.proxy.implementationCode?.status)));
  if (called.length && verified.length === called.length) { score += 2; reasons.push('Every called target with calldata has matching verified runtime bytecode.'); }
  else { reasons.push('Some called target bytecode has not been verified against source.'); gaps.push({ kind: 'bytecode', title: 'Check target bytecode', points: 2, label: 'Match each called contract and proxy implementation to verified source.' }); }
  if (simulation && !simulation.unavailable && simulation.success === true && simulation.stateDiffAvailable && simulation.mode !== 'conditional_threshold_override') { score += 1; reasons.push('A successful simulation returned a storage diff for one execution path.'); }
  else { reasons.push(simulation?.mode === 'conditional_threshold_override' ? 'Conditional preview used a temporary threshold override; it does not reproduce owner approval.' : 'No successful simulation with a storage diff was available.'); gaps.push({ kind: simulation?.mode === 'conditional_threshold_override' ? 'signatures' : 'simulation', title: simulation?.mode === 'conditional_threshold_override' ? 'Recheck after owners sign' : 'Measure state changes', points: 1, label: simulation?.mode === 'conditional_threshold_override' ? 'A conditional preview cannot replace a faithful Safe execution simulation with the real owner signatures.' : 'Run a simulation and inspect the storage changes it actually returns.' }); }
  if (transaction?.isExecuted && called.some(target => target.historicalUnavailable || target.proxy?.implementationCode?.historicalUnavailable)) {
    const beforeCap = score;
    score = Math.min(score, 7);
    if (beforeCap > score) gaps.push({ kind: 'archive', title: 'Check historical code', points: beforeCap - score, label: 'Use an archive-capable RPC to compare code at the execution block; current code cannot establish past code.' });
    reasons.push('Historical target bytecode was unavailable; current code may differ.');
  }
  score = Math.min(10, score);
  return { score, color: score >= 8 ? 'green' : score >= 5 ? 'amber' : 'red', label: 'Evidence confidence', reasons, gaps };
}
