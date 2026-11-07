const form = document.getElementById('inspect-form');
const inputMode = document.getElementById('input-mode');
const input = document.getElementById('input');
const network = document.getElementById('network');
const customChainId = document.getElementById('custom-chain-id');
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
const independentChecks = document.getElementById('independent-checks');
const independentChecksGuide = independentChecks.innerHTML;
const publicMode = document.body.dataset.publicMode === 'true';
const communityMode = document.body.dataset.communityMode === 'true';
const publicFacing = publicMode || communityMode;
const simulationEnabled = document.body.dataset.simulationEnabled === 'true';
// Wallet addresses come only from validated server configuration. Build the
// DOM with text nodes so addresses and labels cannot become HTML instructions.
fetch('/api/public-config').then(response => response.ok ? response.json() : null).then(config => {
  if (!config?.wallets?.length) return;
  const host = document.getElementById('donation-wallets');
  host.replaceChildren();
  const names = Object.fromEntries([...document.querySelector('#network').options].filter(option => option.value !== 'auto').map(option => [option.value, option.textContent]));
  for (const wallet of config.wallets) {
    const row = document.createElement('div'); row.className = 'donation-wallet';
    const label = document.createElement('strong'); label.textContent = names[wallet.network] ?? wallet.network;
    const address = document.createElement('code'); address.textContent = wallet.address;
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy address';
    copy.addEventListener('click', async () => { await navigator.clipboard.writeText(wallet.address); copy.textContent = 'Copied — thank you for your support'; });
    row.append(label, address, copy); host.append(row);
  }
}).catch(() => {});
fetch('/api/network-coverage').then(response => response.ok ? response.json() : null).then(snapshot => {
  if (!snapshot?.networks || !Array.isArray(snapshot.networks)) return;
  const note = document.getElementById('network-coverage-note');
  const checked = new Date(snapshot.checkedAt);
  note.textContent = `Endpoint probe: ${Number.isNaN(checked.getTime()) ? 'date unknown' : checked.toLocaleDateString()} · statuses can change. An empty test address checks endpoint availability, not a real Safe.`;
  const byNetwork = new Map(snapshot.networks.map(row => [row.network, row]));
  for (const card of document.querySelectorAll('.network-grid [data-network]')) {
    const row = byNetwork.get(card.dataset.network);
    if (!row) continue;
    const label = document.createElement('span'); label.className = 'network-status';
    const queue = row.pending === 'available' && row.history === 'available';
    const rpc = row.rpc === 'available';
    const safeCoverage = queue ? 'Safe queue + history' : row.pending === 'not_tested' || row.history === 'not_tested' ? 'Safe queue not tested' : 'Safe source unavailable';
    label.textContent = `${safeCoverage} · ${row.indexing === 'indexer_lagging' ? 'Indexer behind' : rpc ? 'RPC available' : 'RPC not verified'}`;
    if (!queue || !rpc || row.indexing !== 'available') label.classList.add('limited');
    card.append(label);
  }
}).catch(() => {});
if (publicFacing) {
  if (communityMode) document.querySelector('.local-note').textContent = 'Public service: Safe lookups and hosted MCP share a usage budget. Simulation, when configured, runs only on request.';
  else {
  document.querySelector('.local-note').textContent = 'Public demo: limited requests, no owner API keys or simulation. Use the local tool for full review.';
  }
  document.querySelector('.watch-control').hidden = true;
  if (publicMode) {
  const autoOption = document.querySelector('#network option[value="auto"]');
  if (autoOption) autoOption.disabled = true;
  network.value = 'eth';
  }
}
let timer = null;
let watchInput = null;
let importedJson = null;
let lastFingerprints = new Map();
let activeReportInput = null;
let activeReportNetwork = null;
let activeReportEvidence = null;
let activeReportTargetChecks = null;

function selectedNetwork() {
  if (network.value !== 'other') return network.value;
  const id = customChainId.value.trim();
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) throw new Error('Enter a valid EVM chain ID');
  return id;
}
network.addEventListener('change', () => { document.getElementById('custom-chain-group').hidden = network.value !== 'other'; });

function selectedInputMode() {
  if (inputMode.value && inputMode.value !== 'auto') return inputMode.value;
  const value = input.value.trim();
  if (importedJson || value.startsWith('{')) return 'json';
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return 'hash';
  if (/^0x[0-9a-fA-F]{40}$/.test(value)) return 'safe';
  if (value.startsWith('https://app.safe.global/')) return 'url';
  return 'auto';
}
function updateWizard() {
  const mode = selectedInputMode();
  const isSafe = mode === 'safe' || mode === 'url';
  document.getElementById('json-import').hidden = mode !== 'json';
  document.getElementById('json-options').hidden = mode !== 'json';
  document.getElementById('network-group').hidden = mode === 'url';
  document.getElementById('scope-group').hidden = !isSafe;
  document.getElementById('safe-actions').hidden = !isSafe;
  const guidance = {
    auto: ['2 · Paste it here', 'Paste what you have; the tool will identify a hash, Safe address, URL, or JSON.'],
    hash: ['2 · Paste the transaction hash', 'The tool looks up its full transaction fields, then recalculates the Safe hash.'],
    safe: ['2 · Paste the Safe address', 'Choose pending proposals or executed history, then select a transaction to review.'],
    url: ['2 · Paste the Safe URL', 'The URL supplies the network and Safe address. A transaction URL also identifies its hash.'],
    json: ['2 · Paste or upload JSON', 'Inspect the encoded calls offline. Compare its hash with an independently obtained reference.'],
  };
  document.getElementById('input-label').textContent = guidance[mode][0];
  document.getElementById('mode-help').textContent = guidance[mode][1];
  document.getElementById('network-help').textContent = mode === 'json' ? 'Select the chain for this export. Auto-detect works when the JSON includes a supported chain ID.' : mode === 'safe' ? 'A Safe address can exist on several chains. Local auto-detect checks available sources.' : 'A hash alone does not identify its chain. Local auto-detect searches available sources.';
}
inputMode.addEventListener('change', updateWizard);
updateWizard();
// A copied local link may include a transaction hash in its query string.
// Prefill only a valid hash and require an explicit review click, so merely
// opening a link cannot consume the shared upstream quota.
const linkQuery = new URL(globalThis.location?.search ?? '', 'http://localhost/').searchParams;
const linkedInput = linkQuery.get('hash') ?? linkQuery.get('tx') ?? linkQuery.get('input') ?? [...linkQuery.keys()][0];
if (/^0x[0-9a-fA-F]{64}$/.test(linkedInput ?? '')) {
  input.value = linkedInput;
  updateWizard();
  status.textContent = 'Transaction hash loaded from the link. Select Review transaction to inspect it.';
}

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
  return `<div class="call"><div class="call-title">${esc(title)} ${call.operation === 1 ? pill('DELEGATECALL') : ''} ${call.stage === 'schedule' ? pill('scheduled') : ''}</div><div class="call-detail mono">${call.via ? `${esc(call.via)} · ` : ''}To ${esc(call.to)} · ${esc(call.value)} wei</div>${call.decodeSource ? `<div class="decode-source">ABI from ${esc(call.decodeSource)}${call.decodeSourceUrl ? ` · <a href="${esc(call.decodeSourceUrl)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}. Function name does not prove behavior.</div>` : ''}${args}${call.decodeError ? `<p class="notice danger">Decode error: ${esc(call.decodeError)}</p>` : ''}${children}<details><summary>Raw calldata</summary><div class="raw">${esc(call.data)}</div></details></div>`;
}
function section(title, body) { return `<section class="report-section"><h3>${esc(title)}</h3>${body}</section>`; }
function flowHtml(node, path, labels) {
  const method = node.method?.split('(')[0] ?? (node.data === '0x' ? 'Empty or value call' : `Unknown ${node.selector}`);
  const title = labels.get(path) ?? method;
  const kind = /^schedule/.test(method) || node.stage === 'schedule' ? 'Schedule' : /^execute/.test(method) ? 'Execute' : node.operation === 1 ? 'Delegatecall' : 'Call';
  const children = node.children?.length ? `<ul class="flow-children">${node.children.map((child, i) => flowHtml(child, `${path}.${i + 1}`, labels)).join('')}</ul>` : '';
  return `<li><div class="flow-node ${node.children?.length ? 'flow-group' : 'flow-leaf'}"><span class="flow-kind">${esc(kind)}</span><div><strong>${esc(title)}</strong><span class="flow-address mono">${esc(node.to)}</span>${node.decodeSource ? `<span class="flow-evidence">Verified ABI · ${esc(node.decodeSource)}</span>` : ''}</div></div>${children}</li>`;
}
function crossCheckHtml(r) {
  const names = { eth: 'ethereum', gno: 'gnosis', pol: 'polygon', arb1: 'arbitrum', oeth: 'optimism', base: 'base', sep: 'sepolia', bnb: 'bsc', avax: 'avalanche' };
  const command = names[r.network] ? `./safe_hashes.sh --network ${names[r.network]} --address ${r.transaction.safe} --nonce ${r.transaction.nonce}` : null;
  return `<ol><li>Compare this hash on your signing device: <code class="mono">${esc(r.hash)}</code></li><li>Run <a href="https://github.com/pcaversaccio/safe-tx-hashes-util" target="_blank" rel="noopener noreferrer">pcaversaccio’s separate calculator</a>${command ? `:<code class="cross-check-command">${esc(command)}</code>` : '.'}</li><li>Check target code and execution effects through a separately trusted source.</li></ol><details><summary>What this second calculation checks</summary><p>Its standard mode also retrieves fields from Safe Transaction Service. It checks the hash calculation with another implementation, not the data source. Its interactive mode accepts manually supplied fields. This app does not run or bundle that separate AGPL tool.</p></details>`;
}
function verificationHtml(r) {
  const sources = { safe_api: 'Safe Transaction Service', safe_gateway: 'Safe Client Gateway', onchain_execution: 'Onchain execution via RPC', tenderly_monitor: 'Tenderly monitor snapshot', tenderly_storage: 'Imported monitor JSON' };
  const source = sources[r.evidence?.source] ?? (r.transaction?.lookupSource ? 'External transaction source' : 'Supplied JSON');
  const local = r.checks.find(check => check.name === 'Local EIP-712 hash');
  const contract = r.checks.find(check => check.name.startsWith('Safe contract hash'));
  const requested = r.evidence?.requestedHash;
  const step = (number, label, state, detail) => `<div class="item">${pill(state)}<div class="item-content"><strong>${number}. ${esc(label)}</strong><p>${esc(detail)}</p></div></div>`;
  const requestStep = requested
    ? step(1, 'Hash supplied by you', requested.toLowerCase() === r.hash?.toLowerCase() ? 'pass' : 'fail', 'The returned Safe transaction identifier matches the exact hash entered. Trust in that original hash depends on where you obtained it.')
    : step(1, 'Independent reference hash', 'unverified', 'No separate Safe transaction hash was supplied. Compare the calculated hash with the one displayed on your signing device.');
  const localStep = step(2, 'Local EIP-712 calculation', local?.status ?? 'unavailable', 'Calculated locally from the transaction fields. If those fields and the embedded hash both came from Safe, a pass proves consistency, not an independent source of the fields.');
  const contractStep = step(3, 'Safe contract calculation by RPC', contract?.status ?? 'unavailable', contract ? 'Called getTransactionHash on the Safe contract through the selected RPC. This is independent of Safe Transaction Service if the RPC is separately trusted.' : 'No contract hash result is available. The transaction has only the local calculation and any supplied reference hash.');
  const stateSource = r.safeState?.source ? `Signer and threshold state came from ${r.safeState.source === 'safe_api' ? 'Safe Transaction Service' : esc(r.safeState.source)}; this report does not independently validate every API confirmation.` : 'Signer and threshold state was not available; API confirmations are not independently verified here.';
  const rpc = r.rpc?.kind === 'public' ? `${r.rpc.label}. This is a shared public endpoint; you did not provide an RPC key.` : r.rpc?.label ?? 'RPC provider not reported by this version.';
  return `<p class="meta"><strong>Transaction fields:</strong> ${esc(source)}. ${stateSource}</p><p class="meta"><strong>Onchain RPC:</strong> ${esc(rpc)}${r.rpc?.kind === 'none' ? '' : ' Its responses are independent of Safe Transaction Service only if you trust this RPC separately.'}</p>${requestStep}${localStep}${contractStep}<p class="meta">A matching hash does not prove the target code, signer approvals, or execution outcome. Review the decoded calls and target bytecode before signing.</p>`;
}
function targetVerificationSummary(r) {
  const checks = r.targetChecks ?? [];
  if (!r.targetVerificationAttempted && !checks.length) return { tone: 'unverified', label: 'Bytecode check not run', detail: 'No target runtime bytecode has been compared yet.' };
  const targets = checks.flatMap(check => check.proxy ? [check, check.proxy.implementationCode ?? { status: 'unavailable' }] : [check]);
  if (!targets.length) return { tone: 'unavailable', label: 'Bytecode check unavailable', detail: 'The check ran but returned no target results.' };
  const matched = targets.filter(target => ['verified', 'verified_current'].includes(target.status)).length;
  const selectorMismatch = targets.some(target => target.abiSelectors?.some(selector => !selector.present));
  if (targets.some(target => target.status === 'mismatch')) return { tone: 'fail', label: `Bytecode mismatch · ${matched}/${targets.length} matched`, detail: 'At least one RPC runtime bytecode differs from the verified source. Review before signing.' };
  if (matched !== targets.length) return { tone: 'warning', label: `Bytecode check incomplete · ${matched}/${targets.length} matched`, detail: 'One or more targets or proxy implementations could not be matched with verified source.' };
  if (selectorMismatch) return { tone: 'warning', label: `Bytecode matched, ABI selector mismatch · ${matched}/${targets.length}`, detail: 'At least one decoded function selector is absent from the matching verified ABI. Treat that function label as unconfirmed.' };
  if (targets.some(target => target.status === 'verified_current')) return { tone: 'warning', label: `Bytecode matched current state · ${matched}/${targets.length}`, detail: 'Historical bytecode was unavailable. This does not establish what code was present at execution.' };
  return { tone: 'pass', label: `Verified bytecode · ${matched}/${targets.length}`, detail: 'Every inspected runtime bytecode matched Sourcify verified source at the checked block. This does not prove the code is safe.' };
}
function targetChecksHtml(r) {
  const checks = r.targetChecks ?? [];
  const summary = targetVerificationSummary(r);
  const rows = checks.map(check => {
    const proxy = check.proxy ? `<p>ERC-1967 implementation: <span class="mono">${esc(check.proxy.implementation)}</span> · ${esc(check.proxy.implementationCode?.status ?? 'unavailable')}${check.proxy.implementationCode?.bytecodeHash ? ` · <span class="mono">${esc(check.proxy.implementationCode.bytecodeHash)}</span>` : ''}</p>` : '';
    const abi = check.abiSelectors?.length ? `<p>Selectors in verified ABI: ${check.abiSelectors.map(item => `${esc(item.selector)} ${item.present ? 'yes' : 'no'}`).join(' · ')}</p>` : check.abiWarning ? `<p>${esc(check.abiWarning)}</p>` : '';
    return `<div class="item">${pill(check.status)}<div class="item-content"><strong class="mono">${esc(check.address)}</strong><p>${esc(check.reason)} · block ${esc(check.blockTag)}${check.bytecodeHash ? `<br>Runtime bytecode: <span class="mono">${esc(check.bytecodeHash)}</span>` : ''}${check.source ? `<br><a href="${esc(check.source)}" target="_blank" rel="noopener noreferrer">Inspect verified source</a>` : ''}</p>${abi}${proxy}</div></div>`;
  }).join('');
  const action = publicMode ? '<p class="meta">Run the local tool to verify target bytecode with your own provider.</p>' : summary.tone === 'pass' ? '' : `<div class="simulation-action"><button type="button" id="verify-targets">${checks.length ? 'Retry bytecode verification' : 'Verify target bytecode'}</button><p>Uses this network’s RPC and Sourcify. ERC-1967 implementations are inspected separately. Other proxy patterns and code changes during execution need manual review.</p></div>`;
  return `<div class="verification-summary verification-${summary.tone}">${pill(summary.tone)}<div><strong>${esc(summary.label)}</strong><p>${esc(summary.detail)}</p></div></div>${rows}${action}`;
}
function effectHtml(effect) {
  const asset = effect.kind === 'asset_transfer';
  const title = effect.kind === 'native_balance' ? 'Native balance (wei)' : asset ? `${effect.label || 'Asset'} transfer` : `${effect.kind} · ${effect.label || 'storage slot'}`;
  const hasValues = effect.before != null && effect.after != null && effect.before !== '' && effect.after !== '';
  const values = asset
    ? `From ${esc(effect.before || 'unknown')} → To ${esc(effect.after || 'unknown')}${effect.amount ? `<br>Amount: ${esc(effect.amount)}` : '<br>Amount unavailable'}`
    : hasValues ? `${esc(short(effect.before))} → ${esc(short(effect.after))}` : 'Before/after values unavailable';
  const detail = !asset && hasValues ? `<details><summary>Full before and after values</summary><div class="raw mono">Before: ${esc(effect.before)}<br>After: ${esc(effect.after)}</div></details>` : '';
  return `<div class="item">${pill(effect.severity)}<div class="item-content"><strong>${esc(title)}</strong><p class="mono">${esc(effect.address || 'Address unavailable')}<br>${values}</p>${detail}</div></div>`;
}
function reportHtml(r) {
  const tx = r.transaction;
  const safeUiKnown = r.network !== 'kat';
  const safeUrl = safeUiKnown ? `https://app.safe.global/home?safe=${encodeURIComponent(`${r.network === 'xlayer' ? 'okb' : r.network}:${tx.safe}`)}` : `https://katanascan.com/address/${encodeURIComponent(tx.safe)}`;
  const evidence = r.evidence?.source === 'onchain_execution'
    ? `<div class="notice" style="margin:16px 28px 0"><strong>Verified from ${esc(r.network)} onchain execution</strong> · block ${esc(r.evidence.blockNumber)}${r.evidence.blockTime ? ` · ${esc(r.evidence.blockTime)}` : ''}<br>Execution transaction: <span class="mono">${esc(r.evidence.executionHash)}</span>. ${r.evidence.discoveredBy === 'etherscan_index' ? 'Located through an indexed Safe event. ' : ''}The call graph comes from its execTransaction calldata. State changes below require a separate trace or simulation.</div>`
    : ['safe_api', 'safe_gateway'].includes(r.evidence?.source)
      ? `<div class="notice" style="margin:16px 28px 0"><strong>Fetched live from ${r.evidence.source === 'safe_api' ? 'Safe Transaction Service' : 'Safe Client Gateway'}</strong> · ${esc(r.evidence.retrievedAt)}<br>The Safe address, nonce, target and calldata came from this source. The EIP-712 hash is recalculated locally; check the RPC result and any limitations below.</div>`
      : '';
  const actionLabels = new Map(r.actions.map(action => [action.path, action.label]));
  const flow = `<div class="flow-map"><div class="flow-origin"><span class="flow-kind">Safe transaction</span><strong>Nonce ${esc(tx.nonce)}</strong><span class="mono">${esc(tx.safe)}</span></div><ul class="flow-root">${flowHtml(r.call, '1', actionLabels)}</ul></div>`;
  const actionSummary = r.risk.actionRatings.map(action => `<div class="planned-action">${pill(action.level)}<div><span class="action-stage">${esc(action.stage === 'schedule' ? 'Encoded to schedule' : 'Encoded to call')}</span><strong>${esc(action.label)}</strong><p>${esc(action.reason)}</p></div></div>`).join('');
  const riskReasons = r.risk.reasons.filter(reason => !/^(Called|Scheduled):/.test(reason.message)).map(reason => `<div class="semantic-reason">${pill(reason.level)}<span>${esc(reason.message)}</span></div>`).join('');
  const confidence = r.confidence ? `<div class="confidence confidence-${esc(r.confidence.color)}"><span class="confidence-number">${esc(r.confidence.score)}<small>/10</small></span><div><strong>Evidence confidence</strong><p>How much of this report could be checked. This is not a safety score.</p><details><summary>How this was scored</summary><ul>${r.confidence.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details></div></div>` : '';
  const riskHtml = `${confidence}<div class="risk-summary"><div>${pill(r.risk.level)}<strong>${esc(r.risk.reviewPriority)} review priority</strong><span>${esc(r.risk.impactLevel)} potential impact</span></div><p>Priority reflects the possible impact of the decoded calls. It does not say the transaction is malicious or prove what will happen onchain.</p></div>${riskReasons}`;
  const checks = r.checks.map(c => `<div class="item">${pill(c.status)}<div class="item-content"><strong>${esc(c.name)}</strong><p class="mono">${esc(c.detail)}</p></div></div>`).join('');
  const findings = r.findings.length ? r.findings.map(f => `<div class="item">${pill(f.severity)}<div class="item-content"><strong>${esc(f.code)} · call ${esc(f.path)}</strong><p>${esc(f.message)}</p></div></div>`).join('') : '<p class="meta">No known intent pattern matched. This does not establish safety.</p>';
  const emptyEffects = r.simulation?.unavailable ? 'Simulation was unavailable, so no state change was measured.' : r.simulation && r.simulation.stateDiffAvailable === false ? 'The simulation provider did not return a storage diff. Absence of a diff is not evidence of no change.' : r.simulation ? 'The simulation returned no complete storage, balance, or asset changes in its response.' : 'No simulation or execution trace has measured these changes yet.';
  const incompleteBalances = r.simulation?.balanceDataIncompleteCount ? `<div class="notice">Tenderly returned ${esc(r.simulation.balanceDataIncompleteCount)} balance-change record(s) without complete before/after values. They are omitted here; inspect the Tenderly trace for details.</div>` : '';
  const effects = `${incompleteBalances}${r.effects.length ? r.effects.map(effectHtml).join('') : `<div class="state-empty"><strong>No measured state changes available</strong><p>${esc(emptyEffects)}</p></div>`}`;
  const sim = r.simulation ? r.simulation.unavailable ? `<div class="notice">Simulation unavailable: ${esc(r.simulation.unavailable)}</div>` : `<div class="item">${pill(r.simulation.success === true ? 'pass' : r.simulation.success === false ? 'fail' : 'unavailable')}<div class="item-content"><strong>${r.simulation.success === true ? 'Safe execution succeeded in simulation' : r.simulation.success === false ? 'Safe execution failed in simulation' : 'EVM completed; Safe inner result unverified'}</strong><p>Block: ${esc(r.simulation.blockNumber)}${r.simulation.error ? ` · ${esc(r.simulation.error)}` : ''}${!publicFacing && r.simulation.url ? ` · <a href="${esc(r.simulation.url)}" target="_blank" rel="noopener noreferrer">Open Tenderly trace (project access required)</a>` : ''}</p><p>The measured effects shown here come from Tenderly’s API response. A dashboard trace saved in the service’s project is not publicly accessible unless its owner enables sharing.</p></div></div>` : '<p class="meta">Simulation has not been run for this transaction.</p>';
  const simulateAction = publicMode ? '<p class="meta">Simulation is available in the local tool with your own Tenderly credentials.</p>' : communityMode && !simulationEnabled ? '<p class="meta">Simulation is not configured for this public service. Decode and hash checks remain available.</p>' : `<div class="simulation-action"><button type="button" id="run-simulation">${r.simulation ? 'Run simulation again' : 'Run simulation and inspect state changes'}</button><p>Sends this transaction's calldata and signatures to the configured Tenderly project. The saved simulation covers one chain state and execution path.</p></div>`;
  const bytecodeStatus = targetVerificationSummary(r);
  return `<div class="report-header"><div class="safe-identity"><span>SAFE MULTISIG · ${esc(r.network)}</span><a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${safeUiKnown ? 'Open Safe' : 'Open contract'} ${esc(tx.safe)} on ${safeUiKnown ? 'Safe Global' : 'KatanaScan'}">${esc(tx.safe)} ↗</a><small>${safeUiKnown ? 'Open in Safe' : 'Open in KatanaScan · Safe web UI availability not verified'}</small></div><div class="report-heading">${pill(r.status)}<h2>Safe nonce ${esc(tx.nonce)}</h2><span>${esc(tx.isExecuted ? 'Executed transaction' : 'Pending proposal')} on ${esc(r.network)}</span></div><div class="hash-line mono">${esc(r.hash)}</div><div class="header-verification">${pill(bytecodeStatus.tone)}<span>${esc(bytecodeStatus.label)}</span></div></div>${evidence}${r.warnings.map(w => `<div class="notice" style="margin:16px 28px 0">${esc(w)}</div>`).join('')}${section('1 · Evidence and hash checks', verificationHtml(r))}${section('2 · What this transaction can do', `${riskHtml}${flow}`)}${section('3 · Changes encoded in the transaction', `${actionSummary || '<p class="meta">No decoded action available.</p>'}<p class="meta">These are intended calls, not measured state changes. A scheduled call and an execute call can both appear in the same Safe transaction.</p>`)}${section('4 · Target bytecode and verified source', targetChecksHtml(r))}${section('5 · Measured effects and simulation', `${effects}${checks}${sim}${simulateAction}`)}${section('Transaction facts', `<div class="field-grid">${field('Safe', tx.safe)}${field('Target', tx.to)}${field('Operation', tx.operation === 1 ? 'Delegatecall' : 'Call')}${field('Nonce', tx.nonce)}${field('Value', `${tx.value} wei`)}${field('Execution', tx.isExecuted ? (tx.isSuccessful ? 'Executed successfully' : 'Executed, failed') : 'Offchain proposal')}</div>`)}${section('What this review cannot prove', '<p class="meta">Decoded calldata shows intended calls. Confirm the Safe hash on the signing device, verify target bytecode and delegatecalls, and inspect a simulation trace for actual state changes. A simulation covers one block and one execution path.</p>')}<details class="technical"><summary>Technical details: decoded arguments and raw calldata</summary><div class="technical-body">${callHtml(r.call)}${findings}</div></details>`;
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
  independentChecks.innerHTML = crossCheckHtml(result);
  report.querySelector('#run-simulation')?.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, simulate: true });
  });
  report.querySelector('#verify-targets')?.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, verifyTargets: true });
  });
}
async function inspect({ silent = false, overrideInput = null, overrideNetwork = null, simulate = false, verifyTargets = !publicMode && (!communityMode || ['hash', 'json'].includes(selectedInputMode())) } = {}) {
  const selectedInput = overrideInput ?? importedJson ?? input.value.trim();
  const priorEvidence = simulate || verifyTargets ? activeReportEvidence : null;
  const priorHash = simulate || verifyTargets ? activeReportInput?.safeTxHash : null;
  const priorTargetChecks = simulate ? activeReportTargetChecks : null;
  if (!selectedInput) return;
  if (!silent) { submit.disabled = true; status.textContent = simulate ? 'Simulating Safe execution and measuring state changes…' : 'Inspecting Safe data and recalculating hashes…'; }
  try {
    const isJson = selectedInputMode() === 'json';
    const response = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: selectedInput, network: overrideNetwork ?? selectedNetwork(), scope: scope.value, simulate, verifyTargets, safeAddress: isJson ? safeAddress.value.trim() || undefined : undefined, safeHash: isJson ? safeHash.value.trim() || undefined : undefined }) });
    const result = await response.json().catch(() => null);
    if (!result || !response.ok) {
      const failure = new Error(result?.error ?? 'The service returned an unexpected response. Please retry.');
      failure.code = result?.code ?? 'SERVICE_ERROR';
      failure.incidentId = result?.incidentId ?? null;
      throw failure;
    }
    report.classList.remove('empty');
    document.body.classList.add('has-report');
    if (result.kind === 'builder') { independentChecks.innerHTML = independentChecksGuide; report.innerHTML = builderHtml(result); status.textContent = 'Builder JSON decoded'; }
    else if (result.kind === 'queue') {
      independentChecks.innerHTML = independentChecksGuide;
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
        const open = () => { const selected = result.reports[Number(row.dataset.index)]; showTransactionReport(selected); status.textContent = publicMode ? 'Opening selected transaction…' : 'Verifying selected transaction targets…'; inspect({ overrideInput: selected.transaction, overrideNetwork: selected.network, verifyTargets: !publicMode }); };
        row.addEventListener('click', open);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    } else { if (priorHash?.toLowerCase() === result.hash?.toLowerCase()) { if (priorEvidence) result.evidence = priorEvidence; if (priorTargetChecks?.length) result.targetChecks = priorTargetChecks; } showTransactionReport(result); status.textContent = simulate ? 'Simulation reviewed' : 'Inspection complete'; if (watch.checked) { watch.checked = false; clearInterval(timer); timer = null; } }
  } catch (error) {
    independentChecks.innerHTML = independentChecksGuide;
    const recorded = error.incidentId ? `<p class="meta">We recorded this issue to improve the service. Reference: <code>${esc(error.incidentId)}</code></p>` : '';
    status.textContent = error.code === 'INVALID_OR_UNAVAILABLE_INPUT' || error.code === 'TRANSACTION_UNAVAILABLE' ? 'Check the input or network' : 'Sorry, we could not complete the inspection';
    report.innerHTML = `<div class="empty"><h2>${error.code === 'INVALID_OR_UNAVAILABLE_INPUT' || error.code === 'TRANSACTION_UNAVAILABLE' ? 'We could not inspect this input' : 'Sorry, something went wrong'}</h2><p>${esc(error.message)}</p>${recorded}</div>`;
  }
  finally { submit.disabled = false; }
}
form.addEventListener('submit', event => { event.preventDefault(); inspect(); });
input.addEventListener('input', () => { importedJson = null; updateWizard(); });
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
watch.addEventListener('change', () => { if (publicFacing) { watch.checked = false; return; } clearInterval(timer); timer = null; watchInput = null; if (watch.checked) { scope.value = 'pending'; watchInput = safeAddress.value.trim() || input.value.trim(); inspect({ overrideInput: watchInput }); timer = setInterval(() => inspect({ silent: true, overrideInput: watchInput }), 30000); } });
scope.addEventListener('change', () => { if (watch.checked && scope.value !== 'pending') { watch.checked = false; clearInterval(timer); timer = null; } });
jsonFile.addEventListener('change', async () => {
  const file = jsonFile.files?.[0];
  if (!file) return;
  try {
    if (file.size > (publicFacing ? 262144 : 5000000)) throw new Error(`JSON file exceeds ${publicFacing ? '256 KB' : '5 MB'}`);
    const parsed = JSON.parse(await file.text());
    importedJson = parsed;
    inputMode.value = 'json';
    input.value = `Imported ${file.name}`;
    updateWizard();
    if (!safeAddress.value && parsed.meta?.createdFromSafeAddress) safeAddress.value = parsed.meta.createdFromSafeAddress;
    status.textContent = `Imported ${file.name}. Decoding…`;
    await inspect();
  } catch (error) { status.textContent = `Could not import JSON: ${error.message}`; }
});
