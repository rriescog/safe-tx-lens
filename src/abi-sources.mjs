import { getAddress, isAddress, keccak256 } from 'ethers';
import { CHAINS, chainId } from './chains.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { readJsonResponse } from './response-boundary.mjs';

// The Etherscan V2 chain list was checked on 2026-11-08. Other named chains
// have their own explorer API. Sourcify is attempted for every named chain.
export const ETHERSCAN_CHAINS = Object.freeze(['eth', 'gno', 'pol', 'arb1', 'oeth', 'base', 'sep', 'amoy', 'bnb', 'avax', 'kat']);
export const BLOCKSCOUT_EXPLORERS = Object.freeze({ kat: 'https://explorer.katanarpc.com', imx: 'https://explorer.immutable.com' });
export const ABI_SOURCES = Object.freeze(Object.fromEntries(Object.keys(CHAINS).map(network => [network, Object.freeze([
  'sourcify',
  ...(BLOCKSCOUT_EXPLORERS[network] ? ['blockscout'] : []),
  ...(ETHERSCAN_CHAINS.includes(network) ? ['etherscan'] : []),
  ...(network === 'xlayer' ? ['oklink'] : []),
])] )));

const EXPLORER_LINKS = Object.freeze({
  eth: 'https://etherscan.io', gno: 'https://gnosisscan.io', pol: 'https://polygonscan.com',
  arb1: 'https://arbiscan.io', oeth: 'https://optimistic.etherscan.io', base: 'https://basescan.org',
  sep: 'https://sepolia.etherscan.io', amoy: 'https://amoy.polygonscan.com',
  bnb: 'https://bscscan.com', avax: 'https://snowtrace.io', kat: 'https://katanascan.com',
});
const EXPLORER_NAMES = Object.freeze({
  eth: 'Etherscan', gno: 'GnosisScan', pol: 'PolygonScan', arb1: 'Arbiscan', oeth: 'Optimistic Etherscan', base: 'BaseScan',
  sep: 'Sepolia Etherscan', amoy: 'Amoy PolygonScan', bnb: 'BscScan', avax: 'SnowTrace', kat: 'KatanaScan',
});
const SOURCIFY = 'https://sourcify.dev/server';
const CACHE_LIMIT = 512;
const cache = new Map();
let etherscanQueue = Promise.resolve();
let nextEtherscanAt = 0;

function paceEtherscan(task) {
  const current = etherscanQueue.then(async () => {
    const delay = Math.max(0, nextEtherscanAt - Date.now());
    if (delay) await new Promise(done => setTimeout(done, delay));
    nextEtherscanAt = Date.now() + 400;
    return task();
  });
  etherscanQueue = current.catch(() => {});
  return current;
}

function abiArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.length <= 512 ? parsed : null;
  } catch { return null; }
}

const USER_AGENT = 'safe-tx-lens/0.2 (+https://github.com/rriescog/safe-tx-lens)';
const MAX_RETRY_WAIT_MS = 5000;

// A transient upstream failure (rate limit, 5xx, timeout) is reported as such
// and never cached as "not verified". One retry honours a short Retry-After.
export class SourceApiError extends Error {
  constructor(message, { status = null, transient = false, rateLimited = false } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
    this.rateLimited = rateLimited;
  }
}

async function sendJson(url, { request, method = 'GET', headers = {}, body } = {}) {
  const host = new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let response;
    try {
      response = await request(url, { method, headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
    } catch (error) {
      throw new SourceApiError(`${host} did not respond (${error.name === 'TimeoutError' ? 'timeout after 8 s' : error.message})`, { transient: true });
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt === 0) {
      const after = Number(response.headers?.get?.('retry-after'));
      const wait = Number.isFinite(after) && after >= 0 ? after * 1000 : 1000;
      if (wait <= MAX_RETRY_WAIT_MS) { await new Promise(done => setTimeout(done, wait)); continue; }
    }
    return response;
  }
}

async function jsonGet(url, { request, headers = {} } = {}) {
  const response = await sendJson(url, { request, headers });
  if (response.status === 404) return null;
  if (!response.ok) {
    const host = new URL(url).host;
    throw new SourceApiError(response.status === 429 ? `${host} rate limited this request (HTTP 429)` : `${host} returned HTTP ${response.status}`, { status: response.status, transient: response.status === 429 || response.status >= 500, rateLimited: response.status === 429 });
  }
  return readJsonResponse(response, 4_000_000);
}

export async function sourcifyLookup(network, address, { request = fetch } = {}) {
  const id = chainId(network);
  return jsonGet(`${SOURCIFY}/v2/contract/${id}/${address}?fields=abi,runtimeBytecode.onchainBytecode,compilation.name,compilation.compilerVersion`, { request });
}

export async function blockscoutLookup(network, address, { request = fetch } = {}) {
  const base = BLOCKSCOUT_EXPLORERS[network];
  if (!base) return null;
  const raw = await jsonGet(`${base}/api/v2/smart-contracts/${address}`, { request });
  if (!raw) return null;
  const abi = abiArray(raw.abi);
  if (!abi) return null;
  return { abi, sourceProvider: 'blockscout', sourceUrl: `${base}/address/${address}?tab=contract`,
    ...(raw.is_verified === true && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw.deployed_bytecode ?? '')
      ? { runtimeBytecode: { onchainBytecode: raw.deployed_bytecode }, runtimeMatch: 'match' }
      : { explorerAbi: true }) };
}

export async function etherscanLookup(network, address, { request = fetch, apiKey } = {}) {
  if (!ETHERSCAN_CHAINS.includes(network) || !apiKey) return null;
  const params = new URLSearchParams({ chainid: String(chainId(network)), module: 'contract', action: 'getsourcecode', address, apikey: apiKey });
  const raw = await paceEtherscan(() => jsonGet(`https://api.etherscan.io/v2/api?${params}`, { request }));
  if (raw?.status === '0' && /rate limit|quota|free api access|max calls/i.test(String(raw.result ?? raw.message ?? ''))) throw new SourceApiError(`Etherscan API rate limited this request: ${String(raw.result ?? raw.message).slice(0, 160)}`, { transient: true, rateLimited: true });
  if (raw?.status === '0' && raw.message === 'NOTOK') throw new SourceApiError(`Etherscan API error: ${String(raw.result ?? '').slice(0, 160)}`);
  const row = raw?.status === '1' && Array.isArray(raw.result) ? raw.result[0] : null;
  const abi = abiArray(row?.ABI);
  if (!abi || !row?.SourceCode) return null;
  return { abi, explorerAbi: true, sourceProvider: 'etherscan', sourceUrl: `${EXPLORER_LINKS[network]}/address/${address}#code`,
    contractName: row.ContractName || null, compilerVersion: row.CompilerVersion || null,
    // The explorer's current implementation is a discovery hint only. The
    // historical implementation must come from RPC storage at the block.
    explorerImplementation: isAddress(row.Implementation) ? getAddress(row.Implementation) : null };
}

export async function oklinkLookup(network, address, { request = fetch, apiKey } = {}) {
  if (network !== 'xlayer') return null;
  const params = new URLSearchParams({ chainShortName: 'XLAYER', contractAddress: address });
  const raw = await jsonGet(`https://www.oklink.com/api/v5/explorer/contract/verify-contract-info?${params}`, { request, headers: apiKey ? { 'OK-ACCESS-KEY': apiKey } : {} });
  const row = raw?.code === '0' && Array.isArray(raw.data) ? raw.data[0] : null;
  const abi = abiArray(row?.contractAbi);
  if (!abi || !row?.sourceCode) return null;
  return { abi, explorerAbi: true, sourceProvider: 'oklink', sourceUrl: `https://www.oklink.com/xlayer/address/${address}#code` };
}

function byteCount(hex) { return (hex.length - 2) / 2; }
function validCode(hex) { return typeof hex === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(hex); }
function providerLabel(provider, network) {
  if (provider === 'sourcify') return 'Sourcify';
  if (provider === 'etherscan') return `${EXPLORER_NAMES[network] ?? 'Etherscan'} (Etherscan API)`;
  if (provider === 'blockscout') return 'Blockscout';
  if (provider === 'oklink') return 'OKLink';
  if (provider === 'sourcify_import') return `Sourcify import of the ${EXPLORER_NAMES[network] ?? 'explorer'} source`;
  return provider;
}

const importJobs = new Map();
const IMPORT_FINAL_TTL_MS = 6 * 60 * 60_000;

// Ask Sourcify to fetch the explorer's verified source, compile it on its own
// infrastructure and compare it with the current chain code. This publishes a
// public Sourcify verification. Our Etherscan key is never sent.
export async function importToSourcify(network, address, { request = fetch, waitMs = 20_000, pollMs = 2000 } = {}) {
  const key = `${network}:${address.toLowerCase()}`;
  const known = importJobs.get(key);
  if (known?.final && Date.now() - known.at < IMPORT_FINAL_TTL_MS) return known.result;
  let verificationId = known?.verificationId;
  if (!verificationId) {
    const response = await sendJson(`${SOURCIFY}/v2/verify/etherscan/${chainId(network)}/${address}`, { request, method: 'POST', body: {} });
    const raw = await readJsonResponse(response, 100_000).catch(() => null);
    if (response.status === 429) return { outcome: 'rate_limited', detail: 'Sourcify could not import from the explorer now: its explorer API allowance is exhausted (HTTP 429). Retry later.' };
    if (response.status !== 202 || !raw?.verificationId) return { outcome: 'error', detail: `Sourcify refused the import request (HTTP ${response.status}${raw?.message ? `: ${String(raw.message).slice(0, 200)}` : ''})` };
    verificationId = raw.verificationId;
    importJobs.set(key, { verificationId, at: Date.now(), final: false });
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const job = await jsonGet(`${SOURCIFY}/v2/verify/${verificationId}`, { request });
    if (job?.isJobCompleted) {
      const match = job.contract?.runtimeMatch ?? job.contract?.match;
      const result = match
        ? { outcome: 'matched', detail: `Sourcify compiled the explorer source and its runtime bytecode matched the chain (${match}).`, verificationId }
        : job.error?.customCode === 'already_verified'
          ? { outcome: 'rejected', detail: 'Sourcify already holds a verified version of this address and did not accept the explorer source as a better match, so it keeps serving the earlier version.', verificationId }
          : { outcome: 'failed', detail: `Sourcify could not verify the explorer source${job.error?.message ? `: ${String(job.error.message).slice(0, 240)}` : ''}${job.error?.customCode ? ` (${job.error.customCode})` : ''}.`, verificationId };
      importJobs.set(key, { verificationId, at: Date.now(), final: true, result });
      return result;
    }
    if (Date.now() + pollMs > deadline) return { outcome: 'pending', detail: `Sourcify is still compiling the explorer source (job ${verificationId}). Inspect again in a minute.`, verificationId };
    await new Promise(done => setTimeout(done, pollMs));
  }
}

// Every provider's answer is kept as evidence so the report can say exactly
// what each source returned. Matching bytecode wins; an explorer-only ABI can
// still decode arguments but is never promoted to matched code.
export async function lookupContractSource(network, address, { runtimeCode, request = fetch, credentialsReader = localCredentials, useCache = true, sourcifyImport = process.env.SOURCIFY_IMPORT !== 'off', importWaitMs = 20_000 } = {}) {
  if (!Object.hasOwn(ABI_SOURCES, network) || !isAddress(address)) return null;
  const credentials = await credentialsReader();
  const rpcHash = validCode(runtimeCode) ? keccak256(runtimeCode) : null;
  const key = `${network}:${address.toLowerCase()}:${rpcHash ?? 'unknown'}:${Boolean(credentials.ETHERSCAN_API_KEY)}:${Boolean(credentials.OKLINK_API_KEY)}`;
  const cached = useCache ? cache.get(key) : null;
  if (cached && cached.expires > Date.now()) return cached.source;
  const providers = [
    ['sourcify', () => sourcifyLookup(network, address, { request })],
    ...(BLOCKSCOUT_EXPLORERS[network] ? [['blockscout', () => blockscoutLookup(network, address, { request })]] : []),
    ...(ETHERSCAN_CHAINS.includes(network) ? [['etherscan', () => etherscanLookup(network, address, { request, apiKey: credentials.ETHERSCAN_API_KEY })]] : []),
    ...(network === 'xlayer' ? [['oklink', () => oklinkLookup(network, address, { request, apiKey: credentials.OKLINK_API_KEY })]] : []),
  ];
  const evidence = [];
  const add = (provider, outcome, detail, url = null) => evidence.push({ provider, label: providerLabel(provider, network), outcome, detail, ...(url ? { url } : {}) });
  const rpcBytes = rpcHash ? byteCount(runtimeCode) : null;
  let matched = null;
  let fallback = null;
  let sourcifyCandidate = null;
  let transient = false;
  for (const [name, provider] of providers) {
    if (name === 'etherscan' && !credentials.ETHERSCAN_API_KEY) { add(name, 'not_configured', 'Not queried: no Etherscan API key is configured on this service.'); continue; }
    let source;
    try { source = await provider(); }
    catch (error) {
      transient ||= error.transient !== false;
      add(name, error.rateLimited ? 'rate_limited' : 'error', error.message);
      continue;
    }
    if (!source) { add(name, 'not_verified', name === 'sourcify' ? 'No verified source for this address.' : 'The explorer reports no verified source for this address.'); continue; }
    if (name === 'sourcify') sourcifyCandidate = source;
    const claimed = source.runtimeBytecode?.onchainBytecode;
    const what = [source.compilation?.name ?? source.contractName, source.compilation?.compilerVersion ?? source.compilerVersion].filter(Boolean).join(', ');
    const url = source.sourceUrl ?? (name === 'sourcify' ? `https://repo.sourcify.dev/${chainId(network)}/${address}` : null);
    if (validCode(claimed) && rpcHash) {
      if (keccak256(claimed) === rpcHash) {
        add(name, 'match', `Verified source${what ? ` (${what})` : ''}; its runtime bytecode is identical to the RPC bytecode (${rpcBytes} bytes, ${source.runtimeMatch ?? source.match ?? 'match'}).`, url);
        matched = source;
        break;
      }
      add(name, 'different_bytecode', `Has a verified source${what ? ` (${what})` : ''}${source.verifiedAt ? ` verified ${String(source.verifiedAt).slice(0, 10)}` : ''}, but for different runtime bytecode: ${byteCount(claimed)} bytes (hash ${keccak256(claimed).slice(0, 10)}…) versus ${rpcBytes} bytes (hash ${rpcHash.slice(0, 10)}…) returned by the RPC. The code at this address is not the code that source describes.`, url);
    } else if (Array.isArray(source.abi)) {
      add(name, 'abi_only', `Verified source and ABI available${what ? ` (${what})` : ''}, but this API does not return compiled bytecode, so the source cannot be compared with the RPC bytecode here.`, url);
    }
    if (!fallback || (source.explorerAbi && !fallback.explorerAbi)) fallback = source;
  }
  // Only an explorer holds a source that could describe this code: let
  // Sourcify compile it independently and compare with the chain.
  let importPending = false;
  if (!matched && rpcHash && sourcifyImport && fallback?.sourceProvider === 'etherscan') {
    try {
      const result = await importToSourcify(network, address, { request, waitMs: importWaitMs });
      importPending = result.outcome === 'pending' || result.outcome === 'rate_limited';
      if (result.outcome === 'matched') {
        const refreshed = await sourcifyLookup(network, address, { request });
        if (validCode(refreshed?.runtimeBytecode?.onchainBytecode) && keccak256(refreshed.runtimeBytecode.onchainBytecode) === rpcHash) {
          matched = { ...refreshed, importedFrom: providerLabel('etherscan', network) };
          sourcifyCandidate = refreshed;
          add('sourcify_import', 'match', `${result.detail} Source imported from ${providerLabel('etherscan', network)}.`, `https://repo.sourcify.dev/${chainId(network)}/${address}`);
        } else add('sourcify_import', 'failed', 'Sourcify reported a match, but its stored bytecode still differs from the RPC bytecode.');
      } else add('sourcify_import', result.outcome, result.detail);
    } catch (error) {
      importPending = true;
      add('sourcify_import', error.rateLimited ? 'rate_limited' : 'error', `Sourcify import unavailable: ${error.message}`);
    }
  }
  const chosen = matched ?? fallback;
  const value = chosen ? { ...chosen, evidence, sourcifyCandidate } : evidence.length ? { noSource: true, evidence } : null;
  if (useCache) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    const ttl = transient || importPending ? 60_000 : chosen ? 60 * 60_000 : 5 * 60_000;
    cache.set(key, { source: value, expires: Date.now() + ttl });
  }
  return value;
}
