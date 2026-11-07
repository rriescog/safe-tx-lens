#!/usr/bin/env node
import { CHAINS } from '../src/chains.mjs';
import { PUBLIC_RPC } from '../src/onchain.mjs';
import { localCredentials } from '../src/tenderly-storage.mjs';
import { writeFile } from 'node:fs/promises';

const EMPTY_SAFE = '0x0000000000000000000000000000000000000000';
const MIN_REMAINING = 100;
const MAX_SAFE_REQUESTS = Object.keys(CHAINS).length * 3;
const PAUSE_MS = 600;
const wait = ms => new Promise(done => setTimeout(done, ms));

function classify(response, body, endpoint) {
  if (response.status === 429) return { status: 'quota_limited', httpStatus: 429 };
  if (response.status === 401 || response.status === 403) return { status: 'auth_or_access_denied', httpStatus: response.status };
  if (response.status === 404) return { status: 'not_available', httpStatus: 404 };
  if (!response.ok) return { status: 'upstream_error', httpStatus: response.status };
  let parsed;
  try { parsed = JSON.parse(body); } catch { return { status: 'invalid_response', httpStatus: response.status }; }
  if (endpoint === 'indexing') {
    if (typeof parsed.synced !== 'boolean' || !Number.isInteger(parsed.currentBlockNumber)) return { status: 'invalid_response', httpStatus: response.status };
    return { status: parsed.synced ? 'available' : 'indexer_lagging', httpStatus: response.status, synced: parsed.synced };
  }
  if (!Array.isArray(parsed.results) || !Number.isInteger(parsed.count)) return { status: 'invalid_response', httpStatus: response.status };
  return { status: 'available', httpStatus: response.status, emptyProbeResults: parsed.results.length === 0 };
}

// Each Safe endpoint costs one API unit. The probe never retries, tests at most
// three endpoints per named chain, spaces requests, and stops on quota signals.
export async function probeNetworks({ request = fetch, credentials = localCredentials, pause = wait, includeRpc = true } = {}) {
  const configuration = await credentials();
  const apiKey = configuration.SAFE_API_KEY;
  if (!apiKey) throw new Error('SAFE_API_KEY is required for the bounded live network probe');
  const output = { checkedAt: new Date().toISOString(), maxSafeRequests: MAX_SAFE_REQUESTS, safeRequests: 0, stopped: null, networks: [] };
  let remaining = null;
  const paths = {
    indexing: '/about/indexing/',
    pending: `/safes/${EMPTY_SAFE}/multisig-transactions/?executed=false&limit=1`,
    history: `/safes/${EMPTY_SAFE}/multisig-transactions/?executed=true&limit=1`,
  };
  for (const [network, id] of Object.entries(CHAINS)) {
    const row = { network, chainId: id, safe: {} };
    output.networks.push(row);
    for (const [endpoint, path] of Object.entries(paths)) {
      if (output.stopped) { row.safe[endpoint] = { status: 'not_tested' }; continue; }
      if (output.safeRequests >= MAX_SAFE_REQUESTS || (remaining !== null && remaining < MIN_REMAINING)) {
        output.stopped = 'request_budget_or_quota_floor'; row.safe[endpoint] = { status: 'not_tested' }; continue;
      }
      if (output.safeRequests) await pause(PAUSE_MS);
      output.safeRequests++;
      try {
        const response = await request(`https://api.safe.global/tx-service/${network}/api/v1${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        const header = response.headers.get('x-ratelimit-remaining');
        if (header !== null && /^\d+$/.test(header)) remaining = Number(header);
        const body = await response.text();
        row.safe[endpoint] = classify(response, body, endpoint);
        if (response.status === 429) output.stopped = 'safe_rate_limited';
      } catch (error) { row.safe[endpoint] = { status: error.name === 'TimeoutError' ? 'timeout' : 'network_error' }; }
    }
    if (!includeRpc) continue;
    const rpcUrl = configuration[`RPC_URL_${network.toUpperCase()}`] ?? PUBLIC_RPC[network];
    if (!rpcUrl) { row.rpc = { status: 'not_configured' }; continue; }
    try {
      const response = await request(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(8000) });
      const body = await response.json();
      const observed = /^0x[0-9a-fA-F]+$/.test(body.result ?? '') ? Number.parseInt(body.result, 16) : null;
      row.rpc = { status: response.ok && observed === id ? 'available' : observed !== null ? 'wrong_chain' : 'invalid_response', ...(observed !== null ? { observedChainId: observed } : {}) };
    } catch (error) { row.rpc = { status: error.name === 'TimeoutError' ? 'timeout' : 'network_error' }; }
  }
  output.safeQuotaRemaining = remaining;
  return output;
}

export function publicSnapshot(report) {
  return {
    checkedAt: report.checkedAt,
    method: 'Authenticated Safe Transaction Service indexing, pending and history endpoints with an empty test address; RPC eth_chainId',
    networks: report.networks.map(({ network, chainId, safe, rpc }) => ({ network, chainId, indexing: safe.indexing.status, pending: safe.pending.status, history: safe.history.status, rpc: rpc?.status ?? 'not_tested' })),
  };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  if (!process.argv.includes('--live')) {
    console.error(`Dry run: ${Object.keys(CHAINS).length} networks, at most ${MAX_SAFE_REQUESTS} Safe API requests, ${PAUSE_MS} ms between requests. Pass --live to probe.`);
  } else {
    try {
      const report = await probeNetworks();
      const snapshotIndex = process.argv.indexOf('--snapshot');
      if (snapshotIndex !== -1) {
        const path = process.argv[snapshotIndex + 1];
        if (!path) throw new Error('--snapshot requires an output path');
        await writeFile(path, `${JSON.stringify(publicSnapshot(report), null, 2)}\n`);
      }
      console.log(JSON.stringify(report, null, 2));
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
