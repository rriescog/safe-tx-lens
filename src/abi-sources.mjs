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

async function jsonGet(url, { request, headers = {} } = {}) {
  const response = await request(url, { headers: { Accept: 'application/json', 'User-Agent': 'safe-tx-lens/0.2 (+https://github.com/rriescog/safe-tx-lens)', ...headers }, signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Source API ${new URL(url).host} ${response.status}`);
  return readJsonResponse(response, 4_000_000);
}

export async function sourcifyLookup(network, address, { request = fetch } = {}) {
  const id = chainId(network);
  return jsonGet(`https://sourcify.dev/server/v2/contract/${id}/${address}?fields=abi,runtimeBytecode.onchainBytecode`, { request });
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
  if (raw?.status === '0' && /rate limit|quota|free api access/i.test(String(raw.result ?? raw.message ?? ''))) throw new Error('Etherscan ABI lookup rate limited');
  const row = raw?.status === '1' && Array.isArray(raw.result) ? raw.result[0] : null;
  const abi = abiArray(row?.ABI);
  if (!abi || !row?.SourceCode) return null;
  return { abi, explorerAbi: true, sourceProvider: 'etherscan', sourceUrl: `${EXPLORER_LINKS[network]}/address/${address}#code`,
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

// Prefer bytecode that actually matches the inspected block. Explorer-only
// ABIs can still decode arguments, but are never promoted to matched code.
export async function lookupContractSource(network, address, { runtimeCode, request = fetch, credentialsReader = localCredentials, useCache = true } = {}) {
  if (!Object.hasOwn(ABI_SOURCES, network) || !isAddress(address)) return null;
  const credentials = await credentialsReader();
  const key = `${network}:${address.toLowerCase()}:${runtimeCode && /^0x(?:[0-9a-fA-F]{2})+$/.test(runtimeCode) ? keccak256(runtimeCode) : 'unknown'}:${Boolean(credentials.ETHERSCAN_API_KEY)}:${Boolean(credentials.OKLINK_API_KEY)}`;
  const cached = useCache ? cache.get(key) : null;
  if (cached && cached.expires > Date.now()) return cached.source;
  const providers = [
    () => sourcifyLookup(network, address, { request }),
    () => blockscoutLookup(network, address, { request }),
    () => etherscanLookup(network, address, { request, apiKey: credentials.ETHERSCAN_API_KEY }),
    () => oklinkLookup(network, address, { request, apiKey: credentials.OKLINK_API_KEY }),
  ];
  let fallback = null;
  let lastError = null;
  for (const provider of providers) {
    try {
      const source = await provider();
      if (!source) continue;
      const claimedCode = source.runtimeBytecode?.onchainBytecode;
      if (runtimeCode && /^0x(?:[0-9a-fA-F]{2})+$/.test(claimedCode ?? '') && keccak256(claimedCode) === keccak256(runtimeCode)) {
        fallback = source;
        break;
      }
      if (!fallback || (source.explorerAbi && !fallback.explorerAbi)) fallback = source;
    } catch (error) { lastError = error; }
  }
  if (!fallback && lastError) throw lastError;
  if (useCache) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { source: fallback, expires: Date.now() + (fallback ? 60 * 60_000 : 5 * 60_000) });
  }
  return fallback;
}
