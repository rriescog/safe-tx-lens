import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const caddyfile = readFileSync(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
const ranges = line => (caddyfile.split('\n').find(item => item.trim().startsWith(line)) ?? '').trim().split(/\s+/).filter(item => item.includes('/'));

test('Caddy takes the visitor IP only from Cloudflare and rejects direct connections', () => {
  const trusted = ranges('trusted_proxies static');
  const allowed = ranges('@not_cloudflare not remote_ip');
  assert.ok(trusted.length >= 20, 'Cloudflare ranges listed');
  assert.deepEqual(allowed, trusted, 'abort list and trusted proxies must be the same ranges');
  assert.match(caddyfile, /client_ip_headers CF-Connecting-IP/);
  assert.match(caddyfile, /abort @not_cloudflare/);
  assert.match(caddyfile, /header_up X-Client-IP \{client_ip\}/);
  assert.doesNotMatch(caddyfile, /\{remote_host\}/, 'remote_host is the Cloudflare edge, not the visitor');
});

test('host-local sites are imported, never shipped by deployments', () => {
  assert.match(caddyfile, /^import \/etc\/caddy\/sites\/\*\.caddy$/m);
  const compose = readFileSync(new URL('../deploy/compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /- \.\/sites:\/etc\/caddy\/sites:ro/);
});
