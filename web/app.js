const form = document.getElementById('inspect-form');
const input = document.getElementById('input');
const network = document.getElementById('network');
const scope = document.getElementById('scope');
const safeAddress = document.getElementById('safe-address');
const safeHash = document.getElementById('safe-hash');
const loadPending = document.getElementById('load-pending');
const loadHistory = document.getElementById('load-history');
const report = document.getElementById('report');
const status = document.getElementById('status');
const submit = document.getElementById('submit');
const watch = document.getElementById('watch');
const jsonFile = document.getElementById('json-file');
const publicMode = document.body.dataset.publicMode === 'true';
if (publicMode) {
  document.querySelector('.local-note').textContent = 'Public demo: limited requests, no owner API keys or simulation. Use the local tool for full review.';
  document.querySelector('.watch-control').hidden = true;
  const autoOption = document.querySelector('#network option[value="auto"]');
  if (autoOption) autoOption.disabled = true;
  network.value = 'eth';
}
let timer = null;
let watchInput = null;
let importedJson = null;
let lastFingerprints = new Map();
let activeReportInput = null;
let activeReportNetwork = null;
let activeReportEvidence = null;
let activeReportTargetChecks = null;

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
function pill(value) { return `<span class="pill ${esc(String(value).toLowerCase())}">${esc(value)}</span>`; }
function short(value) { const s = String(value ?? ''); return s.length > 48 ? `${s.slice(0, 24)}…${s.slice(-12)}` : s; }
function field(label, value) { return `<div class="field"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`; }
function argValue(arg, call) {
  if (Array.isArray(arg.value) && arg.name === 'datas') return `${arg.value.length} payloads · ${call.children?.length ? 'decoded below' : 'inspect raw calldata'}`;
  if (typeof arg.value === 'string' && /^0x[0-9a-fA-F]+$/.test(arg.value) && arg.value.length > 66) {
    const bytes = (arg.value.length - 2) / 2;
    return `${bytes} bytes${call.children?.length ? ' · decoded below' : ' · inspect raw calldata'}`;
  }
  return JSON.stringify(arg.value);
}
function callHtml(call) {
  const title = call.method ?? (call.data === '0x' ? 'Native transfer or nonce-only call' : `Unknown ${call.selector}`);
  const args = call.args?.length ? `<div>${call.args.map(arg => `<div class="arg"><span>${esc(arg.name)}</span><span>${esc(argValue(arg, call))}</span></div>`).join('')}</div>` : '';
  const children = call.children?.length ? `<div class="call-children">${call.children.map(callHtml).join('')}</div>` : '';
  return `<div class="call"><div class="call-title">${esc(title)} ${call.operation === 1 ? pill('DELEGATECALL') : ''} ${call.stage === 'schedule' ? pill('scheduled') : ''}</div><div class="call-detail mono">${call.via ? `${esc(call.via)} · ` : ''}To ${esc(call.to)} · ${esc(call.value)} wei</div>${args}${call.decodeError ? `<p class="notice danger">Decode error: ${esc(call.decodeError)}</p>` : ''}${children}<details><summary>Raw calldata</summary><div class="raw">${esc(call.data)}</div></details></div>`;
}
function section(title, body) { return `<section class="report-section"><h3>${esc(title)}</h3>${body}</section>`; }
function flowHtml(node, path, labels) {
  const method = node.method?.split('(')[0] ?? (node.data === '0x' ? 'Empty or value call' : `Unknown ${node.selector}`);
  const title = labels.get(path) ?? method;
  const kind = /^schedule/.test(method) || node.stage === 'schedule' ? 'Schedule' : /^execute/.test(method) ? 'Execute' : node.operation === 1 ? 'Delegatecall' : 'Call';
  const children = node.children?.length ? `<ul class="flow-children">${node.children.map((child, i) => flowHtml(child, `${path}.${i + 1}`, labels)).join('')}</ul>` : '';
  return `<li><div class="flow-node ${node.children?.length ? 'flow-group' : 'flow-leaf'}"><span class="flow-kind">${esc(kind)}</span><div><strong>${esc(title)}</strong><span class="flow-address mono">${esc(node.to)}</span></div></div>${children}</li>`;
}
function crossCheckHtml(r) {
  const names = { eth: 'ethereum', gno: 'gnosis', pol: 'polygon', arb1: 'arbitrum', oeth: 'optimism', base: 'base', sep: 'sepolia', bnb: 'bsc', avax: 'avalanche' };
  const command = names[r.network] ? `./safe_hashes.sh --network ${names[r.network]} --address ${r.transaction.safe} --nonce ${r.transaction.nonce}` : null;
  const hashes = r.hashComponents ? `<div class="field-grid">${field('Domain hash', r.hashComponents.domainHash)}${field('Message hash', r.hashComponents.messageHash)}${field('Safe transaction hash', r.calculatedHash)}</div>` : '<p class="meta">Complete Safe transaction fields are required to calculate hash components.</p>';
  return `<p class="meta">Compare these locally calculated values with <a href="https://github.com/pcaversaccio/safe-tx-hashes-util" target="_blank" rel="noopener noreferrer">pcaversaccio's independent verifier</a>. This app does not run or bundle that separate AGPL tool.</p>${hashes}${command ? `<p class="meta">Run in a separate checkout of that project:</p><code class="cross-check-command">${esc(command)}</code>` : ''}`;
}
function targetChecksHtml(r) {
  const checks = r.targetChecks ?? [];
  const rows = checks.map(check => {
    const proxy = check.proxy ? `<p>ERC-1967 implementation: <span class="mono">${esc(check.proxy.implementation)}</span> · ${esc(check.proxy.implementationCode?.status ?? 'unavailable')}${check.proxy.implementationCode?.bytecodeHash ? ` · <span class="mono">${esc(check.proxy.implementationCode.bytecodeHash)}</span>` : ''}</p>` : '';
    const abi = check.abiSelectors?.length ? `<p>Selectors in verified ABI: ${check.abiSelectors.map(item => `${esc(item.selector)} ${item.present ? 'yes' : 'no'}`).join(' · ')}</p>` : check.abiWarning ? `<p>${esc(check.abiWarning)}</p>` : '';
    return `<div class="item">${pill(check.status)}<div class="item-content"><strong class="mono">${esc(check.address)}</strong><p>${esc(check.reason)} · block ${esc(check.blockTag)}${check.bytecodeHash ? `<br>Runtime bytecode: <span class="mono">${esc(check.bytecodeHash)}</span>` : ''}${check.source ? `<br><a href="${esc(check.source)}" target="_blank" rel="noopener noreferrer">Inspect verified source</a>` : ''}</p>${abi}${proxy}</div></div>`;
  }).join('');
  const complete = checks.length > 0 && checks.every(check => ['verified', 'verified_current'].includes(check.status) && (!check.proxy || ['verified', 'verified_current'].includes(check.proxy.implementationCode?.status)));
  const action = publicMode ? '<p class="meta">Run the local tool to verify target bytecode with your own provider.</p>' : '<div class="simulation-action"><button type="button" id="verify-targets">Verify all target bytecode</button><p>Uses this network’s RPC and Sourcify. ERC-1967 implementations are inspected separately. Other proxy patterns and code changes during execution need manual review.</p></div>';
  return `<div class="notice">${checks.length ? complete ? 'Matching verified runtime bytecode was found for every inspected target. This does not prove the code is safe.' : 'Source verification is incomplete. Inspect every unverified target before signing.' : 'Target code has not been checked yet.'}</div>${rows}${action}`;
}
function reportHtml(r) {
  const tx = r.transaction;
  const evidence = r.evidence?.source === 'onchain_execution'
    ? `<div class="notice" style="margin:16px 28px 0"><strong>Verified from ${esc(r.network)} onchain execution</strong> · block ${esc(r.evidence.blockNumber)}${r.evidence.blockTime ? ` · ${esc(r.evidence.blockTime)}` : ''}<br>Execution transaction: <span class="mono">${esc(r.evidence.executionHash)}</span>. ${r.evidence.discoveredBy === 'etherscan_index' ? 'Located through an indexed Safe event. ' : ''}The call graph comes from its execTransaction calldata. State changes below require a separate trace or simulation.</div>`
    : ['safe_api', 'safe_gateway'].includes(r.evidence?.source)
      ? `<div class="notice" style="margin:16px 28px 0"><strong>Fetched live from ${r.evidence.source === 'safe_api' ? 'Safe Transaction Service' : 'Safe Client Gateway'}</strong> · ${esc(r.evidence.retrievedAt)}<br>The Safe address, nonce, target and calldata came from this source. The EIP-712 hash is recalculated locally; check the RPC result and any limitations below.</div>`
      : '';
  const actionLabels = new Map(r.actions.map(action => [action.path, action.label]));
  const flow = `<div class="flow-map"><div class="flow-origin"><span class="flow-kind">Safe transaction</span><strong>Nonce ${esc(tx.nonce)}</strong><span class="mono">${esc(tx.safe)}</span></div><ul class="flow-root">${flowHtml(r.call, '1', actionLabels)}</ul></div>`;
  const actionSummary = r.risk.actionRatings.map(action => `<div class="planned-action">${pill(action.level)}<div><span class="action-stage">${esc(action.stage === 'schedule' ? 'Encoded to schedule' : 'Encoded to call')}</span><strong>${esc(action.label)}</strong><p>${esc(action.reason)}</p></div></div>`).join('');
  const riskReasons = r.risk.reasons.filter(reason => !/^(Called|Scheduled):/.test(reason.message)).map(reason => `<div class="semantic-reason">${pill(reason.level)}<span>${esc(reason.message)}</span></div>`).join('');
  const riskHtml = `<div class="risk-summary"><div>${pill(r.risk.level)}<strong>${esc(r.risk.reviewPriority)} review priority</strong><span>${esc(r.risk.impactLevel)} potential impact</span></div><p>Priority reflects the possible impact of the decoded calls. It does not say the transaction is malicious or prove what will happen onchain.</p></div>${riskReasons}`;
  const checks = r.checks.map(c => `<div class="item">${pill(c.status)}<div class="item-content"><strong>${esc(c.name)}</strong><p class="mono">${esc(c.detail)}</p></div></div>`).join('');
  const findings = r.findings.length ? r.findings.map(f => `<div class="item">${pill(f.severity)}<div class="item-content"><strong>${esc(f.code)} · call ${esc(f.path)}</strong><p>${esc(f.message)}</p></div></div>`).join('') : '<p class="meta">No known intent pattern matched. This does not establish safety.</p>';
  const emptyEffects = r.simulation?.unavailable ? 'Simulation was unavailable, so no state change was measured.' : r.simulation && r.simulation.stateDiffAvailable === false ? 'The simulation provider did not return a storage diff. Absence of a diff is not evidence of no change.' : r.simulation ? 'The simulation returned no storage, balance, or asset changes in its response.' : 'No simulation or execution trace has measured these changes yet.';
  const effects = r.effects.length ? r.effects.map(e => `<div class="item">${pill(e.severity)}<div class="item-content"><strong>${esc(e.kind)} · ${esc(e.label ?? '')}</strong><p class="mono">${esc(e.address)}<br>${esc(short(e.before))} → ${esc(short(e.after))}${e.amount ? `<br>Amount: ${esc(e.amount)}` : ''}</p><details><summary>Full before and after values</summary><div class="raw mono">Before: ${esc(e.before)}<br>After: ${esc(e.after)}</div></details></div></div>`).join('') : `<div class="state-empty"><strong>No measured state change</strong><p>${esc(emptyEffects)}</p></div>`;
  const sim = r.simulation ? r.simulation.unavailable ? `<div class="notice">Simulation unavailable: ${esc(r.simulation.unavailable)}</div>` : `<div class="item">${pill(r.simulation.success === true ? 'pass' : r.simulation.success === false ? 'fail' : 'unavailable')}<div class="item-content"><strong>${r.simulation.success === true ? 'Safe execution succeeded in simulation' : r.simulation.success === false ? 'Safe execution failed in simulation' : 'EVM completed; Safe inner result unverified'}</strong><p>Block: ${esc(r.simulation.blockNumber)}${r.simulation.error ? ` · ${esc(r.simulation.error)}` : ''}${r.simulation.url ? ` · <a href="${esc(r.simulation.url)}" target="_blank" rel="noopener noreferrer">Open Tenderly trace</a>` : ''}</p></div></div>` : '<p class="meta">Simulation has not been run for this transaction.</p>';
  const simulateAction = publicMode ? '<p class="meta">Simulation is available in the local tool with your own Tenderly credentials.</p>' : `<div class="simulation-action"><button type="button" id="run-simulation">${r.simulation ? 'Run simulation again' : 'Run simulation and inspect state changes'}</button><p>Sends this transaction's calldata and signatures to the configured Tenderly project. The saved simulation covers one chain state and execution path.</p></div>`;
  return `<div class="report-header"><div class="report-heading">${pill(r.status)}<h2>Safe nonce ${esc(tx.nonce)}</h2><span>${esc(tx.isExecuted ? 'Executed transaction' : 'Pending proposal')} on ${esc(r.network)}</span></div><div class="hash-line mono">${esc(r.hash)}</div></div>${evidence}${r.warnings.map(w => `<div class="notice" style="margin:16px 28px 0">${esc(w)}</div>`).join('')}${section('What this transaction can do', `${riskHtml}${flow}`)}${section('Changes encoded in the transaction', `${actionSummary || '<p class="meta">No decoded action available.</p>'}<p class="meta">These are intended calls, not measured state changes. A scheduled call and an execute call can both appear in the same Safe transaction.</p>`)}${section('Target bytecode and verified source', targetChecksHtml(r))}${section('State changes measured by simulation or execution', effects)}${section('Checks and simulation', `${checks}${sim}${simulateAction}`)}${section('Independent hash cross-check', crossCheckHtml(r))}${section('Transaction facts', `<div class="field-grid">${field('Safe', tx.safe)}${field('Target', tx.to)}${field('Operation', tx.operation === 1 ? 'Delegatecall' : 'Call')}${field('Nonce', tx.nonce)}${field('Value', `${tx.value} wei`)}${field('Execution', tx.isExecuted ? (tx.isSuccessful ? 'Executed successfully' : 'Executed, failed') : 'Offchain proposal')}</div>`)}${section('What this review cannot prove', '<p class="meta">Decoded calldata shows intended calls. Confirm the Safe hash on the signing device, verify target bytecode and delegatecalls, and inspect a simulation trace for actual state changes. A simulation covers one block and one execution path.</p>')}<details class="technical"><summary>Technical details: decoded arguments and raw calldata</summary><div class="technical-body">${callHtml(r.call)}${findings}</div></details>`;
}
function queueHtml(result) {
  const title = result.scope === 'history' ? 'Executed history' : result.scope === 'both' ? 'Pending and executed' : 'Pending proposals';
  const notices = (result.warnings ?? []).map(warning => `<div class="notice" style="margin:14px 28px">${esc(warning)}</div>`).join('');
  const choices = result.networks?.length > 1 ? `<div class="network-choices"><strong>Choose a network</strong><div>${result.networks.map(chain => `<button type="button" data-network="${esc(chain)}">${esc(chain)}</button>`).join('')}</div></div>` : '';
  return `<div class="queue-header"><h2>${title}</h2><div class="meta mono">${esc(result.safe)} · ${esc(result.networks?.join(', ') ?? result.network)} · ${result.reports.length} shown · ${esc(result.source)}${result.truncated ? ' · more may exist' : ''}</div></div>${choices}${notices}${result.reports.length ? result.reports.map((r, i) => `<div class="queue-row" data-index="${i}" role="button" tabindex="0">${pill(r.risk.reviewPriority)}<strong class="mono">${esc(r.hash)}</strong><p>${r.transaction.isExecuted ? 'Executed' : 'Pending'} · ${esc(r.network)} · Safe ${esc(r.transaction.safe)} · Nonce ${esc(r.transaction.nonce)} · ${esc(r.actions.map(action => action.label).join('; ') || r.call.method || r.call.selector)} · ${esc(r.risk.impactLevel)} impact</p></div>`).join('') : result.availability === 'unavailable' ? `<div class="empty"><h2>Queue source unavailable</h2><p>${result.source === 'tenderly_storage' ? 'The monitor JSON did not contain complete transaction details for this filter.' : 'Neither Safe Transaction Service nor Safe Client Gateway returned the offchain proposals. The notice above shows both responses.'}</p></div>` : `<div class="empty"><h2>No ${esc(title.toLowerCase())} in the returned range</h2><p>Check the coverage notice above before interpreting an empty list.</p></div>`}`;
}
function builderHtml(r) {
  const actions = r.risk.actionRatings.map(action => `<div class="semantic-action">${pill(action.level)}<div><strong>${action.stage === 'schedule' ? 'Would schedule' : 'Would execute'}: ${esc(action.label)}</strong><p>${esc(action.reason)}<br><span class="mono">${esc(action.to)}</span></p></div></div>`).join('');
  const comparison = `<div class="item">${pill(r.comparison.status)}<div class="item-content"><strong>Safe hash and JSON comparison</strong><p>${esc(r.comparison.detail)}${r.comparison.safeHash ? `<br>Verified hash: <span class="mono">${esc(r.comparison.safeHash)}</span> · nonce ${esc(r.comparison.nonce)}` : ''}</p></div></div>`;
  const findings = r.findings.map(f => `<div class="item">${pill(f.severity)}<div class="item-content"><strong>${esc(f.code)} · call ${esc(f.path)}</strong><p>${esc(f.message)}</p></div></div>`).join('');
  return `<div class="report-header">${pill('BUILDER PLAN')}<h2>${esc(r.name)}</h2><div class="meta mono">Safe: ${esc(r.safe ?? 'not supplied')} · chain ${esc(r.chainId)} · ${r.calls.length} top-level calls</div></div>${r.warnings.map(w => `<div class="notice" style="margin:16px 28px 0">${esc(w)}</div>`).join('')}${section('Safe hash comparison', `${comparison}<p class="meta">A Builder export omits Safe nonce and gas fields. Its metadata checksum is not a Safe transaction hash.</p>`)}${section('What the JSON plans to do', `<div class="risk-summary"><div>${pill(r.risk.reviewPriority)}<strong>${esc(r.risk.reviewPriority)} review priority</strong><span>${esc(r.risk.impactLevel)} potential impact · decoded JSON only</span></div><p>${esc(r.risk.note)}</p></div>${actions}`)}${section('Decoded call path', `${r.calls.map(callHtml).join('')}${findings}`)}${section('What this review cannot prove', '<p class="meta">This is an unsigned Builder plan. To compare it with a Safe transaction, enter its Safe hash above. A pending hash needs the Safe Transaction Service; a recent executed hash can also be found through Ethereum RPC.</p>')}`;
}
function showTransactionReport(result) {
  // Reuse the already resolved transaction for simulation. A queue row may
  // have come from a monitor even when a fresh Safe API lookup hits quota.
  activeReportInput = result.transaction;
  activeReportNetwork = result.network;
  activeReportEvidence = result.evidence ?? null;
  activeReportTargetChecks = result.targetChecks ?? null;
  report.innerHTML = reportHtml(result);
  report.querySelector('#run-simulation')?.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, simulate: true });
  });
  report.querySelector('#verify-targets').addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, verifyTargets: true });
  });
}
async function inspect({ silent = false, overrideInput = null, overrideNetwork = null, simulate = false, verifyTargets = true } = {}) {
  const selectedInput = overrideInput ?? importedJson ?? input.value.trim();
  const priorEvidence = simulate || verifyTargets ? activeReportEvidence : null;
  const priorHash = simulate || verifyTargets ? activeReportInput?.safeTxHash : null;
  const priorTargetChecks = simulate ? activeReportTargetChecks : null;
  if (!selectedInput) return;
  if (!silent) { submit.disabled = true; status.textContent = simulate ? 'Simulating Safe execution and measuring state changes…' : 'Inspecting Safe data and recalculating hashes…'; }
  try {
    const response = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: selectedInput, network: overrideNetwork ?? network.value, scope: scope.value, simulate, verifyTargets, safeAddress: safeAddress.value.trim() || undefined, safeHash: safeHash.value.trim() || undefined }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Inspection failed');
    report.classList.remove('empty');
    document.body.classList.add('has-report');
    if (result.kind === 'builder') { report.innerHTML = builderHtml(result); status.textContent = 'Builder JSON decoded'; }
    else if (result.kind === 'queue') {
      if (result.availability === 'unavailable') { report.innerHTML = queueHtml(result); status.textContent = 'Queue source unavailable'; return; }
      let exitNotice = '';
      if (silent) {
        const current = new Map(result.reports.map(r => [r.hash, `${r.transaction.confirmations?.length ?? 0}:${r.status}`]));
        const changed = [...current].filter(([hash, fp]) => lastFingerprints.get(hash) !== fp).length;
        const disappeared = [...lastFingerprints.keys()].filter(hash => !current.has(hash));
        if (changed || disappeared.length) status.textContent = `${changed} new or changed, ${disappeared.length} left pending queue · ${new Date().toLocaleTimeString()}`;
        lastFingerprints = current;
        if (disappeared.length) {
          const hash = disappeared[0];
          try {
            const finalResponse = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: hash, network: result.network, scope: scope.value }) });
            if (finalResponse.ok) {
              const finalReport = await finalResponse.json();
              const label = finalReport.transaction.isExecuted ? `Executed ${finalReport.transaction.isSuccessful ? 'successfully' : 'with failure'}` : 'No longer pending';
              status.textContent = `${label}: ${hash}`;
              exitNotice = `<div class="notice">${esc(label)}: ${esc(hash)}. Inspect this hash for the full report.</div>`;
            }
          } catch {}
        }
      } else {
        lastFingerprints = new Map(result.reports.map(r => [r.hash, `${r.transaction.confirmations?.length ?? 0}:${r.status}`]));
        status.textContent = `Inspected ${result.reports.length} ${result.scope} transaction(s)`;
      }
      report.innerHTML = exitNotice + queueHtml(result);
      report.querySelectorAll('[data-network]').forEach(button => button.addEventListener('click', () => {
        network.value = button.dataset.network;
        inspect({ overrideInput: result.safe });
      }));
      report.querySelectorAll('.queue-row').forEach(row => {
        const open = () => { const selected = result.reports[Number(row.dataset.index)]; showTransactionReport(selected); status.textContent = 'Verifying selected transaction targets…'; inspect({ overrideInput: selected.transaction, overrideNetwork: selected.network, verifyTargets: true }); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    } else { if (priorHash?.toLowerCase() === result.hash?.toLowerCase()) { if (priorEvidence) result.evidence = priorEvidence; if (priorTargetChecks?.length) result.targetChecks = priorTargetChecks; } showTransactionReport(result); status.textContent = simulate ? 'Simulation reviewed' : 'Inspection complete'; if (watch.checked) { watch.checked = false; clearInterval(timer); timer = null; } }
  } catch (error) { status.textContent = 'Inspection failed'; report.innerHTML = `<div class="empty"><h2>Could not inspect</h2><p>${esc(error.message)}</p></div>`; }
  finally { submit.disabled = false; }
}
form.addEventListener('submit', event => { event.preventDefault(); inspect(); });
input.addEventListener('input', () => { importedJson = null; });
function inspectSafe(selectedScope) {
  const primary = input.value.trim();
  let address = /^0x[0-9a-fA-F]{40}$/.test(primary) || primary.startsWith('https://app.safe.global/') ? primary : safeAddress.value.trim();
  if (address.startsWith('https://app.safe.global/')) {
    try {
      const url = new URL(address);
      const safe = url.searchParams.get('safe');
      address = safe ? `https://app.safe.global/home?safe=${encodeURIComponent(safe)}` : '';
    } catch { address = ''; }
  }
  if (!address || !(/^0x[0-9a-fA-F]{40}$/.test(address) || address.startsWith('https://app.safe.global/home?safe='))) { status.textContent = 'Enter a Safe multisig address or Safe URL first'; safeAddress.focus(); return; }
  scope.value = selectedScope;
  inspect({ overrideInput: address });
}
loadPending.addEventListener('click', () => inspectSafe('pending'));
loadHistory.addEventListener('click', () => inspectSafe('history'));
watch.addEventListener('change', () => { if (publicMode) { watch.checked = false; return; } clearInterval(timer); timer = null; watchInput = null; if (watch.checked) { scope.value = 'pending'; watchInput = safeAddress.value.trim() || input.value.trim(); inspect({ overrideInput: watchInput }); timer = setInterval(() => inspect({ silent: true, overrideInput: watchInput }), 30000); } });
scope.addEventListener('change', () => { if (watch.checked && scope.value !== 'pending') { watch.checked = false; clearInterval(timer); timer = null; } });
jsonFile.addEventListener('change', async () => {
  const file = jsonFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > (publicMode ? 262144 : 5000000)) throw new Error(`JSON file exceeds ${publicMode ? '256 KB' : '5 MB'}`);
    const parsed = JSON.parse(await file.text());
    importedJson = parsed;
    input.value = `Imported ${file.name}`;
    if (!safeAddress.value && parsed.meta?.createdFromSafeAddress) safeAddress.value = parsed.meta.createdFromSafeAddress;
    status.textContent = `Imported ${file.name}. Decoding…`;
    await inspect();
  } catch (error) { status.textContent = `Could not import JSON: ${error.message}`; }
});
