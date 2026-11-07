// Evidence coverage, never a probability that signing is safe. A failed hash
// check overrides every positive signal because the report may describe a
// different transaction altogether.
export function assessConfidence({ call, checks = [], targetChecks = [], simulation, transaction }) {
  const reasons = [];
  if (checks.some(check => check.status === 'fail')) return { score: 0, color: 'red', label: 'Hash mismatch', reasons: ['A Safe hash check failed. Do not rely on this report for signing.'] };
  let score = 1;
  const local = checks.find(check => check.method === 'local_eip712');
  if (local?.status === 'pass') { score += 3; reasons.push('Safe hash recomputed from complete transaction fields.'); }
  else reasons.push('No independently supplied Safe hash to compare with the calculated hash.');
  const onchain = checks.find(check => check.method === 'onchain_rpc');
  if (onchain?.status === 'pass') { score += 2; reasons.push('Safe contract confirmed the hash via RPC.'); }
  else reasons.push('Safe contract hash was not confirmed via RPC.');
  const nodes = [];
  const visit = node => { nodes.push(node); node.children?.forEach(visit); };
  visit(call);
  const meaningful = nodes.filter(node => node.data && node.data !== '0x');
  const decoded = meaningful.filter(node => node.method);
  if (meaningful.length && decoded.length === meaningful.length) { score += 1; reasons.push('Every call selector in the graph has been decoded.'); }
  else if (meaningful.length) reasons.push(`${meaningful.length - decoded.length} call selector(s) remain undecoded.`);
  const called = targetChecks.filter(target => target.selectors?.length);
  const verified = called.filter(target => ['verified', 'verified_current'].includes(target.status) && (!target.proxy || ['verified', 'verified_current'].includes(target.proxy.implementationCode?.status)));
  if (called.length && verified.length === called.length) { score += 2; reasons.push('Every called target with calldata has matching verified runtime bytecode.'); }
  else reasons.push('Some called target bytecode has not been verified against source.');
  if (simulation && !simulation.unavailable && simulation.success === true && simulation.stateDiffAvailable) { score += 1; reasons.push('A successful simulation returned a storage diff for one execution path.'); }
  else reasons.push('No successful simulation with a storage diff was available.');
  if (transaction?.isExecuted && called.some(target => target.historicalUnavailable || target.proxy?.implementationCode?.historicalUnavailable)) {
    score = Math.min(score, 7);
    reasons.push('Historical target bytecode was unavailable; current code may differ.');
  }
  score = Math.min(10, score);
  return { score, color: score >= 8 ? 'green' : score >= 5 ? 'amber' : 'red', label: 'Evidence confidence', reasons };
}
