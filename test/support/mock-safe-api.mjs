import { readFileSync } from 'node:fs';

const tx = JSON.parse(readFileSync(new URL('../../examples/2026-11-05-pos-council-nonce-243-rejection.json', import.meta.url), 'utf8'));
globalThis.fetch = async url => {
  const path = String(url);
  if (path.endsWith(`/safes/${tx.safe}/`)) return new Response(JSON.stringify({ address: tx.safe, nonce: 244, threshold: 1, owners: [tx.safe] }), { status: 200 });
  if (process.env.TEST_FAIL_PENDING === '1' && path.includes('executed=false')) return new Response('outage', { status: 503 });
  if (path.includes(`/safes/${tx.safe}/multisig-transactions/`)) return new Response(JSON.stringify({ count: 1, results: [tx], next: null }), { status: 200 });
  throw new Error(`Unexpected network request: ${path}`);
};
