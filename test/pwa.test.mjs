import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

test('service worker caches only its offline page and never transaction data', async () => {
  const handlers = {};
  const stored = [];
  const deleted = [];
  const offline = { status: 200, body: 'offline' };
  let online = true;
  const worker = {
    location: { origin: 'https://lens.example' },
    clients: { claim: async () => {} },
    skipWaiting() {},
    addEventListener(name, handler) { handlers[name] = handler; },
  };
  const caches = {
    async open(name) { assert.equal(name, 'safe-tx-lens-offline-v1'); return { async add(path) { stored.push(path); } }; },
    async keys() { return ['old-version', 'safe-tx-lens-offline-v1']; },
    async delete(name) { deleted.push(name); },
    async match(path) { assert.equal(path, '/web/offline.html'); return offline; },
  };
  const source = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self: worker, caches, URL, fetch: async () => { if (!online) throw new Error('offline'); return { status: 200, body: 'live' }; } }, { filename: fileURLToPath(new URL('../web/sw.js', import.meta.url)) });
  let work;
  handlers.install({ waitUntil(promise) { work = promise; } });
  await work;
  assert.deepEqual(stored, ['/web/offline.html']);
  handlers.activate({ waitUntil(promise) { work = promise; } });
  await work;
  assert.deepEqual(deleted, ['old-version']);
  const api = { request: { mode: 'cors', url: 'https://lens.example/api/inspect' }, respondWith() { throw new Error('API request intercepted'); } };
  handlers.fetch(api);
  handlers.fetch({ request: { mode: 'navigate', url: 'https://lens.example/api/report' }, respondWith() { throw new Error('API navigation intercepted'); } });
  handlers.fetch({ request: { mode: 'navigate', url: 'https://other.example/' }, respondWith() { throw new Error('Other origin intercepted'); } });
  let response;
  handlers.fetch({ request: { mode: 'navigate', url: 'https://lens.example/' }, respondWith(promise) { response = promise; } });
  assert.equal((await response).body, 'live');
  online = false;
  handlers.fetch({ request: { mode: 'navigate', url: 'https://lens.example/' }, respondWith(promise) { response = promise; } });
  assert.equal(await response, offline);
  assert.deepEqual(stored, ['/web/offline.html']);
});
