import { readFileSync } from 'node:fs';

const tx = JSON.parse(readFileSync(new URL('../../examples/safe-pending.json', import.meta.url), 'utf8'));
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(callback, delay >= 15000 ? 1 : delay, ...args);
let queueCalls = 0;
globalThis.fetch = async url => {
  const path = String(url);
  if (path.includes('api.tenderly.co') && path.endsWith('/storage/all')) return new Response(JSON.stringify([{ key: 'PENDING_TXN_DATA', value: '{}' }]), { status: 200 });
  if (path.endsWith(`/safes/${tx.safe}/`)) return new Response(JSON.stringify({ address: tx.safe, nonce: 244, threshold: 1, owners: [tx.safe] }), { status: 200 });
  if (path.includes('trusted=false')) return new Response(JSON.stringify({ count: 0, results: [], next: null }), { status: 200 });
  if (path.includes(`/safes/${tx.safe}/multisig-transactions/`)) {
    queueCalls++;
    if (queueCalls >= 3) process.exit(0);
    return new Response(JSON.stringify({ count: queueCalls === 1 ? 1 : 0, results: queueCalls === 1 ? [tx] : [], next: null }), { status: 200 });
  }
  if (path.endsWith(`/multisig-transactions/${tx.safeTxHash}/`)) return new Response(JSON.stringify(process.env.TEST_WATCH_OUTCOME === 'executed'
    ? { ...tx, isExecuted: true, isSuccessful: true }
    : { ...tx, isExecuted: false }), { status: 200 });
  throw new Error(`Unexpected network request: ${path}`);
};
