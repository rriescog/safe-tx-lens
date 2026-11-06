import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve as pathResolve } from 'node:path';
import vm from 'node:vm';
import { analyze } from '../src/analyze.mjs';
import { analyzeBuilderExport } from '../src/builder.mjs';

const sourcePath = pathResolve('web/app.js');
const source = await readFile(sourcePath, 'utf8');

function ui({ publicMode = false } = {}) {
  const elements = new Map();
  const selectors = new Map();
  const make = () => ({ value: '', textContent: '', innerHTML: '', checked: false, disabled: false, dataset: {}, classList: { add() {}, remove() {} }, addEventListener(name, handler) { this[`on_${name}`] = handler; }, querySelector() { return make(); }, querySelectorAll() { return []; }, insertAdjacentHTML(_position, value) { this.innerHTML += value; }, focus() { this.focused = true; } });
  const document = { body: make(), getElementById(id) { if (!elements.has(id)) elements.set(id, make()); return elements.get(id); }, querySelector(selector) { if (!selectors.has(selector)) selectors.set(selector, make()); return selectors.get(selector); } };
  document.body.dataset.publicMode = String(publicMode);
  const context = vm.createContext({ document, URL, setInterval: () => 1, clearInterval: () => {}, console, fetch: async () => { throw new Error('Unexpected network call'); } });
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
});

test('argument summaries keep large bytes collapsed and render structured arguments', () => {
  const page = ui();
  page.context.sample = { children: [{}] };
  assert.match(page.evaluate('argValue({name:"datas",value:["0x12","0x34"]},sample)'), /2 payloads/);
  assert.match(page.evaluate(`argValue({name:"payload",value:"0x${'12'.repeat(80)}"},sample)`), /80 bytes/);
  assert.equal(page.evaluate('argValue({name:"amount",value:7},sample)'), '7');
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
  assert.equal(page.elements.get('status').textContent, 'Inspection failed');
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
  for (const phrase of ['Safe nonce 7', 'Safe Transaction Service', 'Target bytecode and verified source', 'Matching verified runtime bytecode', 'asset_transfer', 'Safe execution succeeded in simulation', 'Technical details']) assert.match(html, new RegExp(phrase));
  review.evidence = { source: 'onchain_execution', blockNumber: 1, blockTime: 'now', executionHash: review.hash, discoveredBy: 'etherscan_index' };
  page.context.sample = review;
  assert.match(page.evaluate('reportHtml(sample)'), /Verified from eth onchain execution/);
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
