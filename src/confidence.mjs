// Evidence coverage, never a probability that signing is safe. A failed hash
// check overrides every positive signal because the report may describe a
// different transaction altogether.
export function assessConfidence({ call, checks = [], targetChecks = [], simulation, transaction }) {
  const reasons = [];
  const gaps = [];
  if (checks.some(check => check.status === 'fail')) return { score: 0, color: 'red', label: 'Hash mismatch', reasons: ['A Safe hash check failed. Do not rely on this report for signing.'], gaps: [{ points: 10, label: 'Resolve the mismatched Safe hash before relying on this report.' }] };
  let score = 1;
  const local = checks.find(check => check.method === 'local_eip712');
  if (local?.status === 'pass') { score += 3; reasons.push('Safe hash recomputed from complete transaction fields.'); }
  else { reasons.push('No independently supplied Safe hash to compare with the calculated hash.'); gaps.push({ points: 3, label: 'Supply complete transaction fields and compare their calculated Safe hash with your signing device.' }); }
  const onchain = checks.find(check => check.method === 'onchain_rpc');
  if (onchain?.status === 'pass') { score += 2; reasons.push('Safe contract confirmed the hash via RPC.'); }
  else { reasons.push('Safe contract hash was not confirmed via RPC.'); gaps.push({ points: 2, label: 'Confirm getTransactionHash on the Safe contract through a working RPC.' }); }
  const nodes = [];
  const visit = node => { nodes.push(node); node.children?.forEach(visit); };
  visit(call);
  const meaningful = nodes.filter(node => node.data && node.data !== '0x');
  const decoded = meaningful.filter(node => node.method);
  if (meaningful.length && decoded.length === meaningful.length) { score += 1; reasons.push('Every call selector in the graph has been decoded.'); }
  else { reasons.push(meaningful.length ? `${meaningful.length - decoded.length} call selector(s) remain undecoded.` : 'No call selector was available to decode.'); gaps.push({ points: 1, label: 'Decode every call selector in the nested call graph.' }); }
  const called = targetChecks.filter(target => target.selectors?.length);
  const verified = called.filter(target => ['verified', 'verified_current'].includes(target.status) && (!target.proxy || ['verified', 'verified_current'].includes(target.proxy.implementationCode?.status)));
  if (called.length && verified.length === called.length) { score += 2; reasons.push('Every called target with calldata has matching verified runtime bytecode.'); }
  else { reasons.push('Some called target bytecode has not been verified against source.'); gaps.push({ points: 2, label: 'Match every called target and proxy implementation runtime bytecode to verified source at the relevant block.' }); }
  if (simulation && !simulation.unavailable && simulation.success === true && simulation.stateDiffAvailable) { score += 1; reasons.push('A successful simulation returned a storage diff for one execution path.'); }
  else { reasons.push('No successful simulation with a storage diff was available.'); gaps.push({ points: 1, label: 'Run a successful simulation that returns a measured storage diff.' }); }
  if (transaction?.isExecuted && called.some(target => target.historicalUnavailable || target.proxy?.implementationCode?.historicalUnavailable)) {
    const beforeCap = score;
    score = Math.min(score, 7);
    if (beforeCap > score) gaps.push({ points: beforeCap - score, label: 'Verify target code at the execution block with an archive-capable RPC; current code alone cannot establish past code.' });
    reasons.push('Historical target bytecode was unavailable; current code may differ.');
  }
  score = Math.min(10, score);
  return { score, color: score >= 8 ? 'green' : score >= 5 ? 'amber' : 'red', label: 'Evidence confidence', reasons, gaps };
}
