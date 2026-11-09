import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from './resolve.mjs';
import { parseInput } from './inputs.mjs';
import { isBuilderExport } from './builder.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { publicQuota } from './public-quota.mjs';
import { communityQuota } from './community-quota.mjs';
import { communityMcpHandler } from './community-mcp.mjs';
import { isIP } from 'node:net';
import { validateInspectionRequest } from './input-boundary.mjs';
import { CHAINS } from './chains.mjs';
import { publicSupportConfig } from './support.mjs';
import { randomUUID } from 'node:crypto';

const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));

function reply(res, status, data, type = 'application/json', extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'", ...extraHeaders });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

async function readBody(req, maxBodyBytes) {
  let body = '';
  let bodyBytes = 0;
  for await (const chunk of req) {
    bodyBytes += chunk.length;
    if (bodyBytes > maxBodyBytes) throw new Error('Input too large');
    body += chunk.toString();
  }
  return body;
}

function communityCost(input, network, scope, { simulate = false, verifyTargets = false } = {}) {
  // This reserves an upper-bound estimate, not an exact API call count.
  const kind = parseInput(input, network).kind;
  const base = kind === 'json' ? 1 : kind === 'safe' ? 8 : 6;
  return Math.min(100, base * (network === 'auto' ? 4 : 1) * (scope === 'both' ? 2 : 1) + (verifyTargets ? 15 : 0) + (simulate ? 40 : 0));
}

function denied(res, ticket) {
  const seconds = ticket.retryAfterSeconds ?? 2;
  const error = ticket.reason === 'busy' ? 'The service is busy. Please retry shortly.' : `Usage limit reached. Please try again in ${seconds} seconds.`;
  return reply(res, 429, { error, code: ticket.reason === 'busy' ? 'SERVICE_BUSY' : 'USAGE_LIMIT', retryAfterSeconds: seconds }, 'application/json', { 'Retry-After': String(seconds) });
}

export function redactPrivateSimulationUrl(result) {
  // Public API clients receive measured effects, but cannot assume they have
  // permission to open the owner's saved Tenderly dashboard trace.
  if (result.simulation) delete result.simulation.url;
  for (const report of result.reports ?? []) if (report.simulation) delete report.simulation.url;
  return result;
}

function inspectionFailure(res, error, recordIncident) {
  const message = String(error.message ?? 'Inspection failed').slice(0, 600);
  const upstreamLimited = /Safe API 429|Safe Client Gateway 429|Safe API rate limit or quota is cooling down|Safe API quota is exhausted|monthly quota exhausted/i.test(message);
  const onchainFailed = /Onchain execution source unavailable/i.test(message);
  const upstreamFailed = /Safe API 5\d\d|Safe Client Gateway 5\d\d|Safe Client Gateway 403|Safe API 403|Onchain execution source unavailable/i.test(message);
  if (upstreamLimited || upstreamFailed) {
    const incidentId = recordIncident(upstreamLimited ? 'upstream_limit' : 'upstream_unavailable', 503);
    return reply(res, 503, { error: upstreamLimited ? 'Sorry, the transaction source is at its request limit. Please retry later or choose another input. We recorded this interruption to improve the service.' : onchainFailed ? 'The Safe execution was found onchain, but the RPC could not return its full details. Please retry shortly or choose a reliable RPC locally. We recorded this interruption.' : 'Sorry, the transaction source is unavailable. Please retry later or use a transaction JSON export. We recorded this interruption to improve the service.', code: upstreamLimited ? 'UPSTREAM_LIMITED' : onchainFailed ? 'RPC_UNAVAILABLE' : 'UPSTREAM_UNAVAILABLE', incidentId });
  }
  if (/Safe API 404|Safe Client Gateway 404|For an offchain proposal without Safe API access/i.test(message)) {
    return reply(res, 422, { error: 'We could not retrieve this transaction from the available Safe sources. Check the network, try a Safe URL, or import its transaction JSON.', code: 'TRANSACTION_UNAVAILABLE' });
  }
  const expectedInputError = error instanceof SyntaxError || /^(Invalid |Input |Unrecognized |Enter |Select |The hash or address does not reveal|Execution transaction was not found|An RPC URL is required|Unsupported |Safe URL|No Transaction Service alias)/i.test(message);
  if (expectedInputError) return reply(res, 400, { error: message, code: 'INVALID_OR_UNAVAILABLE_INPUT' });
  const incidentId = recordIncident('inspection_unexpected', 500);
  return reply(res, 500, { error: 'Sorry, something went wrong while inspecting this transaction. We recorded the issue to improve the service. Please try again, or provide a Safe URL or transaction JSON.', code: 'INSPECTION_ERROR', incidentId });
}

function errorPage(incidentId) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page unavailable · Safe Tx Lens</title><link rel="stylesheet" href="/web/style.css"></head><body><header class="masthead"><div class="brand"><span class="mark" aria-hidden="true">◎</span><span>Safe Tx Lens</span></div></header><main class="error-page"><p class="kicker">We are sorry</p><h1>Something went wrong.</h1><p>We could not open this page. We recorded the issue so we can improve the service. Your transaction data was not included in this notice.</p><p class="meta">Reference: <code>${incidentId}</code></p><a href="/">Open the inspector</a></main></body></html>`;
}

export async function serve({ port = 4173, rpcUrl, publicMode = false, communityMode = false, publicOrigin, quotaFile = '/data/public-quota.json', dailyLimit = 5, communityQuotaFile = '/data/community-quota.json', communityDailyUnits = 600, communityMonthlyUnits = 10000, communityClientDailyRequests = 20, credentialReader = localCredentials, inspectionResolver = resolve, incidentReporter = event => console.error(JSON.stringify(event)) } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (publicMode && communityMode) throw new Error('Choose public demo or community mode');
  const publicFacing = publicMode || communityMode;
  const supportConfig = publicSupportConfig();
  let simulationEnabled = false;
  if (publicFacing) {
    let origin;
    try { origin = new URL(publicOrigin); } catch { throw new Error('Public mode needs one HTTPS origin'); }
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('Public mode needs one HTTPS origin');
    if (rpcUrl) throw new Error('Public service cannot use a configured RPC URL');
    const credentials = await credentialReader();
    if (publicMode && Object.entries(credentials).some(([name, value]) => value && (['SAFE_API_KEY', 'ETHERSCAN_API_KEY', 'OKLINK_API_KEY', 'TENDERLY_ACCESS_KEY', 'TENDERLY_MONITOR_ENV_FILE', 'RPC_URL'].includes(name) || name.startsWith('RPC_URL_')))) throw new Error('Public mode refuses owner API credentials');
    if (communityMode && !credentials.SAFE_API_KEY) throw new Error('Community mode requires a dedicated Safe API key');
    if (communityMode && (credentials.TENDERLY_MONITOR_ENV_FILE || credentials.RPC_URL || Object.entries(credentials).some(([name, value]) => name.startsWith('RPC_URL_') && value))) throw new Error('Community mode refuses monitor and private RPC configuration');
    simulationEnabled = Boolean(communityMode && credentials.TENDERLY_ACCESS_KEY && credentials.TENDERLY_ACCOUNT && credentials.TENDERLY_PROJECT);
  }
  const quota = publicMode ? publicQuota({ file: quotaFile, dailyLimit }) : null;
  const community = communityMode ? communityQuota({ file: communityQuotaFile, dailyUnits: communityDailyUnits, monthlyUnits: communityMonthlyUnits, clientDailyRequests: communityClientDailyRequests }) : null;
  const mcp = communityMode ? communityMcpHandler() : null;
  // The report deliberately excludes URL, IP, hash, calldata and credentials.
  // A reference ID lets the operator correlate a user's report with this log.
  const recordIncident = (category, status) => {
    const incidentId = randomUUID();
    const event = { event: 'safe_tx_lens_incident', incidentId, at: new Date().toISOString(), category, status };
    try { incidentReporter(event); }
    catch { console.error(JSON.stringify(event)); }
    return incidentId;
  };
  let html = (await readFile(htmlPath, 'utf8')).replace('<body>', `<body data-public-mode="${publicMode}" data-community-mode="${communityMode}" data-simulation-enabled="${simulationEnabled}">`);
  if (publicFacing) {
    // Remove local-only controls and environment details from the HTML itself.
    // Hiding them after load still exposes them in page source and before JS runs.
    html = html.replace(/<div class="watch-control">[\s\S]*?<\/div>/, '<div class="watch-control" hidden><input id="watch" type="checkbox" disabled></div>');
    html = html.replace(/<p class="local-note">[\s\S]*?<\/p>/, '<p class="local-note">Public read-only service. Requests are limited.</p>');
    if (publicMode) {
      html = html.replace('<option value="auto">Auto-detect across supported networks</option>', '');
      html = html.replace('<option value="both">Both (20 of each)</option>', '');
    }
  }
  const handler = async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/favicon.ico') return reply(res, 204, '');
    if (req.method === 'GET' && req.url === '/api/public-config') return reply(res, 200, supportConfig);
    if (req.method === 'GET' && req.url === '/manifest.webmanifest') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/manifest.webmanifest', import.meta.url)), 'utf8'), 'application/manifest+json');
    if (req.method === 'GET' && req.url === '/sw.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/sw.js', import.meta.url)), 'utf8'), 'text/javascript', { 'Service-Worker-Allowed': '/' });
    if (req.method === 'GET' && req.url === '/web/offline.html') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/offline.html', import.meta.url)), 'utf8'), 'text/html');
    const appIcon = req.method === 'GET' ? /^\/web\/icons\/icon-(192|512)\.png$/.exec(req.url ?? '') : null;
    if (appIcon) return reply(res, 200, await readFile(fileURLToPath(new URL(`../web/icons/icon-${appIcon[1]}.png`, import.meta.url))), 'image/png');
    if (req.method === 'GET' && req.url === '/api/network-coverage') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/network-coverage.json', import.meta.url)), 'utf8'), 'application/json');
    if (req.method === 'GET' && req.url === '/api/network-examples') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/network-examples.json', import.meta.url)), 'utf8'), 'application/json');
    // Query strings identify a UI deep link, not a different route. Keep the
    // root page available for /?hash=... and even an empty trailing ?.
    if (req.method === 'GET' && new URL(req.url ?? '/', 'http://localhost').pathname === '/') return reply(res, 200, html, 'text/html');
    if (req.method === 'GET' && req.url === '/web/app.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8'), 'text/javascript');
    if (req.method === 'GET' && req.url === '/web/vendor/cytoscape.min.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../node_modules/cytoscape/dist/cytoscape.min.js', import.meta.url)), 'utf8'), 'text/javascript');
    if (req.method === 'GET' && req.url === '/web/style.css') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8'), 'text/css');
    const icon = req.method === 'GET' ? /^\/web\/assets\/chains\/([a-z0-9]+)\.png$/.exec(req.url ?? '') : null;
    if (icon && Object.hasOwn(CHAINS, icon[1])) return reply(res, 200, await readFile(fileURLToPath(new URL(`../web/assets/chains/${icon[1]}.png`, import.meta.url))), 'image/png');
    const brandIcon = req.method === 'GET' ? /^\/web\/assets\/chains\/(kat|xlayer)\.svg$/.exec(req.url ?? '') : null;
    if (brandIcon) return reply(res, 200, await readFile(fileURLToPath(new URL(`../web/assets/chains/${brandIcon[1]}.svg`, import.meta.url)), 'utf8'), 'image/svg+xml');
    if (req.method === 'POST' && req.url === '/api/inspect') {
      try {
        const origin = req.headers.origin;
        const localOrigin = `http://127.0.0.1:${server.address().port}`;
        if (origin && origin !== (publicFacing ? publicOrigin : localOrigin)) return reply(res, 403, { error: 'Cross-origin requests are disabled' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Expected application/json' });
        const payload = validateInspectionRequest(JSON.parse(await readBody(req, publicFacing ? 262144 : 5000000)));
        const inputKind = parseInput(payload.input, payload.network ?? 'eth').kind;
        const singleTransaction = inputKind !== 'safe' && !(inputKind === 'json' && isBuilderExport(payload.input));
        if (publicMode && payload.simulate) return reply(res, 403, { error: 'Simulation is unavailable on the public demo; run the tool locally with your own credentials' });
        if (payload.simulate === true && inputKind === 'safe') throw new Error('Select one transaction before running a simulation');
        if (publicMode) {
          if (!origin || origin !== publicOrigin) return reply(res, 403, { error: 'Public requests require the configured origin' });
          if (payload.network === 'auto' && ['safe', 'hash'].includes(inputKind)) return reply(res, 400, { error: 'Select a network on the public demo to limit upstream requests' });
          if (payload.scope === 'both') return reply(res, 400, { error: 'Select pending or history on the public demo' });
          if (payload.verifyTargets === true) return reply(res, 403, { error: 'Bulk target verification is available in the local tool' });
          const ticket = quota.take();
          if (!ticket.allowed) return reply(res, 429, { error: ticket.reason === 'busy' ? 'Public demo is busy; retry shortly' : 'Public demo daily request budget reached; use the CLI locally', code: ticket.reason === 'busy' ? 'SERVICE_BUSY' : 'USAGE_LIMIT' });
          try {
            return reply(res, 200, await inspectionResolver(payload.input, payload.network ?? 'eth', { simulate: false, fetchState: false, verifyTargets: singleTransaction, targetLimit: 4, decodeCandidates: payload.decodeCandidates === true, limit: 5, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash }));
          } finally { quota.release(); }
        }
        if (communityMode) {
          if (!origin || origin !== publicOrigin) return reply(res, 403, { error: 'Browser requests require the configured origin' });
          const clientIp = req.headers['x-client-ip'];
          if (typeof clientIp !== 'string' || !isIP(clientIp)) return reply(res, 403, { error: 'Trusted client identity unavailable' });
          if (payload.simulate && !simulationEnabled) return reply(res, 503, { error: 'Tenderly simulation is not configured for this service' });
          if (inputKind === 'safe' && payload.verifyTargets === true) return reply(res, 400, { error: 'Select one transaction before verifying target code' });
          const verifyTargets = singleTransaction || payload.verifyTargets === true;
          const cost = communityCost(payload.input, payload.network ?? 'auto', payload.scope ?? 'pending', { ...payload, verifyTargets });
          const ticket = community.take(clientIp, cost, { simulation: payload.simulate === true });
          if (!ticket.allowed) return denied(res, ticket);
          try {
            const result = await inspectionResolver(payload.input, payload.network ?? 'auto', { simulate: payload.simulate === true, fetchState: false, verifyTargets, decodeCandidates: payload.decodeCandidates === true, limit: 5, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash });
            return reply(res, 200, redactPrivateSimulationUrl(result));
          } finally { community.release(); }
        }
        // Simulation is an explicit UI action. The ordinary inspection path stays
        // read-only and does not consume simulation quota or share calldata.
        const result = await inspectionResolver(payload.input, payload.network ?? 'eth', { rpcUrl, simulate: payload.simulate === true, verifyTargets: payload.verifyTargets !== false, decodeCandidates: payload.decodeCandidates === true, limit: 20, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash });
        return reply(res, 200, result);
      } catch (error) { return inspectionFailure(res, error, recordIncident); }
    }
    if (communityMode && req.url === '/mcp' && req.method === 'POST') {
      try {
        if (req.headers.origin && req.headers.origin !== publicOrigin) return reply(res, 403, { error: 'Cross-origin requests are disabled' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Expected application/json' });
        const clientIp = req.headers['x-client-ip'];
        if (typeof clientIp !== 'string' || !isIP(clientIp)) return reply(res, 403, { error: 'Trusted client identity unavailable' });
        const body = await readBody(req, 262144);
        const message = JSON.parse(body);
        if (Array.isArray(message) || !message || typeof message !== 'object') return reply(res, 400, { error: 'One MCP message per request' });
        const allowedMethods = ['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call'];
        if (!allowedMethods.includes(message.method)) return reply(res, 405, { error: 'MCP method unavailable' });
        const mcpInput = message.params?.arguments?.input ?? message.params?.arguments?.safe ?? message.params?.arguments?.transaction;
        const mcpNetwork = message.params?.arguments?.network ?? 'auto';
        const deepReview = message.params?.name === 'inspect_json' || (message.params?.name === 'inspect' && parseInput(mcpInput, mcpNetwork).kind !== 'safe');
        const cost = message.method === 'tools/call' ? communityCost(mcpInput, mcpNetwork, message.params?.name === 'list_history' ? 'history' : 'pending', { verifyTargets: deepReview }) : 1;
        const ticket = community.take(clientIp, cost);
        if (!ticket.allowed) return denied(res, ticket);
        try {
          const headers = new Headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' });
          if (req.headers['mcp-protocol-version']) headers.set('mcp-protocol-version', req.headers['mcp-protocol-version']);
          const result = await mcp.fetch(new Request(`${publicOrigin}/mcp`, { method: 'POST', headers, body }));
          const responseBody = await result.text();
          return reply(res, result.status, responseBody, result.headers.get('content-type')?.split(';')[0] ?? 'application/json');
        } finally { community.release(); }
      } catch (error) { return inspectionFailure(res, error, recordIncident); }
    }
    const incidentId = recordIncident('unknown_route', 404);
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) return reply(res, 404, errorPage(incidentId), 'text/html');
    return reply(res, 404, { error: 'Sorry, we could not open that route. We recorded the issue to improve the service.', code: 'ROUTE_UNAVAILABLE', incidentId });
  };
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      const incidentId = recordIncident('request_unexpected', 500);
      if (res.headersSent) return res.destroy();
      return req.method === 'GET' && req.headers.accept?.includes('text/html')
        ? reply(res, 500, errorPage(incidentId), 'text/html')
        : reply(res, 500, { error: 'Sorry, something went wrong. We recorded the issue to improve the service.', code: 'SERVICE_ERROR', incidentId });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const host = publicFacing ? '0.0.0.0' : '127.0.0.1';
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  console.log(`Safe Tx Lens: http://${host}:${server.address().port}`);
  return server;
}
