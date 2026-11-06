const LEVELS = [
  { min: 90, level: 'critical' },
  { min: 70, level: 'high' },
  { min: 40, level: 'medium' },
  { min: 0, level: 'low' },
];

function level(score) { return LEVELS.find(item => score >= item.min).level; }

function actionImpact(action) {
  // Scores are review priorities for possible impact, not exploit likelihood.
  // Unknown selectors remain high because a name cannot be inferred safely.
  const method = action.method?.split('(')[0] ?? null;
  if (['upgradeTo', 'upgradeToAndCall', 'updateImplementation', 'changeAdmin'].includes(method)) return { score: 95, reason: 'Changes implementation or admin authority.' };
  if (['addOwnerWithThreshold', 'removeOwner', 'swapOwner', 'changeThreshold', 'enableModule', 'disableModule', 'setGuard', 'setFallbackHandler'].includes(method)) return { score: 95, reason: 'Changes who can control or execute from the Safe.' };
  if (method === 'reinitializeValidatorState') return { score: 90, reason: 'Reinitializes validator accounting state.' };
  if (['forceUnstake', 'forceUnstakePOL'].includes(method)) return { score: 80, reason: 'Forces a validator to unstake; impacts validator operations and funds flow.' };
  if (['approve', 'increaseAllowance', 'setApprovalForAll'].includes(method)) return { score: 80, reason: 'Grants or increases spending or operator authority.' };
  if (['transfer', 'transferFrom'].includes(method)) return { score: 75, reason: 'Moves tokens; value and recipient need independent review.' };
  if (method === 'cleanMapToken') return { score: 80, reason: 'Changes token mapping; verify bridge effects against events and storage.' };
  if (method === null && action.selector !== '0x') return { score: 75, reason: 'Unknown contract call; its effect cannot be classified from the local ABI.' };
  if (method === null) return { score: 45, reason: 'Moves native value or consumes a Safe nonce.' };
  return { score: 50, reason: 'State-changing contract call; inspect target and parameters.' };
}

export function assessRisk({ call, actions, findings, effects, checks, simulation, transaction }) {
  // Measured simulation effects may raise priority, but absence of a diff may
  // only mean the provider omitted it. Never lower decoded-call priority.
  const actionRatings = actions.map(action => {
    const impact = actionImpact(action);
    return { ...action, level: level(impact.score), score: impact.score, reason: impact.reason };
  });
  const impactScore = Math.max(0, ...actionRatings.map(action => action.score));
  const reasons = [];
  const add = (score, message) => { if (!reasons.some(item => item.message === message)) reasons.push({ level: level(score), score, message }); };
  for (const action of actionRatings) add(action.score, `${action.stage === 'schedule' ? 'Scheduled' : 'Called'}: ${action.label}. ${action.reason}`);
  for (const finding of findings) {
    if (finding.code === 'DELEGATECALL') {
      const parsedBatch = transaction.operation === 1 && call?.method === 'multiSend(bytes)' && call.children.length > 0 && !call.decodeError;
      add(parsedBatch ? 60 : 95, parsedBatch
        ? 'MultiSend uses delegatecall. Its inner actions were decoded, but the target bytecode has not been independently verified.'
        : 'Delegatecall can execute target code in Safe storage context; target bytecode has not been independently verified here.');
    }
    if (finding.code === 'GAS_REFUND') add(80, 'Gas refund fields can move value beyond the visible target call.');
    if (finding.code === 'EXECUTION_MISMATCH') add(100, 'Historical simulation differs from the recorded execution outcome.');
    if (finding.code === 'TARGET_CODE_MISMATCH') add(100, 'Verified source bytecode differs from the target bytecode returned by the RPC.');
    if (finding.code === 'TARGET_ABI_MISMATCH') add(80, 'Decoded selector does not appear in the verified source ABI.');
    if (finding.code === 'TARGET_NO_CODE') add(75, 'A called target has no bytecode at the inspected block.');
    if (finding.code === 'SAFE_REJECTION') add(55, 'Empty self-call can cancel a competing Safe transaction by consuming its nonce.');
  }
  if (checks.some(check => check.status === 'fail')) add(100, 'Safe transaction hash verification failed. Do not sign.');
  if (effects.some(effect => effect.severity === 'critical')) add(95, 'Simulation shows a change to authority, implementation, or Safe singleton storage.');
  if (effects.some(effect => effect.kind === 'asset_transfer')) add(80, 'Simulation shows asset transfers. Review recipients and amounts.');
  const reviewScore = Math.max(impactScore, ...reasons.map(item => item.score), 0);
  const uncertain = findings.some(finding => finding.code === 'UNKNOWN_SELECTOR' || finding.code === 'MULTISEND_TARGET_UNVERIFIED') || actionRatings.some(action => action.method === null && action.selector !== '0x');
  const basis = simulation?.success === true ? 'decoded calldata and simulated effects' : transaction.isExecuted ? 'onchain execution and decoded calldata' : 'decoded calldata only';
  return {
    level: level(reviewScore), impactLevel: level(impactScore), reviewPriority: level(reviewScore),
    basis, uncertain, actionRatings,
    reasons: reasons.sort((a, b) => b.score - a.score).slice(0, 8),
    note: 'Heuristic review priority and potential impact, not a probability or safety guarantee.',
  };
}
