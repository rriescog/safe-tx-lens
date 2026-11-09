import { Interface, JsonRpcProvider, id } from 'ethers';
import { analyze, calculateHash } from './analyze.mjs';
import { chainId } from './chains.mjs';
import { readJsonResponse } from './response-boundary.mjs';

const EXEC = new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)']);
const STATE = new Interface(['function nonce() view returns (uint256)']);
const SAFE_PROBE = new Interface(['function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])']);
const SUCCESS_TOPIC = id('ExecutionSuccess(bytes32,uint256)').toLowerCase();
const FAILURE_TOPIC = id('ExecutionFailure(bytes32,uint256)').toLowerCase();

// These endpoints were chain-ID checked when added. They remain third-party
// infrastructure: verify the returned chain ID on every request and surface
// outages rather than silently treating missing code as an EOA.
export const PUBLIC_RPC = Object.freeze({
  eth: 'https://eth-mainnet.g.alchemy.com/public', gno: 'https://rpc.gnosischain.com',
  pol: 'https://rpc-mainnet.matic.quiknode.pro', arb1: 'https://arbitrum-one-rpc.publicnode.com',
  oeth: 'https://mainnet.optimism.io', base: 'https://base-rpc.publicnode.com',
  sep: 'https://public.1rpc.io/sepolia', amoy: 'https://polygon-amoy-bor-rpc.publicnode.com', bnb: 'https://bsc-rpc.publicnode.com',
  avax: 'https://avalanche-c-chain-rpc.publicnode.com',
  kat: 'https://rpc.katana.network', xlayer: 'https://rpc.xlayer.tech', imx: 'https://rpc.immutable.com',
});

export async function discoverExecutionNetworks(hash, networks, options = {}) {
  // A Safe hash has no chain ID, whereas an execution hash may be present in
  // an RPC receipt. A receipt is only a discovery hint: the full onchain
  // reconstruction below still verifies the Safe event and EIP-712 hash.
  const fetcher = options.fetchImpl ?? fetch;
  const matches = await Promise.all(networks.map(async network => {
    const rpc = rpcDetailsFor(network, options.rpcUrl).url;
    if (!rpc) return null;
    try {
      const response = await fetcher(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [hash] }), signal: AbortSignal.timeout(4000) });
      if (!response.ok) return null;
      const receipt = (await readJsonResponse(response, 1_000_000)).result;
      if (!receipt?.logs?.some(log => [SUCCESS_TOPIC, FAILURE_TOPIC].includes(log.topics?.[0]?.toLowerCase()))) return null;
      const chainResponse = await fetcher(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(4000) });
      if (!chainResponse.ok || Number((await readJsonResponse(chainResponse, 1_000_000)).result) !== chainId(network)) return null;
      return network;
    } catch { return null; }
  }));
  return matches.filter(Boolean);
}

export function rpcDetailsFor(network, override) {
  if (override !== undefined && override !== null) return { url: override, kind: override ? 'custom' : 'none', label: override ? 'Custom RPC configured for this request' : 'No RPC used' };
  const configured = process.env[`RPC_URL_${network.toUpperCase()}`];
  if (configured) return { url: configured, kind: 'configured', label: `RPC configured for ${network}` };
  const publicUrl = PUBLIC_RPC[network];
  const provider = network === 'eth' ? 'Alchemy public' : network === 'gno' ? 'Gnosis public' : network === 'oeth' ? 'Optimism public' : network === 'pol' ? 'QuickNode public' : network === 'sep' ? '1RPC public' : ['kat', 'xlayer'].includes(network) ? 'Network public' : 'PublicNode';
  return publicUrl ? { url: publicUrl, kind: 'public', label: `${provider} (${new URL(publicUrl).host})` } : { url: null, kind: 'none', label: 'No RPC configured for this network' };
}

export function rpcFor(network, override) {
  return rpcDetailsFor(network, override).url;
}

export async function contractPresence(address, network, options = {}) {
  const rpc = rpcFor(network, options.rpcUrl);
  if (!rpc) return 'unknown';
  const request = async (method, params, { safeProbe = false } = {}) => {
    const response = await (options.fetchImpl ?? fetch)(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('RPC unavailable');
    const body = await readJsonResponse(response, 1_000_000);
    if (safeProbe && body.error?.code === 3 && /execution reverted/i.test(String(body.error.message))) return '0x';
    if (body.error || typeof body.result !== 'string') throw new Error('Invalid RPC response');
    return body.result;
  };
  try {
    if (Number(await request('eth_chainId', [])) !== chainId(network)) return 'unknown';
    if (await request('eth_getCode', [address, 'latest']) === '0x') return 'absent';
    // A contract at the address is not necessarily a Safe. A failed probe
    // stays unknown when the RPC itself is unavailable; only an answer that
    // cannot decode as a Safe owner/threshold view is marked incompatible.
    try {
      const thresholdResult = await request('eth_call', [{ to: address, data: SAFE_PROBE.encodeFunctionData('getThreshold', []) }, 'latest'], { safeProbe: true });
      if (thresholdResult === '0x') return 'not_safe';
      const ownersResult = await request('eth_call', [{ to: address, data: SAFE_PROBE.encodeFunctionData('getOwners', []) }, 'latest'], { safeProbe: true });
      if (ownersResult === '0x') return 'not_safe';
      const threshold = SAFE_PROBE.decodeFunctionResult('getThreshold', thresholdResult)[0];
      const owners = SAFE_PROBE.decodeFunctionResult('getOwners', ownersResult)[0];
      return threshold > 0n && owners.length >= Number(threshold) ? 'present' : 'not_safe';
    } catch { return 'unknown'; }
  } catch { return 'unknown'; }
}

export async function findRecentExecutionBySafeHash(safe, safeHash, network = 'eth', options = {}) {
  const rpcUrl = rpcFor(network, options.rpcUrl);
  if (!rpcUrl && !options.provider) return null;
  const provider = options.provider ?? new JsonRpcProvider(rpcUrl);
  const [chain, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  if (Number(chain.chainId) !== chainId(network)) throw new Error('RPC chain does not match selected network');
  const logs = await provider.getLogs({ address: safe, topics: [[SUCCESS_TOPIC, FAILURE_TOPIC], safeHash], fromBlock: Math.max(0, latest - 8100), toBlock: 'latest' });
  if (!logs.length) return null;
  return analyzeExecutionHash(logs.at(-1).transactionHash, network, options);
}

export async function fetchRecentExecutions(safe, network = 'eth', options = {}) {
  const rpcUrl = rpcFor(network, options.rpcUrl);
  if (!rpcUrl && !options.provider) throw new Error(`An RPC URL is required for ${network}`);
  const provider = options.provider ?? new JsonRpcProvider(rpcUrl);
  const [chain, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  if (Number(chain.chainId) !== chainId(network)) throw new Error('RPC chain does not match selected network');
  const fromBlock = Math.max(0, latest - 8100);
  const logs = await provider.getLogs({ address: safe, topics: [[SUCCESS_TOPIC, FAILURE_TOPIC]], fromBlock, toBlock: 'latest' });
  const hashes = [...new Set(logs.reverse().map(log => log.transactionHash))].slice(0, options.limit ?? 20);
  const reports = [];
  for (const hash of hashes) reports.push(await analyzeExecutionHash(hash, network, options));
  return { reports, fromBlock, toBlock: latest, truncated: logs.length > hashes.length || fromBlock > 0 };
}

export async function analyzeExecutionHash(hash, network = 'eth', options = {}) {
  // An execution transaction contains Safe.execTransaction calldata, but its
  // nonce is not an argument. Recover that nonce by matching the emitted Safe
  // hash against locally recomputed candidates, never by trusting a label.
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('Invalid Ethereum execution transaction hash');
  const rpcUrl = rpcFor(network, options.rpcUrl);
  if (!rpcUrl && !options.provider) throw new Error(`An RPC URL is required for ${network}`);
  const provider = options.provider ?? new JsonRpcProvider(rpcUrl);
  const [chain, outer, receipt] = await Promise.all([provider.getNetwork(), provider.getTransaction(hash), provider.getTransactionReceipt(hash)]);
  if (Number(chain.chainId) !== chainId(network)) throw new Error('RPC chain does not match selected network');
  if (!outer || !receipt || !outer.to) throw new Error('Execution transaction was not found on the selected chain');
  const decoded = EXEC.parseTransaction({ data: outer.data });
  if (!decoded || decoded.name !== 'execTransaction') throw new Error('Onchain transaction is not a Safe execTransaction');
  const a = decoded.args;
  const raw = {
    safe: outer.to, to: a[0], value: a[1].toString(), data: a[2], operation: Number(a[3]),
    safeTxGas: a[4].toString(), baseGas: a[5].toString(), gasPrice: a[6].toString(),
    gasToken: a[7], refundReceiver: a[8], signatures: a[9],
    executor: outer.from, transactionHash: hash, blockNumber: receipt.blockNumber, isExecuted: true,
  };
  const event = receipt.logs.find(log => log.address.toLowerCase() === raw.safe.toLowerCase() && [SUCCESS_TOPIC, FAILURE_TOPIC].includes(log.topics[0]?.toLowerCase()));
  if (!event) throw new Error('Safe execution event with transaction hash was not found');
  raw.safeTxHash = event.topics[1] ?? (event.data.length >= 66 ? `0x${event.data.slice(2, 66)}` : null);
  if (!raw.safeTxHash) throw new Error('Safe execution event has no transaction hash');
  raw.isSuccessful = event.topics[0].toLowerCase() === SUCCESS_TOPIC;
  const nonceData = STATE.encodeFunctionData('nonce', []);
  let latestNonce;
  try {
    const result = await provider.call({ to: raw.safe, data: nonceData, blockTag: receipt.blockNumber - 1 });
    latestNonce = BigInt(STATE.decodeFunctionResult('nonce', result)[0]);
  } catch {
    // Some public RPCs lack archive state. Current nonce gives a bounded
    // search, while the EIP-712 match still decides which candidate is valid.
    const result = await provider.call({ to: raw.safe, data: nonceData });
    latestNonce = BigInt(STATE.decodeFunctionResult('nonce', result)[0]);
  }
  let matched = false;
  for (let offset = 0n; offset <= 5000n && latestNonce >= offset; offset++) {
    const nonce = latestNonce - offset;
    raw.nonce = nonce.toString();
    if (calculateHash(raw, network).toLowerCase() === raw.safeTxHash.toLowerCase()) { matched = true; break; }
  }
  if (!matched) throw new Error('Could not recover Safe nonce from the execution event within 5,000 recent nonces');
  const report = await analyze(raw, network, { ...options, rpcUrl, rpcProvenance: options.rpcProvenance ?? (options.provider ? { kind: 'custom', label: 'RPC provider supplied by caller' } : rpcDetailsFor(network, options.rpcUrl)), verifyTargets: options.verifyTargets ?? true, targetProvider: options.targetProvider ?? provider });
  const block = await provider.getBlock(receipt.blockNumber);
  return { ...report, evidence: { source: 'onchain_execution', executionHash: hash, blockNumber: receipt.blockNumber, blockTime: block ? new Date(block.timestamp * 1000).toISOString() : null } };
}
