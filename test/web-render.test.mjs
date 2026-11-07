import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import vm from 'node:vm';
import { analyze } from '../src/analyze.mjs';
import { analyzeBuilderExport } from '../src/builder.mjs';

const sourcePath = pathResolve('web/app.js');
const source = await readFile(sourcePath, 'utf8');

function ui({ publicMode = false, search = '' } = {}) {
  const elements = new Map();
  const selectors = new Map();
  const make = () => ({ value: '', textContent: '', innerHTML: '', checked: false, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener(name, handler) { this[`on_${name}`] = handler; }, querySelector() { return make(); }, querySelectorAll() { return []; }, insertAdjacentHTML(_position, value) { this.innerHTML += value; }, focus() { this.focused = true; } });
  const document = { body: make(), getElementById(id) { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); }, querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, make()); return selectors.get(selector); } };
  document.body.dataset.publicMode = String(publicMode);
  const context = vm.createContext({ document, URL, location: { search }, setInterval: () => 1, clearInterval: () => {}, console, fetch: async () => { throw new Error('Unexpected network call'); } });
  vm.runInContext(source, context, { filename: sourcePath });
  return { context, elements, selectors, document, evaluate: expression => vm.runInContext(expression, context) };
}

test('web renderer escapes untrusted calldata and addresses', () => {
  const page = ui();
  assert.equal(page.evaluate('esc(`<script>"&`)'), '&lt;script&gt;&quot;&amp;');
  assert.match(page.evaluate('callHtml({to:"<img>",value:"0",operation:0,data:"0x",children:[]})'), /&lt;img&gt;/);
  assert.doesNotMatch(page.evaluate('callHtml({to:"<img>",value:"0",operation:0,data:"0x",children:[]})'), /<img>/);
});

test('public UI disables wallet monitoring and labels its owner-key limitations', () => {
  const page = ui({ publicMode: true });
  assert.equal(page.elements.get('network').value, 'eth');
  assert.equal(page.selectors.get('.watch-control').hidden, true);
  assert.match(page.selectors.get('.local-note').textContent, /no owner API keys/);
  assert.equal(page.selectors.get('#network option[value="auto"]').disabled, true);
  page.elements.get('watch').checked = true;
  page.elements.get('watch').on_change();
  assert.equal(page.elements.get('watch').checked, false);
  assert.doesNotMatch(page.evaluate('targetChecksHtml({})'), /id="verify-targets"/);
});

test('deep link prefills only a valid transaction hash without fetching data', () => {
  const hash = `0x${'a'.repeat(64)}`;
  const page = ui({ search: `?hash=${hash}` });
  assert.equal(page.elements.get('input').value, hash);
  assert.match(page.elements.get('status').textContent, /Select Review transaction/);
  const invalid = ui({ search: '?hash=%3Cscript%3E' });
  assert.equal(invalid.elements.get('input').value, '');
});

test('verification panel distinguishes supplied data, a user hash, local calculation, and RPC', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const report = await analyze(tx, 'eth', { fetchState: false });
  report.evidence = { source: 'safe_api', requestedHash: report.hash };
  report.checks[0].status = 'pass';
  report.checks.push({ name: 'Safe contract hash', status: 'pass', detail: report.hash });
  page.context.sample = report;
  const html = page.evaluate('verificationHtml(sample)');
  assert.match(html, /Transaction Service/);
  assert.match(html, /Hash supplied by you/);
  assert.match(html, /Local EIP-712 calculation/);
  assert.match(html, /Safe contract calculation by RPC/);
  assert.match(html, /consistency, not an independent source/);
  assert.match(html, /API confirmations are not independently verified/);
  page.context.sample = { ...report, safeState: { source: 'safe_api' } };
  assert.match(page.evaluate('verificationHtml(sample)'), /does not independently validate every API confirmation/);
  page.context.sample = { ...report, evidence: undefined, checks: [report.checks[0]], safeState: null };
  assert.match(page.evaluate('verificationHtml(sample)'), /No separate Safe transaction hash was supplied/);
  assert.match(page.evaluate('verificationHtml(sample)'), /No contract hash result is available/);
  assert.match(page.evaluate('crossCheckHtml(sample)'), /not the data source/);
});

test('bytecode status and RPC provenance distinguish completed, partial, and unrun checks', () => {
  const page = ui();
  const target = '0x2222222222222222222222222222222222222222';
  const base = { network: 'eth', targetVerificationAttempted: false, targetChecks: [] };
  page.context.sample = base;
  assert.match(page.evaluate('targetChecksHtml(sample)'), /Bytecode check not run/);
  assert.match(page.evaluate('targetChecksHtml(sample)'), /Verify target bytecode/);
  page.context.sample = { ...base, targetVerificationAttempted: true, targetChecks: [{ address: target, status: 'verified', reason: 'matched', blockTag: 'latest' }] };
  assert.match(page.evaluate('targetChecksHtml(sample)'), /Verified bytecode · 1\/1/);
  assert.doesNotMatch(page.evaluate('targetChecksHtml(sample)'), /id="verify-targets"/);
  page.context.sample = { ...base, targetVerificationAttempted: true, targetChecks: [{ address: target, status: 'verified_current', reason: 'current only', blockTag: 'latest' }] };
  assert.match(page.evaluate('targetChecksHtml(sample)'), /current state/);
  page.context.sample = { ...base, targetVerificationAttempted: true, targetChecks: [{ address: target, status: 'verified', reason: 'matched', blockTag: 'latest', abiSelectors: [{ selector: '0x12345678', present: false }] }] };
  assert.match(page.evaluate('targetChecksHtml(sample)'), /ABI selector mismatch/);
  page.context.sample = { ...base, targetVerificationAttempted: true, targetChecks: [{ address: target, status: 'mismatch', reason: 'different bytecode', blockTag: 'latest' }] };
  assert.match(page.evaluate('targetChecksHtml(sample)'), /Bytecode mismatch/);
  const rpc = { checks: [], evidence: {}, transaction: {}, rpc: { kind: 'public', label: 'PublicNode (ethereum.publicnode.com)' } };
  page.context.sample = rpc;
  assert.match(page.evaluate('verificationHtml(sample)'), /PublicNode \(ethereum\.publicnode\.com\)/);
  assert.match(page.evaluate('verificationHtml(sample)'), /you did not provide an RPC key/);
  page.context.sample = { ...rpc, rpc: { kind: 'configured', label: 'RPC configured for eth' } };
  assert.doesNotMatch(page.evaluate('verificationHtml(sample)'), /provider\.example|secret/);
});

test('simulation display does not fabricate empty native balance values', async () => {
  const page = ui();
  page.context.sample = { severity: 'warning', kind: 'native_balance', address: '0x1111111111111111111111111111111111111111', before: '', after: '' };
  const row = page.evaluate('effectHtml(sample)');
  assert.match(row, /Before\/after values unavailable/);
  assert.doesNotMatch(row, /<div class="raw mono">Before:/);
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const report = await analyze(tx, 'eth', { fetchState: false, verifyTargets: false });
  page.context.sample = { ...report, simulation: { balanceDataIncompleteCount: 2, stateDiffAvailable: false }, effects: [] };
  assert.match(page.evaluate('reportHtml(sample)'), /2 balance-change record\(s\) without complete before\/after values/);
});

test('public report opens without requesting bulk target verification', async () => {
  const page = ui({ publicMode: true });
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  page.elements.get('input').value = review.hash;
  page.elements.get('safe-address').value = tx.safe;
  page.elements.get('safe-hash').value = `0x${'ff'.repeat(32)}`;
  let requested;
  page.context.fetch = async (_url, options) => { requested = JSON.parse(options.body); return { ok: true, json: async () => review }; };
  await page.evaluate('inspect()');
  assert.equal(requested.verifyTargets, false);
  assert.equal(requested.safeAddress, undefined);
  assert.equal(requested.safeHash, undefined);
  assert.match(page.elements.get('report').innerHTML, /Evidence and hash checks/);
  assert.match(page.elements.get('independent-checks').innerHTML, /Outside|pcaversaccio/);
  assert.doesNotMatch(page.elements.get('report').innerHTML, /id="verify-targets"/);
});

test('input wizard shows only the fields for the selected input and auto-detects pasted values', () => {
  const page = ui();
  const mode = page.elements.get('input-mode');
  const input = page.elements.get('input');
  mode.value = 'safe';
  mode.on_change();
  assert.equal(page.elements.get('scope-group').hidden, false);
  assert.equal(page.elements.get('safe-actions').hidden, false);
  assert.equal(page.elements.get('json-options').hidden, true);
  mode.value = 'json';
  mode.on_change();
  assert.equal(page.elements.get('json-import').hidden, false);
  assert.equal(page.elements.get('json-options').hidden, false);
  assert.equal(page.elements.get('scope-group').hidden, true);
  assert.match(page.elements.get('network-help').textContent, /chain for this export/);
  mode.value = 'url';
  mode.on_change();
  assert.equal(page.elements.get('network-group').hidden, true);
  mode.value = 'auto';
  input.value = '0x1111111111111111111111111111111111111111';
  input.on_input();
  assert.equal(page.elements.get('safe-actions').hidden, false);
  input.value = `0x${'ab'.repeat(32)}`;
  input.on_input();
  assert.equal(page.elements.get('scope-group').hidden, true);
  assert.match(page.elements.get('mode-help').textContent, /recalculates the Safe hash/);
  input.value = '{"chainId":"1"}';
  input.on_input();
  assert.equal(page.elements.get('json-import').hidden, false);
});

test('argument summaries keep large bytes collapsed and render structured arguments', () => {
  const page = ui();
  page.context.sample = { children: [{}] };
  assert.match(page.evaluate('argValue({name:"datas",value:["0x12","0x34"]},sample)'), /2 payloads/);
  assert.match(page.evaluate(`argValue({name:"payload",value:"0x${'12'.repeat(80)}"},sample)`), /80 bytes/);
  assert.equal(page.evaluate('argValue({name:"amount",value:7},sample)'), '7');
});

test('nested call and flow renderers distinguish scheduling, execution, delegatecall and decode failure', () => {
  const page = ui();
  page.context.sample = {
    to: '0x2222222222222222222222222222222222222222', value: '1', data: '0x12345678', selector: '0x12345678', method: 'schedule(address)',
    operation: 1, stage: 'schedule', via: 'batch call', decodeError: 'bad bytes', args: [{ name: 'payload', value: '0x1234' }],
    children: [{ to: '0x3333333333333333333333333333333333333333', value: '0', data: '0x', selector: '0x', method: null, operation: 0, stage: 'call', children: [] }],
  };
  const rendered = page.evaluate('callHtml(sample)');
  for (const value of ['DELEGATECALL', 'scheduled', 'batch call', 'Decode error', 'call-children']) assert.match(rendered, new RegExp(value));
  assert.match(page.evaluate('flowHtml(sample,"1",new Map())'), /Schedule/);
  page.context.sample = { ...page.context.sample, method: 'execute(address)', stage: 'call', operation: 0, children: [] };
  assert.match(page.evaluate('flowHtml(sample,"1",new Map())'), /Execute/);
  page.context.sample = { ...page.context.sample, method: null, operation: 1, data: '0x12345678' };
  assert.match(page.evaluate('flowHtml(sample,"1",new Map())'), /Delegatecall/);
});

test('render helpers handle absent optional fields and long values', () => {
  const page = ui();
  assert.equal(page.evaluate('esc(null)'), '');
  assert.equal(page.evaluate('short(null)'), '');
  page.context.longValue = `0x${'ab'.repeat(80)}`;
  assert.match(page.evaluate('short(longValue)'), /…/);
  assert.match(page.evaluate('argValue({name:"datas",value:["0x12"]},{})'), /inspect raw calldata/);
  assert.match(page.evaluate(`argValue({name:"payload",value:"0x${'ab'.repeat(80)}"},{})`), /inspect raw calldata/);
  page.context.sample = { to: '0x1', value: '0', data: '0xdeadbeef', selector: '0xdeadbeef', operation: 0, children: [] };
  assert.match(page.evaluate('callHtml(sample)'), /Unknown 0xdeadbeef/);
  assert.match(page.evaluate('targetChecksHtml({})'), /Bytecode check not run/);
});

test('web inspector opens a report, handles unavailable queues and shows API errors', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  page.elements.get('input').value = review.hash;
  page.context.fetch = async () => ({ ok: true, json: async () => review });
  await page.evaluate('inspect()');
  assert.match(page.elements.get('report').innerHTML, /Safe nonce 7/);
  assert.equal(page.elements.get('status').textContent, 'Inspection complete');
  assert.equal(page.elements.get('submit').disabled, false);
  const queue = { kind: 'queue', scope: 'pending', safe: tx.safe, network: 'eth', source: 'unavailable', availability: 'unavailable', truncated: false, warnings: ['quota exhausted'], reports: [] };
  page.context.fetch = async () => ({ ok: true, json: async () => queue });
  await page.evaluate('inspect()');
  assert.equal(page.elements.get('status').textContent, 'Queue source unavailable');
  page.context.fetch = async () => ({ ok: false, json: async () => ({ error: '<unsafe>' }) });
  await page.evaluate('inspect()');
  assert.match(page.elements.get('report').innerHTML, /&lt;unsafe&gt;/);
  assert.match(page.elements.get('status').textContent, /Inspection failed · <unsafe>/);
});

test('web form handles empty input, malformed JSON and an API error without a message', async () => {
  const page = ui();
  await page.evaluate('inspect()');
  assert.equal(page.elements.get('report').innerHTML, '');
  const file = page.elements.get('json-file');
  await file.on_change();
  file.files = [{ size: 2, name: 'broken.json', text: async () => '{' }];
  await file.on_change();
  assert.match(page.elements.get('status').textContent, /Could not import JSON/);
  page.elements.get('input').value = '0x123';
  page.context.fetch = async () => ({ ok: false, json: async () => ({}) });
  await page.evaluate('inspect({verifyTargets:false})');
  assert.match(page.elements.get('report').innerHTML, /Inspection failed/);
  page.elements.get('input').value = 'https://app.safe.global/home';
  page.elements.get('load-pending').on_click();
  assert.match(page.elements.get('status').textContent, /Enter a Safe multisig address/);
});

test('web inspect renders a Builder response and preserves evidence on a rerun of the same hash', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const builder = await analyzeBuilderExport({ chainId: '1', meta: { name: 'Plan' }, transactions: [{ to: tx.to, value: '0', data: '0x' }] }, 'eth');
  page.elements.get('input').value = 'plan';
  page.context.fetch = async () => ({ ok: true, json: async () => builder });
  await page.evaluate('inspect()');
  assert.equal(page.elements.get('status').textContent, 'Builder JSON decoded');
  const report = await analyze(tx, 'eth', { fetchState: false });
  report.transaction.safeTxHash = report.hash;
  report.evidence = { source: 'safe_api', retrievedAt: 'now' };
  report.targetChecks = [{ address: tx.to, status: 'unverified', blockTag: 'latest', reason: 'unknown' }];
  page.context.fetch = async () => ({ ok: true, json: async () => report });
  await page.evaluate('inspect()');
  const rerun = { ...report, evidence: undefined, targetChecks: [] };
  page.context.fetch = async () => ({ ok: true, json: async () => rerun });
  await page.evaluate('inspect({simulate:true,overrideInput:activeReportInput,overrideNetwork:activeReportNetwork})');
  assert.match(page.elements.get('report').innerHTML, /Fetched live from Safe Transaction Service/);
  assert.match(page.elements.get('report').innerHTML, /Bytecode check incomplete/);
});

test('web buttons select a Safe, import JSON, and reject oversized files', async () => {
  const page = ui();
  const safe = '0x1111111111111111111111111111111111111111';
  const tx = { safe, to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  page.context.fetch = async () => ({ ok: true, json: async () => ({ kind: 'queue', scope: 'pending', safe, network: 'eth', source: 'safe_api', availability: 'available', truncated: false, warnings: [], reports: [review] }) });
  page.elements.get('input').value = safe;
  page.elements.get('load-pending').on_click();
  await new Promise(done => setImmediate(done));
  assert.equal(page.elements.get('scope').value, 'pending');
  page.elements.get('input').value = '';
  page.elements.get('safe-address').value = '';
  page.elements.get('load-history').on_click();
  assert.equal(page.elements.get('safe-address').focused, true);
  const jsonFile = page.elements.get('json-file');
  jsonFile.files = [{ size: 5000001, name: 'huge.json', text: async () => '{}' }];
  await jsonFile.on_change();
  assert.match(page.elements.get('status').textContent, /exceeds 5 MB/);
  jsonFile.files = [{ size: 200, name: 'safe.json', text: async () => JSON.stringify({ ...tx, meta: { createdFromSafeAddress: safe } }) }];
  await jsonFile.on_change();
  assert.equal(page.elements.get('safe-address').value, safe);
  assert.match(page.elements.get('input').value, /Imported safe.json/);
});

test('watch keeps the execution notice visible when a proposal leaves the queue', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  const queue = reports => ({ kind: 'queue', scope: 'pending', safe: tx.safe, network: 'eth', source: 'safe_api', availability: 'available', truncated: false, warnings: [], reports });
  page.elements.get('input').value = tx.safe;
  page.context.fetch = async () => ({ ok: true, json: async () => queue([review]) });
  await page.evaluate('inspect()');
  let calls = 0;
  page.context.fetch = async () => ({ ok: true, json: async () => ++calls === 1 ? queue([]) : { ...review, transaction: { ...review.transaction, isExecuted: true, isSuccessful: true } } });
  await page.evaluate('inspect({silent:true})');
  assert.match(page.elements.get('report').innerHTML, /Executed successfully/);
  assert.match(page.elements.get('status').textContent, /Executed successfully/);
});

test('queue rows and network choices open the selected Safe transaction', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  const queue = { kind: 'queue', scope: 'pending', safe: tx.safe, network: 'multiple', networks: ['eth', 'pol'], source: 'safe_api', availability: 'available', truncated: false, warnings: [], reports: [review] };
  const networkButton = { dataset: { network: 'eth' }, addEventListener(name, handler) { this[name] = handler; } };
  const row = { dataset: { index: '0' }, addEventListener(name, handler) { this[name] = handler; } };
  const reportElement = page.elements.get('report');
  reportElement.querySelectorAll = selector => selector === '[data-network]' ? [networkButton] : selector === '.queue-row' ? [row] : [];
  page.elements.get('input').value = tx.safe;
  page.context.fetch = async (_url, options) => ({ ok: true, json: async () => typeof JSON.parse(options.body).input === 'object' ? review : queue });
  await page.evaluate('inspect()');
  assert.equal(typeof networkButton.click, 'function');
  assert.equal(typeof row.click, 'function');
  networkButton.click();
  await new Promise(done => setImmediate(done));
  assert.equal(page.elements.get('network').value, 'eth');
  row.keydown({ key: 'Enter', preventDefault() {} });
  await new Promise(done => setImmediate(done));
  assert.match(reportElement.innerHTML, /Safe nonce 7/);
});

test('Safe URL buttons preserve the chain and choose the requested scope', async () => {
  const page = ui();
  const safe = '0x1111111111111111111111111111111111111111';
  const requests = [];
  page.context.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ kind: 'queue', scope: 'history', safe, network: 'eth', source: 'safe_api', availability: 'available', truncated: false, warnings: [], reports: [] }) }; };
  page.elements.get('input').value = `https://app.safe.global/transactions/tx?safe=eth:${safe}&id=multisig_${safe}_0x${'1'.repeat(64)}`;
  page.elements.get('load-history').on_click();
  await new Promise(done => setImmediate(done));
  assert.equal(page.elements.get('scope').value, 'history');
  assert.equal(requests[0].input, `https://app.safe.global/home?safe=eth%3A${safe}`);
});

test('report actions can rerun simulation and target verification for the selected transaction', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  const buttons = new Map();
  page.elements.get('report').querySelector = selector => {
    if (!buttons.has(selector)) buttons.set(selector, { addEventListener(name, handler) { this[name] = handler; } });
    return buttons.get(selector);
  };
  page.elements.get('input').value = review.hash;
  const requests = [];
  page.context.fetch = async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => review }; };
  await page.evaluate('inspect()');
  for (const selector of ['#run-simulation', '#verify-targets']) {
    const button = buttons.get(selector);
    button.click({ currentTarget: button });
    await new Promise(done => setImmediate(done));
    assert.equal(button.disabled, true);
  }
  assert.equal(requests[1].simulate, true);
  assert.equal(requests[2].verifyTargets, true);
});

test('web report renders transaction evidence, target verification, effects, and technical details', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false, verifyTargets: false });
  review.evidence = { source: 'safe_api', retrievedAt: 'now' };
  review.targetChecks = [{ address: tx.to, status: 'verified', reason: 'exact match', blockTag: 'latest', bytecodeHash: review.hash, source: 'https://repo.sourcify.dev/1/test', abiSelectors: [{ selector: '0x12345678', present: true }] }];
  review.effects = [{ severity: 'warning', kind: 'asset_transfer', label: 'ERC20', address: tx.to, before: '0', after: '100', amount: '100' }];
  review.simulation = { success: true, blockNumber: 1, url: 'https://dashboard.tenderly.co/test', stateDiffAvailable: true };
  page.context.sample = review;
  const html = page.evaluate('reportHtml(sample)');
  for (const phrase of ['Safe nonce 7', 'Safe Transaction Service', 'Target bytecode and verified source', 'Verified bytecode · 1/1', 'ERC20 transfer', 'Safe execution succeeded in simulation', 'Technical details']) assert.match(html, new RegExp(phrase));
  assert.match(html, /SAFE MULTISIG · eth/);
  assert.match(html, /https:\/\/app\.safe\.global\/home\?safe=eth%3A0x1111111111111111111111111111111111111111/);
  page.context.sample = { ...review, network: 'xlayer' };
  assert.match(page.evaluate('reportHtml(sample)'), /safe=okb%3A0x1111111111111111111111111111111111111111/);
  page.context.sample = { ...review, network: 'kat' };
  assert.match(page.evaluate('reportHtml(sample)'), /katanascan\.com\/address\//);
  page.context.sample = review;
  assert.doesNotMatch(html, /id="verify-targets"/);
  assert.match(html, /project access required/);
  const publicPage = ui({ publicMode: true });
  publicPage.context.sample = review;
  assert.doesNotMatch(publicPage.evaluate('reportHtml(sample)'), /Open Tenderly trace/);
  review.evidence = { source: 'onchain_execution', blockNumber: 1, blockTime: 'now', executionHash: review.hash, discoveredBy: 'etherscan_index' };
  page.context.sample = review;
  assert.match(page.evaluate('reportHtml(sample)'), /Verified from eth onchain execution/);
});

test('web report marks unavailable verification and simulation outcomes explicitly', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const base = await analyze(tx, 'eth', { fetchState: false });
  const variants = [
    { ...base, network: 'zkevm', hashComponents: null, evidence: { source: 'safe_gateway', retrievedAt: 'now' }, simulation: { unavailable: 'quota' }, effects: [], targetChecks: [], findings: [] },
    { ...base, transaction: { ...base.transaction, isExecuted: true, isSuccessful: false, operation: 1 }, simulation: { success: false, blockNumber: 7, error: 'revert', stateDiffAvailable: false }, effects: [], targetChecks: [{ address: tx.to, status: 'unverified', reason: 'missing', blockTag: 'latest', abiWarning: 'no ABI' }] },
    { ...base, transaction: { ...base.transaction, isExecuted: true, isSuccessful: true }, simulation: { success: null, blockNumber: 7, stateDiffAvailable: true }, effects: [], targetChecks: [{ address: tx.to, status: 'verified_current', reason: 'matched', blockTag: 7, proxy: { implementation: tx.safe, implementationCode: { status: 'unverified' } } }] },
  ];
  const html = variants.map(variant => { page.context.sample = variant; return page.evaluate('reportHtml(sample)'); });
  assert.match(html[0], /Safe Client Gateway/);
  assert.match(html[0], /Simulation unavailable: quota/);
  assert.match(html[0], /No separate Safe transaction hash was supplied/);
  assert.match(html[1], /Safe execution failed in simulation/);
  assert.match(html[1], /storage diff/);
  assert.match(html[1], /no ABI/);
  assert.match(html[2], /EVM completed; Safe inner result unverified/);
  assert.match(html[2], /ERC-1967 implementation/);
});

test('web renderers show scheduled actions, proxy uncertainty and missing queue coverage', async () => {
  const page = ui({ publicMode: true });
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  review.risk.actionRatings[0].stage = 'schedule';
  review.targetChecks = [{ address: tx.to, status: 'verified_current', reason: 'current only', blockTag: 7, proxy: { implementation: tx.safe, implementationCode: { status: 'verified', bytecodeHash: review.hash } } }];
  review.effects = [{ severity: 'info', kind: 'storage', address: tx.to, before: '0', after: '1' }];
  page.context.sample = review;
  assert.match(page.evaluate('reportHtml(sample)'), /Encoded to schedule/);
  assert.match(page.evaluate('reportHtml(sample)'), /Simulation is available in the local tool/);
  assert.match(page.evaluate('reportHtml(sample)'), /ERC-1967 implementation/);
  page.context.sample = { ...review, targetChecks: [{ address: tx.to, status: 'unverified', reason: 'no source', blockTag: 7, proxy: { implementation: tx.safe } }] };
  assert.match(page.evaluate('targetChecksHtml(sample)'), /Bytecode check incomplete/);
  page.context.sample = { kind: 'queue', scope: 'history', safe: tx.safe, network: 'eth', source: 'tenderly_storage', availability: 'unavailable', reports: [] };
  assert.match(page.evaluate('queueHtml(sample)'), /monitor JSON did not contain complete/);
  page.context.sample = { kind: 'queue', scope: 'history', safe: tx.safe, network: 'eth', source: 'safe_api', availability: 'available', reports: [{ ...review, actions: [] }] };
  assert.match(page.evaluate('queueHtml(sample)'), /Executed history/);
});

test('report variants expose absent onchain metadata and optional Builder comparison', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const report = await analyze(tx, 'eth', { fetchState: false });
  report.evidence = { source: 'onchain_execution', blockNumber: 7, executionHash: report.hash };
  report.risk.actionRatings = [];
  report.findings = [];
  report.targetChecks = [{ address: tx.to, status: 'unverified', blockTag: 7, reason: 'unknown', abiSelectors: [] }];
  page.context.sample = report;
  const html = page.evaluate('reportHtml(sample)');
  assert.match(html, /No decoded action available/);
  assert.doesNotMatch(html, /Located through an indexed Safe event/);
  const builder = await analyzeBuilderExport({ chainId: '1', meta: { name: 'Plan' }, transactions: [{ to: tx.to, value: '0', data: '0x' }] }, 'eth');
  builder.risk.actionRatings[0].stage = 'schedule';
  builder.comparison = { status: 'match', detail: 'same', safeHash: report.hash, nonce: '7' };
  page.context.sample = builder;
  assert.match(page.evaluate('builderHtml(sample)'), /Would schedule/);
  assert.match(page.evaluate('builderHtml(sample)'), /Verified hash/);
});

test('web queue and Builder renderers distinguish choices, absence and unavailable sources', async () => {
  const page = ui();
  const tx = { safe: '0x1111111111111111111111111111111111111111', to: '0x2222222222222222222222222222222222222222', nonce: '7', value: '0', data: '0x', operation: 0 };
  const review = await analyze(tx, 'eth', { fetchState: false });
  const queue = { kind: 'queue', scope: 'both', safe: tx.safe, network: 'multiple', networks: ['eth', 'pol'], source: 'safe_api', availability: 'available', truncated: true, warnings: ['review warning'], reports: [review] };
  page.context.sample = queue;
  const html = page.evaluate('queueHtml(sample)');
  assert.match(html, /Choose a network/);
  assert.match(html, /review warning/);
  assert.match(html, /queue-row/);
  page.context.sample = { ...queue, reports: [], availability: 'unavailable' };
  assert.match(page.evaluate('queueHtml(sample)'), /Queue source unavailable/);
  page.context.sample = { ...queue, reports: [], availability: 'available' };
  assert.match(page.evaluate('queueHtml(sample)'), /No pending and executed/);
  const builder = await analyzeBuilderExport({ chainId: '1', meta: { name: 'Review' }, transactions: [{ to: tx.to, value: '0', data: '0x' }] }, 'eth');
  page.context.sample = builder;
  assert.match(page.evaluate('builderHtml(sample)'), /Builder plan|Review/);
});
