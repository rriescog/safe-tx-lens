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
const jsonDrop = document.getElementById('json-drop');
const jsonChoose = document.getElementById('json-choose');
const jsonDropHint = document.getElementById('json-drop-hint');
const publicMode = document.body.dataset.publicMode === 'true';
const communityMode = document.body.dataset.communityMode === 'true';
const publicFacing = publicMode || communityMode;
const loopbackHost = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(globalThis.location?.hostname);
const simulationEnabled = document.body.dataset.simulationEnabled === 'true';
// Duplicate the visual strips for a seamless loop. Accessibility sees one set.
for (const id of ['network-track', 'tier-diamond', 'tier-gold', 'tier-silver', 'tier-bronze']) {
  const track = document.getElementById(id);
  if (track?.children?.length) for (const item of [...track.children]) {
    const clone = item.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    track.appendChild(clone);
  }
}
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
if (typeof window !== 'undefined') {
  let installPrompt = null;
  const installButton = document.getElementById('install-app');
  const refreshButton = document.getElementById('refresh-app');
  const standaloneDisplay = window.matchMedia?.('(display-mode: standalone)');
  const isInstalled = () => Boolean(standaloneDisplay?.matches || navigator.standalone === true);
  const updateAppControls = () => {
    refreshButton.hidden = !isInstalled();
    installButton.hidden = isInstalled() || !installPrompt;
  };
  updateAppControls();
  standaloneDisplay?.addEventListener?.('change', updateAppControls);
  refreshButton.addEventListener('click', () => window.location.reload());
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; updateAppControls(); });
  installButton.addEventListener('click', async () => {
    if (!installPrompt) return;
    const prompt = installPrompt;
    installPrompt = null;
    installButton.hidden = true;
    await prompt.prompt();
  });
  window.addEventListener('appinstalled', () => { installPrompt = null; updateAppControls(); });
}
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
// Every sample goes through the ordinary live inspector. Cards without a
// published sample select the network and ask for the visitor's own input.
fetch('/api/network-examples').then(response => response.ok ? response.json() : null).then(catalog => {
  if (!Array.isArray(catalog?.networks)) return;
  const byNetwork = new Map(catalog.networks.map(row => [row.network, row.examples]));
  for (const card of document.querySelectorAll('.network-grid [data-network]')) {
    const samples = byNetwork.get(card.dataset.network) ?? [];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'network-try';
    button.textContent = samples.length ? `Try ${samples[0].label}` : 'Try with your transaction';
    button.title = samples.length ? `Review nonce ${samples[0].nonce} live; uses the shared request budget` : 'No verified public example yet; provide your own transaction';
    button.addEventListener('click', () => {
      const sample = samples[0];
      if (!sample) {
        network.value = card.dataset.network;
        input.focus();
        document.getElementById('inspect-form').scrollIntoView?.({ behavior: 'smooth' });
        return;
      }
      importedJson = null;
      inputMode.value = 'hash';
      input.value = sample.hash;
      network.value = card.dataset.network;
      updateWizard();
      document.getElementById('inspect-form').scrollIntoView?.({ behavior: 'smooth' });
      inspect({ overrideInput: sample.hash, overrideNetwork: card.dataset.network });
    });
    card.append(button);
  }
}).catch(() => {});
function networkCoverageText(row) {
  const lists = row.pending === 'available' && row.history === 'available'
    ? 'Safe list APIs responded'
    : row.pending === 'not_tested' || row.history === 'not_tested'
      ? 'Safe list APIs not tested'
      : row.pending === 'not_available' && row.history === 'not_available'
        ? 'Configured Safe list API returned 404'
        : 'Safe list APIs inconclusive';
  const rpc = row.rpc === 'available' ? 'RPC chain ID matched' : 'RPC chain ID not confirmed';
  return `${lists} · ${rpc}${row.indexing === 'indexer_lagging' ? ' · Indexer behind' : ''}`;
}
fetch('/api/network-coverage').then(response => response.ok ? response.json() : null).then(snapshot => {
  if (!snapshot?.networks || !Array.isArray(snapshot.networks)) return;
  const note = document.getElementById('network-coverage-note');
  const checked = new Date(snapshot.checkedAt);
  const date = Number.isNaN(checked.getTime()) ? 'date unknown' : checked.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  note.textContent = `Checked ${date}. Safe list APIs were queried with an empty address; RPCs were asked only for their chain ID. This does not establish that a specific Safe, past block, or simulation is available. Try a sample for a transaction-level check.`;
  const byNetwork = new Map(snapshot.networks.map(row => [row.network, row]));
  for (const card of document.querySelectorAll('.network-grid [data-network]')) {
    const row = byNetwork.get(card.dataset.network);
    if (!row) continue;
    const label = document.createElement('span'); label.className = 'network-status';
    label.textContent = networkCoverageText(row);
    if (row.pending !== 'available' || row.history !== 'available' || row.rpc !== 'available' || row.indexing !== 'available') label.classList.add('limited');
    card.append(label);
  }
}).catch(() => {});
if (publicFacing || !loopbackHost) {
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
    hash: ['2 · Paste the transaction hash', 'The tool looks up its full transaction fields, then recalculates the Safe hash. A 1/1 proposal that has not been published may need transaction JSON instead.'],
    safe: ['2 · Paste the Safe address', 'Choose pending proposals or executed history, then select a transaction to review.'],
    url: ['2 · Paste the Safe URL', 'The URL supplies the network and Safe address. A transaction URL also identifies its hash.'],
    json: ['2 · Paste or upload JSON', 'Inspect the encoded calls offline, including an unpublished 1/1 proposal. Compare its hash with an independently obtained reference.'],
  };
  document.getElementById('input-label').textContent = guidance[mode][0];
  document.getElementById('mode-help').textContent = guidance[mode][1];
  document.getElementById('network-help').textContent = mode === 'json' ? 'Auto-detect uses the EVM chain ID inside the JSON; otherwise select a network.' : mode === 'safe' ? 'A Safe address can exist on several chains. Auto-detect checks configured networks; enter the chain ID for another EVM network.' : 'A hash does not contain its chain ID. Auto-detect checks configured networks; enter the chain ID for another EVM network.';
}
inputMode.addEventListener('change', updateWizard);
updateWizard();
document.getElementById('try-example').addEventListener('click', () => {
  // Use a published Safe hash and the ordinary live inspection path. A saved
  // report would conceal whether the transaction source and RPC work today.
  const exampleHash = '0x7bcc49dac788990018d8715a05502991ead142de209f3c8bc0adc72e252a67bb';
  importedJson = null;
  inputMode.value = 'hash';
  input.value = exampleHash;
  network.value = 'arb1';
  document.getElementById('custom-chain-group').hidden = true;
  updateWizard();
  report.innerHTML = '<div class="empty" role="status"><h2>Inspecting the example live</h2><p>Reading the published Arbitrum transaction and checking its target contracts through RPC.</p></div>';
  return inspect({ overrideInput: exampleHash, overrideNetwork: 'arb1' });
});
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
function safeExternalUrl(value) { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
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
function callExpression(call) {
  if (!call.method) return call.data === '0x' ? 'Native transfer or empty call' : `Unknown selector ${call.selector ?? '0x'}`;
  const name = call.method.split('(')[0];
  const allArgs = call.args ?? [];
  const args = allArgs.slice(0, 3).map((arg, index) => {
    const value = typeof arg.value === 'string' && /^(?:-?\d+|0x[0-9a-fA-F]{1,64})$/.test(arg.value)
      ? arg.value : argValue(arg, call) ?? 'unavailable';
    const compact = /^0x[0-9a-fA-F]{24,}$/.test(value) ? `${value.slice(0, 10)}…${value.slice(-6)}` : value.length > 48 ? `${value.slice(0, 45)}…` : value;
    return `${arg.name || `arg${index}`}: ${compact}`;
  });
  return `${name}(${args.join(', ')}${allArgs.length > 3 ? `, … +${allArgs.length - 3} more` : ''})`;
}
function callSource(call) {
  if (!call.method) return call.data === '0x'
    ? { tone: 'matched', label: 'No function call', detail: 'No function calldata was supplied. Check the value field to see whether native currency moves.' }
    : { tone: 'unknown', label: 'Function unknown', detail: 'No reliable ABI was found for this selector. Inspect the target code and raw calldata.' };
  if (call.decodeBasis === 'verified_abi') return call.decodeSource?.includes('current bytecode')
    ? { tone: 'partial', label: 'ABI matches current code', detail: 'The code at the historical execution block was unavailable, so this name may not describe past behavior.' }
    : { tone: 'matched', label: 'ABI matches checked code', detail: 'The runtime bytecode at the inspected block matches the verified source used for this ABI. A function name still does not prove the outcome.' };
  if (call.decodeBasis === 'verified_proxy_abi') return { tone: 'matched', label: 'Proxy route checked at this block', detail: 'The proxy bytecode matches a reviewed delegatecall fallback. Its implementation address at the inspected block points to code whose checked ABI decoded this call. An execution trace is still needed to confirm the path actually taken.' };
  if (call.decodeBasis === 'proxy_candidate_abi') return { tone: 'partial', label: 'Proxy route unconfirmed', detail: 'The implementation ABI decodes the calldata, but the proxy forwarding path has not been independently confirmed.' };
  if (call.decodeBasis === 'explorer_abi') return { tone: 'partial', label: 'Explorer ABI only', detail: 'An explorer supplied this ABI. Its runtime bytecode was not independently matched here.' };
  if (call.decodeBasis === 'selector_candidate') return { tone: 'candidate', label: 'Possible function name', detail: `${call.decodeCandidateSource ?? 'A signature database'} supplied this candidate. Its arguments fit the calldata, but the target contract has not been matched to that ABI.` };
  if (call.decodeBasis === 'known_signature') return { tone: 'candidate', label: 'Function format recognized; contract unchecked', detail: 'A built-in ABI decoded the calldata. This review has not matched that ABI to the called contract or its implementation, so the function name is provisional.' };
  return { tone: 'candidate', label: 'ABI source unconfirmed', detail: 'The function decoded, but this report does not establish where its ABI came from.' };
}
function decodeEvidence(call) {
  if (call.decodeSource) return `<div class="decode-source">${call.decodeBasis === 'proxy_candidate_abi' ? 'Possible call through a proxy: ' : 'ABI from '}${esc(call.decodeSource)}${safeExternalUrl(call.decodeSourceUrl) ? ` · <a href="${esc(safeExternalUrl(call.decodeSourceUrl))}" target="_blank" rel="noopener noreferrer">source</a>` : ''}. Function name does not prove behavior.</div>`;
  if (call.decodeBasis === 'selector_candidate') return `<div class="decode-source">Candidate signature from ${esc(call.decodeCandidateSource ?? 'a 4byte database')}. Arguments fit the calldata, but this is not verified against the called contract. Inspect target bytecode before relying on the name.</div>`;
  if (call.decodeCandidates?.length) return `<div class="decode-source">Ambiguous selector candidates: ${esc(call.decodeCandidates.join(' · '))}. No function was chosen.</div>`;
  if (call.decodeBasis === 'known_signature') return '<div class="decode-source">Calldata fits a built-in function format. The called code or proxy implementation has not been matched to that format.</div>';
  return '';
}
function callHtml(call) {
  const title = call.method ?? (call.data === '0x' ? 'Native transfer or nonce-only call' : `Unknown ${call.selector}`);
  const args = call.args?.length ? `<div>${call.args.map(arg => `<div class="arg"><span>${esc(arg.name)}</span><span>${esc(argValue(arg, call))}</span></div>`).join('')}</div>` : '';
  const children = call.children?.length ? `<div class="call-children">${call.children.map(callHtml).join('')}</div>` : '';
  return `<div class="call"><div class="call-title">${esc(title)} ${call.operation === 1 ? pill('DELEGATECALL') : ''} ${call.stage === 'schedule' ? pill('scheduled') : ''}</div><div class="call-detail mono">${call.via ? `${esc(call.via)} · ` : ''}To ${esc(call.to)} · ${esc(call.value)} wei</div>${decodeEvidence(call)}${args}${call.decodeError ? `<p class="notice danger">Decode error: ${esc(call.decodeError)}</p>` : ''}${children}<details><summary>Raw calldata</summary><div class="raw">${esc(call.data)}</div></details></div>`;
}
function section(title, body) {
  const id = title.startsWith('1 ·') ? 'evidence-checks' : title.startsWith('2 ·') ? 'call-path' : title.startsWith('4 ·') ? 'target-code' : title.startsWith('5 ·') ? 'simulation-results' : '';
  return `<section class="report-section"${id ? ` id="${id}"` : ''}><h3>${esc(title)}</h3>${body}</section>`;
}
function flowHtml(node, path, labels) {
  const method = node.method?.split('(')[0] ?? (node.data === '0x' ? 'Empty or value call' : `Unknown ${node.selector}`);
  const expression = callExpression(node);
  const interpretation = labels.get(path);
  const source = callSource(node);
  const kind = /^schedule/.test(method) || node.stage === 'schedule' ? 'Schedule' : /^execute/.test(method) ? 'Execute' : node.operation === 1 ? 'Delegatecall' : 'Call';
  const children = node.children?.length ? `<ul class="flow-children">${node.children.map((child, i) => flowHtml(child, `${path}.${i + 1}`, labels)).join('')}</ul>` : '';
  const meaning = node.method && interpretation && interpretation !== expression ? `<span class="flow-interpretation">Likely meaning: ${esc(interpretation)}</span>` : '';
  const argumentsHtml = node.args?.length ? `<div class="flow-args"><strong>Decoded arguments</strong>${node.args.map((arg, index) => { const raw = typeof arg.value === 'string' && /^-?\d+$/.test(arg.value) ? arg.value : JSON.stringify(arg.value) ?? 'unavailable'; const display = raw.length > 512 ? `${raw.slice(0, 509)}… (full bytes in raw calldata)` : raw; return `<div><span>${esc(arg.name || `arg${index}`)}</span><code>${esc(display)}</code></div>`; }).join('')}</div>` : '';
  const proof = `<details class="flow-proof"><summary>Source and limits</summary><p>${esc(source.detail)}</p>${node.method ? `<p>Function signature: <code>${esc(node.method)}</code></p>` : ''}${node.selector && node.selector !== '0x' ? `<p>Selector: <code>${esc(node.selector)}</code></p>` : ''}${node.decodeSource ? `<p>ABI evidence: ${esc(node.decodeSource)}</p>` : ''}${safeExternalUrl(node.decodeSourceUrl) ? `<a href="${esc(safeExternalUrl(node.decodeSourceUrl))}" target="_blank" rel="noopener noreferrer">Open verified source</a>` : ''}${argumentsHtml}</details>`;
  return `<li><div class="flow-node ${node.children?.length ? 'flow-group' : 'flow-leaf'}"><span class="flow-kind">${esc(kind)}</span><div><strong class="flow-expression">${esc(expression)}</strong>${meaning}<span class="flow-source flow-source-${source.tone}">${esc(source.label)}</span><span class="flow-address mono">${esc(node.to)}</span>${node.token ? `<span class="token-identity">${esc(node.token.amount ?? 'Raw amount unavailable')} ${esc(node.token.symbol)} · ${esc(node.token.address)}<small>Symbol and decimals reported by the contract via RPC at ${esc(node.token.blockTag === 'latest' ? 'current state' : `block ${node.token.blockTag}`)}; identity unverified.</small></span>` : ''}${proof}</div></div>${children}</li>`;
}
function graphElements(r) {
  const elements = [{ data: { id: 'safe', label: `Safe nonce ${r.transaction.nonce}`, detail: `Safe ${r.transaction.safe}`, kind: 'safe' } }];
  const labels = new Map(r.actions.map(action => [action.path, action.label]));
  let omitted = 0;
  function visit(call, path, parent) {
    if (elements.filter(element => !element.data.source).length >= 80) { omitted++; return; }
    const method = call.method?.split('(')[0] ?? (call.data === '0x' ? 'Value or empty call' : `Unknown ${call.selector}`);
    const kind = call.operation === 1 ? 'delegatecall' : call.stage === 'schedule' || /^schedule/.test(method) ? 'schedule' : /^execute/.test(method) ? 'execute' : 'call';
    const interpretation = labels.get(path);
    const detail = `${callExpression(call)}${interpretation && interpretation !== callExpression(call) ? `\nLikely meaning: ${interpretation}` : ''}\n${callSource(call).label}\n${kind} to ${call.to}\nValue: ${call.value} wei${call.decodeSource ? `\nABI evidence: ${call.decodeSource}` : ''}${call.decodeError ? `\nDecode error: ${call.decodeError}` : ''}`;
    // Keep canvas labels short; the selected-node panel has the full action.
    elements.push({ data: { id: path, label: method.length > 27 ? `${method.slice(0, 24)}…` : method, detail, kind } });
    elements.push({ data: { id: `edge-${path}`, source: parent, target: path } });
    for (const [index, child] of (call.children ?? []).entries()) visit(child, `${path}.${index + 1}`, path);
  }
  visit(r.call, '1', 'safe');
  return { elements, omitted };
}
let activeGraph;
function showCallGraph(r) {
  activeGraph?.destroy();
  activeGraph = null;
  const shell = report.querySelector('.graph-shell');
  if (!shell || typeof cytoscape !== 'function') return;
  const disclosure = report.querySelector('.graph-extra');
  disclosure.addEventListener('toggle', () => { if (disclosure.open && !activeGraph) renderGraph(); });
  function renderGraph() {
  const { elements, omitted } = graphElements(r);
  const detail = shell.querySelector('.graph-selection');
  detail.textContent = `Select a call to see its target and decoded intent.${omitted ? ` Showing the first 79 calls; ${omitted} more omitted from the graph. The text path below includes all calls.` : ''}`;
  activeGraph = cytoscape({
    container: shell.querySelector('.call-graph'), elements,
    layout: { name: 'breadthfirst', directed: true, roots: '#safe', padding: 28, spacingFactor: 1.35 },
    style: [
      { selector: 'node', style: { 'background-color': '#e8f3f7', 'border-width': 2, 'border-color': '#6ca7bd', label: 'data(label)', color: '#153345', 'font-size': 11, 'font-weight': 700, 'text-wrap': 'wrap', 'text-max-width': 132, 'text-valign': 'center', 'text-halign': 'center', width: 160, height: 58, shape: 'round-rectangle' } },
      { selector: 'node[kind = "safe"]', style: { 'background-color': '#075477', color: '#ffffff', 'border-color': '#075477' } },
      { selector: 'node[kind = "delegatecall"]', style: { 'background-color': '#fff0e7', 'border-color': '#bf643b' } },
      { selector: 'node[kind = "schedule"]', style: { 'background-color': '#fff7e4', 'border-color': '#c99b3f' } },
      { selector: 'edge', style: { width: 2, 'line-color': '#87adbc', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#87adbc', 'curve-style': 'bezier' } },
      { selector: ':selected', style: { 'border-width': 4, 'border-color': '#087b95' } },
    ],
  });
  activeGraph.on('tap', 'node', event => { detail.textContent = event.target.data('detail'); });
  }
}
function verificationHtml(r) {
  const sources = { safe_api: 'Safe Transaction Service', safe_api_untrusted: 'Safe Transaction Service (unsigned, untrusted record)', safe_gateway: 'Safe Client Gateway', onchain_execution: 'Onchain execution via RPC', tenderly_monitor: 'Tenderly monitor snapshot', tenderly_storage: 'Imported monitor JSON' };
  const source = sources[r.evidence?.source] ?? (r.transaction?.lookupSource ? 'External transaction source' : 'Supplied JSON');
  const local = r.checks.find(check => check.name === 'Local EIP-712 hash');
  const contract = r.checks.find(check => check.name.startsWith('Safe contract hash'));
  const requested = r.evidence?.requestedHash;
  const step = (number, label, state, detail, unavailableLabel = 'Not run') => `<div class="item">${state === 'unverified' ? '<span class="pill unverified">Your check</span>' : state === 'unavailable' ? `<span class="pill unavailable">${esc(unavailableLabel)}</span>` : pill(state)}<div class="item-content"><strong>${number}. ${esc(label)}</strong><p>${esc(detail)}</p></div></div>`;
  const requestStep = requested
    ? step(1, 'Hash supplied by you', requested.toLowerCase() === r.hash?.toLowerCase() ? 'pass' : 'fail', 'The returned Safe transaction identifier matches the exact hash entered. Trust in that original hash depends on where you obtained it.')
    : r.evidence?.source === 'onchain_execution' && r.transaction.safeTxHash
      ? step(1, 'Hash in the onchain Safe event', r.transaction.safeTxHash.toLowerCase() === r.calculatedHash?.toLowerCase() ? 'pass' : 'fail', `The Safe event contains ${r.transaction.safeTxHash}; it matches the hash calculated from execution calldata when this check passes. Both came through the selected RPC. If you are about to sign, also compare the hash on your signing device.`)
      : step(1, 'Compare with your signing device', 'unverified', `No hash was independently supplied to this review. Compare ${r.calculatedHash ?? r.hash ?? 'the calculated Safe hash'} with the hash displayed by your signing device. This app cannot read that device or mark the comparison as passed for you.`);
  const localStep = step(2, 'Local EIP-712 calculation', local?.status ?? 'unavailable', 'Calculated locally from the transaction fields. If those fields and the embedded hash both came from Safe, a pass proves consistency, not an independent source of the fields.');
  const contractDetail = contract?.status === 'unavailable'
    ? `The Safe contract could not answer getTransactionHash${r.transaction?.isExecuted ? ' at the block before execution' : ''}: ${contract.detail || 'RPC request unavailable'}. ${r.transaction?.isExecuted ? 'This commonly needs an archive-capable RPC for that network; configure one locally and rerun the inspection.' : 'Check the RPC for this network and retry.'}`
    : contract ? 'The Safe contract returned this hash through the selected RPC. This is independent of Safe Transaction Service if the RPC is separately trusted.'
      : 'This check did not run because no usable RPC was available. Configure a network RPC locally, then rerun the inspection.';
  const contractStep = step(3, 'Safe contract calculation by RPC', contract?.status ?? 'unavailable', contractDetail, contract ? 'RPC read failed' : 'Not run');
  const stateSource = r.safeState?.source ? `Signer and threshold state came from ${r.safeState.source === 'safe_api' ? 'Safe Transaction Service' : esc(r.safeState.source)}; this report does not independently validate every API confirmation.` : 'Signer and threshold state was not available; API confirmations are not independently verified here.';
  const rpcKind = r.rpc?.kind === 'public' ? 'Shared public RPC' : r.rpc?.kind === 'custom' ? 'Configured RPC' : 'No RPC used';
  const rpcDetail = r.rpc?.label ?? 'RPC provider not reported by this version.';
  return `<p class="meta"><strong>Transaction fields:</strong> ${esc(source)}. ${stateSource}</p><p class="meta"><strong>Onchain check:</strong> ${esc(rpcKind)}.${r.rpc?.kind === 'none' ? '' : ' Its responses add another source only if you trust that RPC separately.'}</p><details class="rpc-details"><summary>Which RPC answered?</summary><p>${esc(rpcDetail)}${r.rpc?.kind === 'public' ? '. Shared endpoint; no personal RPC key was provided.' : ''}</p></details>${requestStep}${localStep}${contractStep}<p class="meta">A matching hash does not prove the target code, signer approvals, or execution outcome. Review the decoded calls and target bytecode before signing.</p>`;
}
function targetVerificationSummary(r) {
  const checks = r.targetChecks ?? [];
  if (!r.targetVerificationAttempted && !checks.length) return { tone: 'unverified', label: 'Bytecode check not run', detail: 'No target runtime bytecode has been compared yet.' };
  const targets = checks.flatMap(check => [check, ...(check.proxy ? [check.proxy.implementationCode ?? { status: 'unavailable' }] : []), ...(check.plannedImplementationCode ? [check.plannedImplementationCode] : [])]);
  if (!targets.length) return { tone: 'unavailable', label: 'Bytecode check unavailable', detail: 'The check ran but returned no target results.' };
  const matched = targets.filter(target => ['verified', 'verified_current'].includes(target.status)).length;
  if (targets.some(target => target.status === 'mismatch')) return { tone: 'fail', label: `Bytecode mismatch · ${matched}/${targets.length} matched`, detail: 'At least one RPC runtime bytecode differs from the verified source. Review before signing.' };
  if (matched !== targets.length) return { tone: 'warning', label: `Bytecode check incomplete · ${matched}/${targets.length} matched`, detail: 'One or more targets or proxy implementations could not be matched with verified source.' };
  if (targets.some(target => target.status === 'verified_current')) return { tone: 'partial', label: `Current bytecode matches · ${matched}/${targets.length}`, detail: 'All inspected contracts match verified source now. The RPC could not return bytecode from before this execution, so past code remains unverified.' };
  return { tone: 'pass', label: `Verified bytecode · ${matched}/${targets.length}`, detail: 'Every inspected runtime bytecode matched verified source from a named provider at the checked block. This does not prove the code is safe.' };
}
function targetChecksHtml(r, retryNote = '') {
  const checks = r.targetChecks ?? [];
  const summary = targetVerificationSummary(r);
  const inferredRoutes = checks.filter(check => ['implementation() fallback', 'ZeppelinOS implementation slot'].includes(check.proxy?.standard) && check.proxy.forwarding?.status !== 'verified_at_block').length;
  const confirmedRoutes = checks.filter(check => check.proxy?.forwarding?.status === 'verified_at_block');
  const confirmedNotice = confirmedRoutes.length ? `<div class="verification-summary verification-pass"><span class="pill pass">Proxy route checked</span><div><strong>${confirmedRoutes.length} reviewed proxy fallback${confirmedRoutes.length === 1 ? '' : 's'} matched at the inspected block</strong><p>The runtime bytecode matched verified proxy source, and the implementation address at the inspected block was read through RPC. A trace is still needed to confirm the exact path taken, especially if proxy state changed earlier in the transaction.</p>${confirmedRoutes.map(check => `<p><a href="${esc(check.proxy.forwarding.source)}" target="_blank" rel="noopener noreferrer">Review ${esc(check.proxy.forwarding.pattern)} source</a> · block ${esc(check.proxy.forwarding.blockTag)}</p>`).join('')}</div></div>` : '';
  const routeNotice = inferredRoutes ? `<div class="verification-summary verification-warning"><span class="pill warning">Check call path</span><div><strong>${inferredRoutes} contract${inferredRoutes === 1 ? '' : 's'} may forward calls to another contract</strong><p>For each one, the tool read its implementation() address and used that contract’s ABI to explain the call. It has not confirmed that the proxy’s fallback actually sends this call there. Check the proxy’s fallback code or an execution trace${r.transaction?.isExecuted ? ' from the execution block' : ''} before relying on the decoded function name.</p></div></div>` : '';
  const missingSelectors = checks.flatMap(check => {
    const effective = check.proxy ? check.proxy.implementationCode : check;
    if (!['verified', 'verified_current'].includes(effective?.status)) return [];
    return effective.abiSelectors?.filter(selector => !selector.present && !(check.proxy && check.abiSelectors?.some(outer => outer.selector === selector.selector && outer.present)) && !(['verified', 'verified_current'].includes(check.plannedImplementationCode?.status) && check.plannedImplementationCode?.abiSelectors?.some(planned => planned.selector === selector.selector && planned.present))).map(selector => ({ address: check.address, selector: selector.selector })) ?? [];
  });
  const abiNotice = missingSelectors.length ? `<div class="verification-summary verification-warning"><span class="pill warning">ABI review</span><div><strong>${missingSelectors.length} call selector${missingSelectors.length === 1 ? '' : 's'} absent from the matched ABI</strong><p>The runtime bytecode matches verified source. This separate warning concerns how its calls are interpreted: a fallback or proxy implementation may handle these selectors. Review the implementation and call path before trusting the function labels.</p></div></div>` : '';
  const rows = checks.map(check => {
    const proxy = check.proxy ? `<p>${esc(check.proxy.standard ?? 'ERC-1967')} implementation: <span class="mono">${esc(check.proxy.implementation)}</span> · ${esc(check.proxy.implementationCode?.status ?? 'unavailable')}${check.proxy.implementationCode?.bytecodeHash ? ` · <span class="mono">${esc(check.proxy.implementationCode.bytecodeHash)}</span>` : ''}</p>` : '';
    const planned = check.plannedImplementationCode ? `<p>Proposed upgrade to <span class="mono">${esc(check.plannedImplementation)}</span>: ${esc(check.plannedImplementationCode.status)}. Its ABI can describe later calls only if the upgrade executes first.</p>` : '';
    const effective = check.proxy ? check.proxy.implementationCode : check;
    const abi = effective?.abiSelectors?.length ? `<p>Selectors in ${effective.status === 'explorer_abi' ? 'explorer' : 'verified'} ${check.proxy ? 'implementation' : 'target'} ABI: ${effective.abiSelectors.map(item => `${esc(item.selector)} ${item.present ? 'yes' : 'no'}`).join(' · ')}</p>` : effective?.abiWarning ? `<p>${esc(effective.abiWarning)}</p>` : '';
    const badge = check.status === 'verified_current' ? '<span class="pill verified_current">Current code matched</span>' : check.status === 'explorer_abi' ? '<span class="pill warning">Explorer ABI only</span>' : pill(check.status);
    const plainResult = check.status === 'verified_current' ? 'Current code matches verified source. Code at execution time was not checked.' : check.status === 'verified' ? 'Code at the inspected block matches verified source.' : check.status === 'mismatch' ? 'Verified source and onchain bytecode differ. Stop and investigate.' : check.reason;
    const technical = `<details><summary>Technical evidence</summary><p>${esc(check.reason)} · block ${esc(check.blockTag)}${check.bytecodeHash ? `<br>Runtime bytecode hash: <span class="mono">${esc(check.bytecodeHash)}</span>` : ''}</p>${abi}${proxy}${planned}</details>`;
    return `<div class="item">${badge}<div class="item-content"><strong class="mono">${esc(check.address)}</strong><p>${esc(plainResult)}${check.source ? `<br><a href="${esc(check.source)}" target="_blank" rel="noopener noreferrer">Inspect ${check.status === 'explorer_abi' ? 'explorer ABI record' : 'verified source'}</a>` : ''}</p>${technical}</div></div>`;
  }).join('');
  const archiveNextStep = summary.tone === 'partial' ? `<div class="next-step"><strong>To verify code at execution time</strong><p>${publicFacing ? 'This service needs an archive-capable RPC for this network. The service operator must add one; clicking again on the current public RPC will not change this result. You can also run the open-source tool locally with an archive RPC.' : `Set RPC_URL_${esc(String(r.network ?? '').toUpperCase())} to an archive-capable endpoint, restart the local service, and inspect this transaction again. Clicking again with the same RPC will not change this result.`}</p></div>` : '';
  const action = publicMode ? ['pass', 'partial', 'fail'].includes(summary.tone) ? '' : '<p class="meta">The public demo checks at most four targets per selected transaction. For an unchecked target, run the open-source tool with your own RPC.</p>' : ['pass', 'partial', 'fail'].includes(summary.tone) ? '' : `<div class="simulation-action"><button type="button" id="verify-targets">${checks.length ? 'Check bytecode again' : 'Check target bytecode'}</button><p>Asks this network’s RPC for runtime bytecode and compares it with Sourcify or a supported Blockscout explorer. Etherscan and OKLink can supply an ABI when no matching bytecode source is available; those labels stay unconfirmed.</p></div>`;
  const summaryBadge = summary.tone === 'partial' ? '<span class="pill partial">Past code unchecked</span>' : summary.tone === 'unverified' ? '<span class="pill unverified">Not checked</span>' : pill(summary.tone);
  return `<div class="verification-summary verification-${summary.tone}">${summaryBadge}<div><strong>${esc(summary.label)}</strong><p>${esc(summary.detail)}</p></div></div>${abiNotice}${confirmedNotice}${routeNotice}${retryNote ? `<div class="next-step" role="status">${esc(retryNote)}</div>` : ''}${rows}${archiveNextStep}${action}`;
}
function tokenMetadata(root) {
  const tokens = new Map();
  const visit = node => {
    if (node.token?.address && /^[A-Za-z0-9.$_+-]{1,16}$/.test(node.token.symbol ?? '') && Number.isInteger(node.token.decimals) && node.token.decimals >= 0 && node.token.decimals <= 36) tokens.set(node.token.address.toLowerCase(), node.token);
    for (const child of node.children ?? []) visit(child);
  };
  if (root) visit(root);
  return tokens;
}
function formatRawToken(raw, token) {
  if (!token || !/^\d{1,78}$/.test(String(raw))) return String(raw);
  const digits = BigInt(raw).toString().padStart(token.decimals + 1, '0');
  const whole = token.decimals ? digits.slice(0, -token.decimals) : digits;
  const fraction = token.decimals ? digits.slice(-token.decimals).replace(/0+$/, '') : '';
  return `${whole}${fraction ? `.${fraction}` : ''} ${token.symbol}`;
}
function mappedStorage(effect, token) {
  if (effect.label !== 'balanceOf' || String(effect.before).length > 12000 || String(effect.after).length > 12000) return '';
  try {
    const before = JSON.parse(effect.before);
    const after = JSON.parse(effect.after);
    if (!before || !after || Array.isArray(before) || Array.isArray(after) || typeof before !== 'object' || typeof after !== 'object') return '';
    const addresses = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    if (addresses.length > 20 || !addresses.every(address => /^0x[0-9a-fA-F]{40}$/.test(address) && /^\d{1,78}$/.test(String(before[address] ?? '0')) && /^\d{1,78}$/.test(String(after[address] ?? '0')))) return '';
    return `<div class="storage-map">${addresses.filter(address => String(before[address] ?? '0') !== String(after[address] ?? '0')).map(address => `<div><code>${esc(address)}</code><span>${esc(formatRawToken(before[address] ?? '0', token))} → ${esc(formatRawToken(after[address] ?? '0', token))}</span></div>`).join('')}</div>`;
  } catch { return ''; }
}
function effectHtml(effect, tokens = new Map()) {
  const token = tokens.get(String(effect.address).toLowerCase());
  if (effect.kind === 'asset_transfer') {
    const title = effect.label === 'Transfer' ? 'Token transfer' : `${effect.label || 'Asset'} transfer`;
    return `<div class="item effect-transfer"><span class="pill info">movement</span><div class="item-content"><strong>${esc(title)}</strong><div class="effect-amount">${esc(effect.amount || 'Amount unavailable')}${token ? ` <span>${esc(token.symbol)}</span>` : ''}</div><div class="effect-parties"><div><small>From</small><code>${esc(effect.before || 'unknown')}</code></div><div><small>To</small><code>${esc(effect.after || 'unknown')}</code></div></div><p class="effect-source">Token contract ${esc(effect.address || 'unknown')}${token ? ' · symbol reported by contract via RPC; identity unverified' : ''}</p></div></div>`;
  }
  const title = effect.kind === 'native_balance' ? 'Native balance (wei)' : `${effect.label || 'Storage slot'} changed`;
  const hasValues = effect.before != null && effect.after != null && effect.before !== '' && effect.after !== '';
  const mapped = hasValues ? mappedStorage(effect, token) : '';
  const values = hasValues ? `${esc(short(effect.before))} → ${esc(short(effect.after))}` : 'Before/after values unavailable';
  const detail = hasValues ? `<details><summary>Raw before and after values</summary><div class="raw mono">Before: ${esc(effect.before)}<br>After: ${esc(effect.after)}</div></details>` : '';
  return `<div class="item effect-storage">${pill(effect.severity)}<div class="item-content"><strong>${esc(title)}</strong><p class="mono">${esc(effect.address || 'Address unavailable')}${mapped ? '' : `<br>${values}`}</p>${mapped}${token && mapped ? '<p class="effect-source">Amounts use symbol and decimals reported by this contract via RPC; token identity is unverified.</p>' : ''}${detail}</div></div>`;
}
function measuredEffectsHtml(r, emptyText) {
  const tokens = tokenMetadata(r.call);
  const groups = [
    ['Simulated asset movements', r.effects.filter(effect => effect.kind === 'asset_transfer')],
    ['Simulated native balance changes', r.effects.filter(effect => effect.kind === 'native_balance')],
    ['Simulated storage changes', r.effects.filter(effect => !['asset_transfer', 'native_balance'].includes(effect.kind))],
  ].filter(([, effects]) => effects.length);
  const main = groups.length ? `<p class="effect-intro">These are effects returned by one Tenderly simulation. A transfer shown here is an observed simulation result, not a separate safety warning or proof of the historical execution.</p>${groups.map(([title, effects]) => `<div class="effect-group"><h4>${title} <span>${effects.length}</span></h4>${effects.map(effect => effectHtml(effect, tokens)).join('')}</div>`).join('')}` : `<div class="state-empty"><strong>No measured state changes available</strong><p>${esc(emptyText)}</p></div>`;
  const incomplete = r.simulation?.balanceDataIncompleteCount ? `<div class="notice">${esc(r.simulation.balanceDataIncompleteCount)} native balance diff record(s) lacked before/after values and were not shown as measured changes.</div>` : '';
  const summaries = r.simulation?.balanceSummaryCount ? `<details class="effect-coverage"><summary>About ${esc(r.simulation.balanceSummaryCount)} additional Tenderly balance summaries</summary><p>Tenderly returned balance_change summaries without full balances before and after. They are not native balance diffs. The asset movements and storage changes above come from separate simulation fields.</p></details>` : '';
  return `${main}${incomplete}${summaries}`;
}
function pendingCheckAction(kind) {
  if (kind === 'rpc' || kind === 'bytecode') {
    if (!publicMode) return `<button type="button" class="pending-action" data-pending-action="verify">${kind === 'rpc' ? 'Retry RPC check' : 'Run bytecode check'}</button>`;
    return `<a class="pending-action" href="#${kind === 'rpc' ? 'evidence-checks' : 'target-code'}">View check details</a>`;
  }
  if (kind === 'simulation' && !publicMode && (!communityMode || simulationEnabled)) return '<button type="button" class="pending-action" data-pending-action="simulate">Run simulation</button>';
  const target = ['hash', 'hash_mismatch', 'rpc'].includes(kind) ? 'evidence-checks' : kind === 'decode' ? 'call-path' : ['bytecode', 'archive', 'proxy'].includes(kind) ? 'target-code' : 'simulation-results';
  const label = kind === 'decode' ? 'Review call path' : ['archive', 'proxy'].includes(kind) ? 'View code status' : kind === 'hash' || kind === 'hash_mismatch' ? 'Open hash checks' : 'View limitations';
  return `<a class="pending-action" href="#${target}">${label}</a>`;
}
function confidenceHtml(confidence) {
  if (!confidence) return '';
  const gaps = confidence.gaps ?? [];
  const pendingTitle = gaps.length === 1 ? `Pending check: ${esc(gaps[0].title ?? 'Review missing evidence')}` : `${gaps.length} pending checks`;
  const pending = gaps.length ? `<div class="pending-heading"><strong>${pendingTitle}</strong></div><ul class="pending-checks">${gaps.map(gap => `<li><div><strong>${esc(gap.title ?? 'Review missing evidence')}</strong><p>${esc(gap.label)}</p></div>${pendingCheckAction(gap.kind)}</li>`).join('')}</ul>` : '<p class="checks-complete">All scored checks completed. Review the limitations below.</p>';
  return `<div class="confidence confidence-${esc(confidence.color)}"><div class="confidence-score"><span class="confidence-number">${esc(confidence.score)}<small>/10</small></span><span>Evidence confidence</span></div><div class="confidence-content"><p>How much of this report could be checked. This is not a safety score.</p>${pending}<details><summary>How this was scored</summary><ul>${confidence.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul></details></div></div>`;
}
function priorityExplanation(risk) {
  // The risk engine already records the evidence behind each priority. Show
  // only the strongest contributing signals, without inventing a narrative.
  const reasons = risk.reasons ?? [];
  const strongestScore = Math.max(0, ...reasons.map(reason => Number(reason.score) || 0));
  const grouped = new Map();
  for (const reason of reasons.filter(reason => Number(reason.score) === strongestScore)) {
    const stage = /^(Scheduled|Called): (.*)$/.exec(reason.message);
    const key = stage?.[2] ?? reason.message;
    const item = grouped.get(key) ?? { message: key, stages: new Set() };
    if (stage) item.stages.add(stage[1]);
    grouped.set(key, item);
  }
  const drivers = [...grouped.values()].slice(0, 3).map(item => item.stages.size === 2 ? `Scheduled and called: ${item.message}` : item.stages.size === 1 ? `${[...item.stages][0]}: ${item.message}` : item.message);
  const why = drivers.length
    ? `<ul>${drivers.map(message => `<li>${esc(message)}</li>`).join('')}</ul>`
    : '<p>No specific driver was returned. Inspect the decoded call path before relying on this priority.</p>';
  return `<div class="priority-explanation"><strong>Why ${esc(risk.reviewPriority)} priority</strong>${why}<small>Based on ${esc(risk.basis || 'the available transaction evidence')}.</small></div>`;
}
function lifecycleStatus(r, stale = false, source = r.evidence?.source) {
  const tx = r.transaction;
  const onchain = source === 'onchain_execution';
  if (tx.isExecuted && tx.isSuccessful === true) return { kind: 'success', label: 'Executed successfully', detail: onchain ? 'Confirmed by the onchain Safe ExecutionSuccess event.' : 'Reported by the transaction source; the execution event has not been checked independently here.' };
  if (tx.isExecuted && tx.isSuccessful === false) return { kind: 'failure', label: 'Executed · Safe call failed', detail: onchain ? 'Confirmed by the onchain Safe ExecutionFailure event. The outer Ethereum transaction may still have succeeded.' : 'Reported by the transaction source; the execution event has not been checked independently here.' };
  if (tx.isExecuted) return { kind: 'unknown', label: 'Executed · outcome unknown', detail: 'An execution is reported, but its Safe success or failure was not established.' };
  if (stale) return { kind: 'stale', label: 'Unexecuted · obsolete nonce', detail: 'No execution is recorded by this source, and its nonce is below the reported current Safe nonce.' };
  if (source === 'safe_api_untrusted') return { kind: 'unsigned', label: 'Unsigned record', detail: 'The Safe service returned this record without a trusted owner signature; no execution is recorded.' };
  if (['safe_api', 'safe_gateway'].includes(source)) return { kind: 'pending', label: 'Pending · not executed', detail: 'The Safe service reports no execution. This does not independently prove the proposal is still executable.' };
  return { kind: 'unconfirmed', label: 'Execution not established', detail: 'The supplied data does not prove that this transaction is queued or executed onchain.' };
}
function lifecycleBadge(state) {
  return `<span class="lifecycle-badge lifecycle-${state.kind}">${esc(state.label)}</span>`;
}
function reportHtml(r, retryNote = '') {
  const tx = r.transaction;
  const safeUiKnown = r.network !== 'kat';
  const safeUrl = safeUiKnown ? `https://app.safe.global/home?safe=${encodeURIComponent(`${r.network === 'xlayer' ? 'okb' : r.network}:${tx.safe}`)}` : `https://katanascan.com/address/${encodeURIComponent(tx.safe)}`;
  const evidence = r.evidence?.source === 'onchain_execution'
    ? `<div class="notice" style="margin:16px 28px 0"><strong>Verified from ${esc(r.network)} onchain execution</strong> · block ${esc(r.evidence.blockNumber)}${r.evidence.blockTime ? ` · ${esc(r.evidence.blockTime)}` : ''}<br>Execution transaction: <span class="mono">${esc(r.evidence.executionHash)}</span>. ${r.evidence.discoveredBy === 'etherscan_index' ? 'Located through an indexed Safe event. ' : ''}The call graph comes from its execTransaction calldata. State changes below require a separate trace or simulation.</div>`
    : ['safe_api', 'safe_api_untrusted', 'safe_gateway'].includes(r.evidence?.source)
      ? `<div class="notice" style="margin:16px 28px 0"><strong>Fetched live from ${r.evidence.source === 'safe_api_untrusted' ? 'Safe Transaction Service (unsigned record)' : r.evidence.source === 'safe_api' ? 'Safe Transaction Service' : 'Safe Client Gateway'}</strong> · ${esc(r.evidence.retrievedAt)}<br>The Safe address, nonce, target and calldata came from this source. The EIP-712 hash is recalculated locally; check the RPC result and any limitations below.</div>`
      : '';
  const actionLabels = new Map(r.actions.map(action => [action.path, action.label]));
  const flow = `<p class="flow-guide">Each call shows decoded calldata, its likely meaning, and how its function name was checked. Open “Source and limits” for full arguments and evidence.</p><div class="flow-map"><div class="flow-origin"><span class="flow-kind">Safe transaction</span><strong>Nonce ${esc(tx.nonce)}</strong><span class="mono">${esc(tx.safe)}</span></div><ul class="flow-root">${flowHtml(r.call, '1', actionLabels)}</ul></div><details class="graph-extra"><summary>Explore this call tree as an interactive graph</summary><div class="graph-shell"><div class="graph-top"><strong>Interactive call graph</strong><span>Drag to pan · scroll or pinch to zoom · select a node</span></div><div class="call-graph" role="img" aria-label="Interactive graph of calls encoded in this Safe transaction"></div><div class="graph-selection" aria-live="polite"></div></div></details>`;
  const actionSummary = r.risk.actionRatings.map(action => `<div class="planned-action">${pill(action.level)}<div><span class="action-stage">${esc(action.stage === 'schedule' ? 'Encoded to schedule' : 'Encoded to call')} · interpretation</span><strong>${esc(action.label)}</strong><p>${esc(action.reason)}</p></div></div>`).join('');
  const riskReasons = r.risk.reasons.filter(reason => !/^(Called|Scheduled):/.test(reason.message)).map(reason => `<div class="semantic-reason">${pill(reason.level)}<span>${esc(reason.message)}</span></div>`).join('');
  const confidence = confidenceHtml(r.confidence);
  const riskHtml = `${confidence}<div class="risk-summary"><div>${pill(r.risk.level)}<strong>${esc(r.risk.reviewPriority)} review priority</strong><span>${esc(r.risk.impactLevel)} potential impact</span></div>${priorityExplanation(r.risk)}<p>Priority reflects the possible impact of the decoded calls. It does not say the transaction is malicious or prove what will happen onchain.</p></div>${riskReasons}`;
  const checks = r.checks.map(c => `<div class="item">${pill(c.status)}<div class="item-content"><strong>${esc(c.name)}</strong><p class="mono">${esc(c.detail)}</p></div></div>`).join('');
  const findings = r.findings.length ? r.findings.map(f => `<div class="item">${pill(f.severity)}<div class="item-content"><strong>${esc(f.code)} · call ${esc(f.path)}</strong><p>${esc(f.message)}</p></div></div>`).join('') : '<p class="meta">No known intent pattern matched. This does not establish safety.</p>';
  const emptyEffects = r.simulation?.unavailable ? 'Simulation was unavailable, so no state change was measured.' : r.simulation && r.simulation.stateDiffAvailable === false ? 'The simulation provider did not return a storage diff. Absence of a diff is not evidence of no change.' : r.simulation ? 'The simulation returned no complete storage, balance, or asset changes in its response.' : 'No simulation or execution trace has measured these changes yet.';
  const effects = measuredEffectsHtml(r, emptyEffects);
  const sim = r.simulation ? r.simulation.unavailable ? `<div class="notice">Simulation unavailable: ${esc(r.simulation.unavailable)}</div>` : `<div class="item">${pill(r.simulation.mode === 'conditional_threshold_override' ? 'warning' : r.simulation.success === true ? 'pass' : r.simulation.success === false ? 'fail' : 'unavailable')}<div class="item-content"><strong>${r.simulation.mode === 'conditional_threshold_override' ? 'Conditional preview with temporary 1-of-N threshold' : r.simulation.success === true ? 'Safe execution succeeded in simulation' : r.simulation.success === false ? 'Safe execution failed in simulation' : 'EVM completed; Safe inner result unverified'}</strong><p>Block: ${esc(r.simulation.blockNumber)}${r.simulation.error ? ` · ${esc(r.simulation.error)}` : ''}${!publicFacing && r.simulation.url ? ` · <a href="${esc(r.simulation.url)}" target="_blank" rel="noopener noreferrer">Open Tenderly trace (project access required)</a>` : ''}</p><p>${r.simulation.mode === 'conditional_threshold_override' ? 'Tenderly temporarily treated the Safe as 1-of-N and simulated an approved-hash signature from a verified owner. This previews one possible call path, not whether the actual owners will approve or the real Safe execution will pass. The override exists only inside this simulation.' : 'The measured effects shown here come from Tenderly’s API response.'} A dashboard trace saved in the service’s project is not publicly accessible unless its owner enables sharing.</p></div></div>` : '<p class="meta">Simulation has not been run for this transaction.</p>';
  const simulateAction = publicMode ? '<p class="meta">Simulation is available in the local tool with your own Tenderly credentials.</p>' : communityMode && !simulationEnabled ? '<p class="meta">Simulation is not configured for this public service. Decode and hash checks remain available.</p>' : `<div class="simulation-action"><button type="button" id="run-simulation">${r.simulation ? 'Run simulation again' : 'Run simulation and inspect state changes'}</button><p>Sends this transaction's calldata and signatures to the configured Tenderly project. The saved simulation covers one chain state and execution path.</p></div>`;
  const bytecodeStatus = targetVerificationSummary(r);
  const lifecycle = lifecycleStatus(r);
  const stage = lifecycle.detail;
  return `<div class="report-header"><div class="safe-identity"><span>SAFE MULTISIG · ${esc(r.network)}</span><a href="${esc(safeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${safeUiKnown ? 'Open Safe' : 'Open contract'} ${esc(tx.safe)} on ${safeUiKnown ? 'Safe Global' : 'KatanaScan'}">${esc(tx.safe)} ↗</a><small>${safeUiKnown ? 'Open in Safe' : 'Open in KatanaScan · Safe web UI availability not verified'}</small></div><div class="report-heading">${lifecycleBadge(lifecycle)}<h2>Safe nonce ${esc(tx.nonce)}</h2><span>${esc(stage)}</span></div><div class="hash-line mono">${esc(r.hash)}</div><div class="header-verification">${bytecodeStatus.tone === 'partial' ? '<span class="pill partial">Past code unchecked</span>' : pill(bytecodeStatus.tone)}<span>${esc(bytecodeStatus.label)}</span></div></div>${evidence}${r.warnings.map(w => `<div class="notice" style="margin:16px 28px 0">${esc(w)}</div>`).join('')}${section('1 · Evidence and hash checks', verificationHtml(r))}${section('2 · What this transaction can do', `${riskHtml}${flow}<details class="technical"><summary>Technical details: decoded arguments and raw calldata for this call graph</summary><div class="technical-body">${callHtml(r.call)}${findings}</div></details>`)}${section('3 · Changes encoded in the transaction', `${actionSummary || '<p class="meta">No decoded action available.</p>'}<p class="meta">These are intended calls, not measured state changes. A scheduled call and an execute call can both appear in the same Safe transaction.</p>`)}${section('4 · Target bytecode and verified source', targetChecksHtml(r, retryNote))}${section('5 · Measured effects and simulation', `${sim}${effects}${checks}${simulateAction}`)}${section('Transaction facts', `<div class="field-grid">${field('Safe', tx.safe)}${field('Target', tx.to)}${field('Operation', tx.operation === 1 ? 'Delegatecall' : 'Call')}${field('Nonce', tx.nonce)}${field('Value', `${tx.value} wei`)}${field('Execution', lifecycle.label)}</div>`)}${section('What this review cannot prove', '<p class="meta">Decoded calldata shows intended calls. Confirm the Safe hash on the signing device, verify target bytecode and delegatecalls, and inspect a simulation trace for actual state changes. A simulation covers one block and one execution path.</p>')}`;
}
function queueHtml(result) {
  const title = result.availability === 'absent' ? 'No Safe contract on this network' : result.scope === 'history' ? 'Executed history' : result.scope === 'both' ? 'Pending and executed' : 'Queued proposals';
  const notices = (result.warnings ?? []).map(warning => `<div class="notice" style="margin:14px 28px">${esc(warning)}</div>`).join('');
  const choices = result.networks?.length > 1 ? `<div class="network-choices"><strong>Choose a network</strong><div>${result.networks.map(chain => `<button type="button" data-network="${esc(chain)}">${esc(chain)}</button>`).join('')}</div></div>` : '';
  const currentNonce = /^\d+$/.test(String(result.safeState?.nonce ?? '')) ? BigInt(result.safeState.nonce) : null;
  const rows = result.reports.map((report, index) => ({ report, index }));
  const obsolete = currentNonce == null || result.scope === 'history' ? [] : rows.filter(({ report: r }) => !r.transaction.isExecuted && /^\d+$/.test(String(r.transaction.nonce)) && BigInt(r.transaction.nonce) < currentNonce);
  const obsoleteIndexes = new Set(obsolete.map(row => row.index));
  const actionable = rows.filter(row => !obsoleteIndexes.has(row.index));
  const rowHtml = ({ report: r, index }, stale = false) => {
    const lifecycle = lifecycleStatus(r, stale, r.evidence?.source ?? result.source);
    const signatures = !r.transaction.isExecuted && result.safeState?.threshold != null ? ` · ${r.transaction.confirmations?.length ?? 0}/${result.safeState.threshold} confirmations reported by service` : '';
    return `<div class="queue-row${stale ? ' queue-row-obsolete' : ''}" data-index="${index}" role="button" tabindex="0">${lifecycleBadge(lifecycle)}${pill(r.risk.reviewPriority)}<strong class="mono">${esc(r.hash)}</strong><p>${esc(lifecycle.detail)} · ${esc(r.network)} · Nonce ${esc(r.transaction.nonce)}${signatures} · ${esc(r.actions.map(action => action.label).join('; ') || r.call.method || r.call.selector)} · ${esc(r.risk.impactLevel)} potential impact</p></div>`;
  };
  const count = obsolete.length ? `${actionable.length} at or above reported Safe nonce ${currentNonce} · ${obsolete.length} obsolete in this page` : `${rows.length} shown`;
  const header = `<div class="queue-header"><h2>${title}</h2><div class="meta mono">${esc(result.safe)} · ${esc(result.networks?.join(', ') ?? result.network)} · ${count} · ${esc(result.source === 'safe_api_untrusted' ? 'Safe Transaction Service · unsigned record' : result.source)}${result.truncated ? ' · more may exist' : ''}</div></div>`;
  const explanation = rows.length ? `<div class="queue-explanation">This list is a preview from the transaction source. Select a transaction to check its target code through RPC and review the full call path.${result.scope !== 'history' ? ' “Unexecuted” means the source has no execution recorded. A nonce below the reported current Safe nonce cannot execute if that nonce is accurate; confirm it independently onchain. Priority labels describe potential impact if executed, not whether a proposal is malicious.' : ''}</div>` : '';
  const empty = result.availability === 'absent' ? `<div class="empty"><h2>No Safe contract on ${esc(result.network)}</h2><p>The selected RPC found no bytecode at this address on this network. Check the chain prefix in your Safe URL; this tool will not silently switch chains.</p></div>` : result.availability === 'unavailable' ? `<div class="empty"><h2>Queue source unavailable</h2><p>${result.source === 'tenderly_storage' ? 'The monitor JSON did not contain complete transaction details for this filter.' : 'Neither Safe Transaction Service nor Safe Client Gateway returned the offchain proposals. The notice above shows both responses.'}</p></div>` : `<div class="empty"><h2>No ${esc(title.toLowerCase())} in the returned range</h2><p>Check the coverage notice above before interpreting an empty list.</p></div>`;
  const staleSection = obsolete.length ? `<details class="obsolete-list"><summary>${obsolete.length} obsolete proposals in this page · nonce below ${currentNonce}</summary><p>Kept for historical review. They are still marked unexecuted by the service, but their nonce is below the current nonce reported by the same source.</p>${obsolete.map(row => rowHtml(row, true)).join('')}</details>` : '';
  return `${header}${choices}${notices}${explanation}${actionable.map(row => rowHtml(row)).join('')}${!actionable.length && obsolete.length ? '<div class="queue-explanation">No proposals at or above the current Safe nonce were returned.</div>' : ''}${staleSection}${!rows.length ? empty : ''}`;
}
function builderHtml(r) {
  const actions = r.risk.actionRatings.map(action => `<div class="semantic-action">${pill(action.level)}<div><strong>${action.stage === 'schedule' ? 'Would schedule' : 'Would execute'}: ${esc(action.label)}</strong><p>${esc(action.reason)}<br><span class="mono">${esc(action.to)}</span></p></div></div>`).join('');
  const comparison = `<div class="item">${pill(r.comparison.status)}<div class="item-content"><strong>Safe hash and JSON comparison</strong><p>${esc(r.comparison.detail)}${r.comparison.safeHash ? `<br>Verified hash: <span class="mono">${esc(r.comparison.safeHash)}</span> · nonce ${esc(r.comparison.nonce)}` : ''}</p></div></div>`;
  const findings = r.findings.map(f => `<div class="item">${pill(f.severity)}<div class="item-content"><strong>${esc(f.code)} · call ${esc(f.path)}</strong><p>${esc(f.message)}</p></div></div>`).join('');
  return `<div class="report-header">${pill('BUILDER PLAN')}<h2>${esc(r.name)}</h2><div class="meta mono">Safe: ${esc(r.safe ?? 'not supplied')} · chain ${esc(r.chainId)} · ${r.calls.length} top-level calls</div></div>${r.warnings.map(w => `<div class="notice" style="margin:16px 28px 0">${esc(w)}</div>`).join('')}${section('Safe hash comparison', `${comparison}<p class="meta">A Builder export omits Safe nonce and gas fields. Its metadata checksum is not a Safe transaction hash.</p>`)}${section('What the JSON plans to do', `<div class="risk-summary"><div>${pill(r.risk.reviewPriority)}<strong>${esc(r.risk.reviewPriority)} review priority</strong><span>${esc(r.risk.impactLevel)} potential impact · decoded JSON only</span></div>${priorityExplanation(r.risk)}<p>${esc(r.risk.note)}</p></div>${actions}`)}${section('Decoded call path', `${r.calls.map(callHtml).join('')}${findings}`)}${section('What this review cannot prove', '<p class="meta">This is an unsigned Builder plan. To compare it with a Safe transaction, enter its Safe hash above. A pending hash needs the Safe Transaction Service; a recent executed hash can also be found through Ethereum RPC.</p>')}`;
}
function showTransactionReport(result, retryNote = '') {
  // Reuse the already resolved transaction for simulation. A queue row may
  // have come from a monitor even when a fresh Safe API lookup hits quota.
  activeReportInput = result.transaction;
  activeReportNetwork = result.network;
  activeReportEvidence = result.evidence ?? null;
  activeReportTargetChecks = result.targetChecks ?? null;
  report.innerHTML = reportHtml(result, retryNote);
  showCallGraph(result);
  report.querySelector('#run-simulation')?.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, simulate: true });
  });
  report.querySelector('#verify-targets')?.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, verifyTargets: true, retryTargets: true });
  });
  report.querySelectorAll('[data-pending-action]').forEach(button => button.addEventListener('click', event => {
    event.currentTarget.disabled = true;
    if (event.currentTarget.dataset.pendingAction === 'simulate') inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, simulate: true });
    else inspect({ overrideInput: activeReportInput, overrideNetwork: activeReportNetwork, verifyTargets: true, retryTargets: true });
  }));
}
async function inspect({ silent = false, overrideInput = null, overrideNetwork = null, simulate = false, verifyTargets = !publicMode && (!communityMode || ['hash', 'json'].includes(selectedInputMode())), retryTargets = false } = {}) {
  const selectedInput = overrideInput ?? importedJson ?? input.value.trim();
  const previousTargetChecks = retryTargets ? activeReportTargetChecks : null;
  const priorEvidence = simulate || verifyTargets ? activeReportEvidence : null;
  const priorHash = simulate || verifyTargets ? activeReportInput?.safeTxHash : null;
  const priorTargetChecks = simulate ? activeReportTargetChecks : null;
  if (!selectedInput) return;
  if (!silent) { submit.disabled = true; status.textContent = simulate ? 'Simulating Safe execution and measuring state changes…' : 'Inspecting Safe data and recalculating hashes…'; }
  try {
    const isJson = selectedInputMode() === 'json';
    const response = await fetch('/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: selectedInput, network: overrideNetwork ?? selectedNetwork(), scope: scope.value, simulate, verifyTargets, decodeCandidates: true, safeAddress: isJson ? safeAddress.value.trim() || undefined : undefined, safeHash: isJson ? safeHash.value.trim() || undefined : undefined }) });
    const result = await response.json().catch(() => null);
    if (!result || !response.ok) {
      const failure = new Error(result?.error ?? 'The service returned an unexpected response. Please retry.');
      failure.code = result?.code ?? (response.status === 429 ? 'USAGE_LIMIT' : 'SERVICE_ERROR');
      failure.incidentId = result?.incidentId ?? null;
      throw failure;
    }
    report.classList.remove('empty');
    document.body.classList.add('has-report');
    if (result.kind === 'builder') { report.innerHTML = builderHtml(result); status.textContent = 'Builder JSON decoded'; }
    else if (result.kind === 'queue') {
      if (result.availability === 'unavailable' || result.availability === 'absent') { report.innerHTML = queueHtml(result); status.textContent = result.availability === 'absent' ? 'No Safe contract on selected network' : 'Queue source unavailable'; return; }
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
              const label = finalReport.transaction.isExecuted ? lifecycleStatus(finalReport).label : 'No longer pending';
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
        const open = () => {
          const selected = result.reports[Number(row.dataset.index)];
          report.innerHTML = '<div class="empty" role="status"><h2>Checking this transaction</h2><p>Reading its target contracts through RPC and checking available source. The full report will appear when those checks finish.</p></div>';
          status.textContent = 'Checking target contracts through RPC…';
          inspect({ overrideInput: selected.transaction, overrideNetwork: selected.network, verifyTargets: !publicMode });
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
    } else { if (priorHash?.toLowerCase() === result.hash?.toLowerCase()) { if (priorEvidence) result.evidence = priorEvidence; if (priorTargetChecks?.length) result.targetChecks = priorTargetChecks; } const retryNote = retryTargets ? JSON.stringify(previousTargetChecks) === JSON.stringify(result.targetChecks) ? 'Checked again: no new bytecode evidence. This RPC and Sourcify returned the same result. Review the reason below or use another trusted RPC locally.' : 'Checked again: bytecode evidence changed. Review the updated status and contract details below.' : ''; showTransactionReport(result, retryNote); status.textContent = retryTargets ? 'Bytecode check completed' : simulate ? 'Simulation reviewed' : 'Inspection complete'; if (watch.checked) { watch.checked = false; clearInterval(timer); timer = null; } }
  } catch (error) {
    const recorded = error.incidentId ? `<p class="meta">We recorded this issue to improve the service. Reference: <code>${esc(error.incidentId)}</code></p>` : '';
    const limited = error.code === 'USAGE_LIMIT' || error.code === 'UPSTREAM_LIMITED';
    const support = limited ? '<div class="limit-support"><strong>Help us increase public capacity</strong><p>Donations and infrastructure sponsors can fund more transaction lookups, RPC access, and simulations. They do not bypass this limit or guarantee immediate availability.</p><div><a href="#community-support">Donation options</a><a href="https://x.com/rriescog" target="_blank" rel="noopener noreferrer">Sponsor the service ↗</a></div></div>' : '';
    status.textContent = limited ? 'Request limit reached' : error.code === 'INVALID_OR_UNAVAILABLE_INPUT' || error.code === 'TRANSACTION_UNAVAILABLE' ? 'Check the input or network' : 'Sorry, we could not complete the inspection';
    report.innerHTML = `<div class="empty"><h2>${limited ? 'Request limit reached' : error.code === 'INVALID_OR_UNAVAILABLE_INPUT' || error.code === 'TRANSACTION_UNAVAILABLE' ? 'We could not inspect this input' : 'Sorry, something went wrong'}</h2><p>${esc(error.message)}</p>${recorded}${support}</div>`;
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
watch.addEventListener('change', () => { if (publicFacing || !loopbackHost) { watch.checked = false; return; } clearInterval(timer); timer = null; watchInput = null; if (watch.checked) { scope.value = 'pending'; watchInput = safeAddress.value.trim() || input.value.trim(); inspect({ overrideInput: watchInput }); timer = setInterval(() => inspect({ silent: true, overrideInput: watchInput }), 30000); } });
scope.addEventListener('change', () => { if (watch.checked && scope.value !== 'pending') { watch.checked = false; clearInterval(timer); timer = null; } });
jsonChoose.addEventListener('click', () => jsonFile.click());
async function importJsonFile(file) {
  if (!file) return;
  try {
    const limit = publicFacing ? 262144 : 5000000;
    if (file.size > limit) throw new Error(`JSON file exceeds ${publicFacing ? '256 KB' : '5 MB'}`);
    const contents = await file.text();
    if (new TextEncoder().encode(contents).length > limit) throw new Error(`JSON file exceeds ${publicFacing ? '256 KB' : '5 MB'}`);
    const parsed = JSON.parse(contents);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object');
    importedJson = parsed;
    inputMode.value = 'json';
    input.value = `Imported ${file.name.slice(0, 120)}`;
    jsonDropHint.textContent = file.name.slice(0, 120);
    updateWizard();
    if (!safeAddress.value && parsed.meta?.createdFromSafeAddress) safeAddress.value = parsed.meta.createdFromSafeAddress;
    status.textContent = `Imported ${file.name.slice(0, 120)}. Decoding…`;
    await inspect();
  } catch (error) { status.textContent = `Could not import JSON: ${error.message}`; }
}
jsonFile.addEventListener('change', () => importJsonFile(jsonFile.files?.[0]));
for (const name of ['dragenter', 'dragover']) jsonDrop.addEventListener(name, event => { event.preventDefault(); event.stopPropagation(); jsonDrop.classList.add('dragging'); });
jsonDrop.addEventListener('dragleave', event => { event.preventDefault(); event.stopPropagation(); jsonDrop.classList.remove('dragging'); });
jsonDrop.addEventListener('drop', event => {
  event.preventDefault(); event.stopPropagation(); jsonDrop.classList.remove('dragging');
  if (event.dataTransfer?.files?.length !== 1) { status.textContent = 'Choose exactly one JSON file'; return; }
  importJsonFile(event.dataTransfer.files[0]);
});
