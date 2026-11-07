import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from './resolve.mjs';
import { parseInput } from './inputs.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { publicQuota } from './public-quota.mjs';
import { communityQuota } from './community-quota.mjs';
import { communityMcpHandler } from './community-mcp.mjs';
import { isIP } from 'node:net';
import { validateInspectionRequest } from './input-boundary.mjs';
import { CHAINS } from './chains.mjs';
import { publicSupportConfig } from './support.mjs';

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
  return reply(res, 429, { error, retryAfterSeconds: seconds }, 'application/json', { 'Retry-After': String(seconds) });
}

export async function serve({ port = 4173, rpcUrl, publicMode = false, communityMode = false, publicOrigin, quotaFile = '/data/public-quota.json', dailyLimit = 5, communityQuotaFile = '/data/community-quota.json', communityDailyUnits = 600, communityMonthlyUnits = 10000, communityClientDailyRequests = 20, credentialReader = localCredentials } = {}) {
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
    if (publicMode && Object.entries(credentials).some(([name, value]) => value && (['SAFE_API_KEY', 'ETHERSCAN_API_KEY', 'TENDERLY_ACCESS_KEY', 'TENDERLY_MONITOR_ENV_FILE', 'RPC_URL'].includes(name) || name.startsWith('RPC_URL_')))) throw new Error('Public mode refuses owner API credentials');
    if (communityMode && !credentials.SAFE_API_KEY) throw new Error('Community mode requires a dedicated Safe API key');
    if (communityMode && (credentials.TENDERLY_MONITOR_ENV_FILE || credentials.RPC_URL || Object.entries(credentials).some(([name, value]) => name.startsWith('RPC_URL_') && value))) throw new Error('Community mode refuses monitor and private RPC configuration');
    simulationEnabled = Boolean(communityMode && credentials.TENDERLY_ACCESS_KEY && credentials.TENDERLY_ACCOUNT && credentials.TENDERLY_PROJECT);
  }
  const quota = publicMode ? publicQuota({ file: quotaFile, dailyLimit }) : null;
  const community = communityMode ? communityQuota({ file: communityQuotaFile, dailyUnits: communityDailyUnits, monthlyUnits: communityMonthlyUnits, clientDailyRequests: communityClientDailyRequests }) : null;
  const mcp = communityMode ? communityMcpHandler() : null;
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
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/api/public-config') return reply(res, 200, supportConfig);
    if (req.method === 'GET' && req.url === '/') return reply(res, 200, html, 'text/html');
    if (req.method === 'GET' && req.url === '/web/app.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8'), 'text/javascript');
    if (req.method === 'GET' && req.url === '/web/style.css') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8'), 'text/css');
    const icon = req.method === 'GET' ? /^\/web\/assets\/chains\/([a-z0-9]+)\.png$/.exec(req.url ?? '') : null;
    if (icon && Object.hasOwn(CHAINS, icon[1])) return reply(res, 200, await readFile(fileURLToPath(new URL(`../web/assets/chains/${icon[1]}.png`, import.meta.url))), 'image/png');
    if (req.method === 'POST' && req.url === '/api/inspect') {
      try {
        const origin = req.headers.origin;
        const localOrigin = `http://127.0.0.1:${server.address().port}`;
        if (origin && origin !== (publicFacing ? publicOrigin : localOrigin)) return reply(res, 403, { error: 'Cross-origin requests are disabled' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Expected application/json' });
        const payload = validateInspectionRequest(JSON.parse(await readBody(req, publicFacing ? 262144 : 5000000)));
        const inputKind = parseInput(payload.input, payload.network ?? 'eth').kind;
        if (publicMode && payload.simulate) return reply(res, 403, { error: 'Simulation is unavailable on the public demo; run the tool locally with your own credentials' });
        if (payload.simulate === true && inputKind === 'safe') throw new Error('Select one transaction before running a simulation');
        if (publicMode) {
          if (!origin || origin !== publicOrigin) return reply(res, 403, { error: 'Public requests require the configured origin' });
          if (payload.network === 'auto' && ['safe', 'hash'].includes(inputKind)) return reply(res, 400, { error: 'Select a network on the public demo to limit upstream requests' });
          if (payload.scope === 'both') return reply(res, 400, { error: 'Select pending or history on the public demo' });
          if (payload.verifyTargets === true) return reply(res, 403, { error: 'Bulk target verification is available in the local tool' });
          const ticket = quota.take();
          if (!ticket.allowed) return reply(res, 429, { error: ticket.reason === 'busy' ? 'Public demo is busy; retry shortly' : 'Public demo daily request budget reached; use the CLI locally' });
          try {
            return reply(res, 200, await resolve(payload.input, payload.network ?? 'eth', { simulate: false, fetchState: false, verifyTargets: false, limit: 5, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash }));
          } finally { quota.release(); }
        }
        if (communityMode) {
          if (!origin || origin !== publicOrigin) return reply(res, 403, { error: 'Browser requests require the configured origin' });
          const clientIp = req.headers['x-client-ip'];
          if (typeof clientIp !== 'string' || !isIP(clientIp)) return reply(res, 403, { error: 'Trusted client identity unavailable' });
          if (payload.simulate && !simulationEnabled) return reply(res, 503, { error: 'Tenderly simulation is not configured for this service' });
          if (inputKind === 'safe' && payload.verifyTargets === true) return reply(res, 400, { error: 'Select one transaction before verifying target code' });
          const cost = communityCost(payload.input, payload.network ?? 'auto', payload.scope ?? 'pending', payload);
          const ticket = community.take(clientIp, cost, { simulation: payload.simulate === true });
          if (!ticket.allowed) return denied(res, ticket);
          try {
            return reply(res, 200, await resolve(payload.input, payload.network ?? 'auto', { simulate: payload.simulate === true, fetchState: false, verifyTargets: payload.verifyTargets === true, limit: 5, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash }));
          } finally { community.release(); }
        }
        // Simulation is an explicit UI action. The ordinary inspection path stays
        // read-only and does not consume simulation quota or share calldata.
        const result = await resolve(payload.input, payload.network ?? 'eth', { rpcUrl, simulate: payload.simulate === true, verifyTargets: payload.verifyTargets !== false, limit: 20, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash });
        return reply(res, 200, result);
      } catch (error) { return reply(res, 400, { error: error.message }); }
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
      } catch (error) { return reply(res, 400, { error: error.message }); }
    }
    reply(res, 404, { error: 'Not found' });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const host = publicFacing ? '0.0.0.0' : '127.0.0.1';
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  console.log(`Safe Tx Lens: http://${host}:${server.address().port}`);
  return server;
}
