import { id, isAddress } from 'ethers';
import { chainId } from './chains.mjs';
import { localCredentials } from './tenderly-storage.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const EVENT = id('ExecutionSuccess(bytes32,uint256)');
const FAILURE = id('ExecutionFailure(bytes32,uint256)');
const cache = new Map();

export async function findIndexedExecution(safeHash, network, options = {}) {
  if (!HASH.test(safeHash)) throw new Error('Invalid Safe transaction hash');
  // Explicit overrides let tests exercise outages without reading a real
  // local key or reaching the public index.
  const apiKey = Object.hasOwn(options, 'apiKey') ? options.apiKey : (await localCredentials()).ETHERSCAN_API_KEY;
  if (!apiKey) return null;
  const key = `${network}:${safeHash.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 60000) return cached.value;
  const params = new URLSearchParams({ chainid: String(chainId(network)), module: 'logs', action: 'getLogs', fromBlock: '0', toBlock: 'latest', topic1: safeHash, apikey: apiKey });
  const response = await (options.fetchImpl ?? fetch)(`https://api.etherscan.io/v2/api?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Etherscan event index ${response.status}`);
  const data = await response.json();
  if (data.status === '0' && /No records found/i.test(data.message)) {
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
  if (data.status !== '1' || !Array.isArray(data.result)) throw new Error(`Etherscan event index unavailable: ${String(data.result ?? data.message).slice(0, 100)}`);
  const log = data.result.find(item => isAddress(item.address) && HASH.test(item.transactionHash) && [EVENT.toLowerCase(), FAILURE.toLowerCase()].includes(item.topics?.[0]?.toLowerCase()) && item.topics?.[1]?.toLowerCase() === safeHash.toLowerCase());
  const value = log ? { safe: log.address, executionHash: log.transactionHash, blockNumber: Number.parseInt(log.blockNumber, 16) } : null;
  cache.set(key, { at: Date.now(), value });
  return value;
}
