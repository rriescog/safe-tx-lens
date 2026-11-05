import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from './resolve.mjs';
import { parseInput } from './inputs.mjs';

const htmlPath = fileURLToPath(new URL('../web/index.html', import.meta.url));

function reply(res, status, data, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(typeof data === 'string' ? data : JSON.stringify(data));
}

export async function serve({ port = 4173, rpcUrl } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port');
  const html = await readFile(htmlPath, 'utf8');
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/') return reply(res, 200, html, 'text/html');
    if (req.method === 'GET' && req.url === '/web/app.js') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8'), 'text/javascript');
    if (req.method === 'GET' && req.url === '/web/style.css') return reply(res, 200, await readFile(fileURLToPath(new URL('../web/style.css', import.meta.url)), 'utf8'), 'text/css');
    if (req.method === 'POST' && req.url === '/api/inspect') {
      try {
        const origin = req.headers.origin;
        const localOrigin = `http://127.0.0.1:${server.address().port}`;
        if (origin && origin !== localOrigin) return reply(res, 403, { error: 'Cross-origin requests are disabled' });
        if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'Expected application/json' });
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (body.length > 5000000) throw new Error('Input too large');
        }
        const payload = JSON.parse(body);
        const inputKind = parseInput(payload.input, payload.network ?? 'eth').kind;
        if (payload.simulate === true && inputKind === 'safe') throw new Error('Select one transaction before running a simulation');
        // Simulation is an explicit UI action. The ordinary inspection path stays
        // read-only and does not consume simulation quota or share calldata.
        const result = await resolve(payload.input, payload.network ?? 'eth', { rpcUrl, simulate: payload.simulate === true, limit: 20, scope: payload.scope ?? 'pending', safeAddress: payload.safeAddress, safeHash: payload.safeHash });
        return reply(res, 200, result);
      } catch (error) { return reply(res, 400, { error: error.message }); }
    }
    reply(res, 404, { error: 'Not found' });
  });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  console.log(`Safe Tx Lens: http://127.0.0.1:${server.address().port}`);
  return server;
}
