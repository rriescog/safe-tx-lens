import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from './resolve.mjs';
import { parseInput } from './inputs.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { publicQuota } from './public-quota.mjs';

const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));

function reply(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

export async function serve({ port = 4173, rpcUrl, publicMode = false, publicOrigin, quotaFile = '/data/public-quota.json', dailyLimit = 5, credentialReader = localCredentials } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  if (publicMode) {
    let origin;
    try { origin = new URL(publicOrigin); } catch { throw new Error('Public mode needs one HTTPS origin'); }
    if (origin.protocol !== 'https:' || origin.origin !== publicOrigin || origin.username || origin.password) throw new Error('Public mode needs one HTTPS origin');
    if (rpcUrl) throw new Error('Public mode cannot use a configured RPC credential');
    const credentials = await credentialReader();
    if (Object.entries(credentials).some(([name, value]) => value && (['SAFE_API_KEY', 'ETHERSCAN_API_KEY', 'TENDERLY_ACCESS_KEY', 'TENDERLY_MONITOR_ENV_FILE', 'RPC_URL'].includes(name) || name.startsWith('RPC_URL_')))) throw new Error('Public mode refuses owner API credentials');
  }
  const quota = publicMode ? publicQuota({ file: quotaFile, dailyLimit }) : null;
  const html = (await readFile(htmlPath, 'utf8')).replace('<body>', `<body data-public-mode="${publicMode}">`);
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') return reply(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/') return reply(res, 200, html, 'text/html');
    if (req.method === 'GET' && req.url === '/web/app.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8'), 'text/javascript');
    if (req.method === 'GET' && req.url === '/web/style.css') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8'), 'text/css');
    if (req.method === 'POST' && req.url === '/api/inspect') {
      try {
        const origin = req.headers.origin;
        const localOrigin = `http://127.0.0.1:${server.address().port}`;
        if (origin && origin !== (publicMode ? publicOrigin : localOrigin)) return reply(res, 403, { error: 'Cross-origin requests are disabled' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Expected application/json' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 5000000) throw new Error('Input too large');
        }
        const payload = JSON.parse(body);
        const inputKind = parseInput(payload.input, payload.network ?? 'eth').kind;
        if (publicMode && payload.simulate) return reply(res, 403, { error: 'Simulation is unavailable on the public demo; run the tool locally with your own credentials' });
        if (payload.simulate === true && inputKind === 'safe') throw new Error('Select one transaction before running a simulation');
        if (publicMode) {
          if (!origin || origin !== publicOrigin) return reply(res, 403, { error: 'Public requests require the configured origin' });
          if (payload.network === 'auto' && ['safe', 'hash'].includes(inputKind)) return reply(res, 400, { error: 'Select a network on the public demo to limit upstream requests' });
          const ticket = quota.take();
          if (!ticket.allowed) return reply(res, 429, { error: ticket.reason === 'busy' ? 'Public demo is busy; retry shortly' : 'Public demo daily request budget reached; use the CLI locally' });
          try {
            return reply(res, 200, await resolve(payload.input, payload.network ?? 'eth', { simulate: false, fetchState: false, verifyTargets: payload.verifyTargets === true, limit: 20, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash }));
          } finally { quota.release(); }
        }
        // Simulation is an explicit UI action. The ordinary inspection path stays
        // read-only and does not consume simulation quota or share calldata.
        const result = await resolve(payload.input, payload.network ?? 'eth', { rpcUrl, simulate: payload.simulate === true, verifyTargets: payload.verifyTargets !== false, limit: 20, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash });
        return reply(res, 200, result);
      } catch (error) { return reply(res, 400, { error: error.message }); }
    }
    reply(res, 404, { error: 'Not found' });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const host = publicMode ? '0.0.0.0' : '127.0.0.1';
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, host, accept); });
  console.log(`Safe Tx Lens: http://${host}:${server.address().port}`);
  return server;
}
