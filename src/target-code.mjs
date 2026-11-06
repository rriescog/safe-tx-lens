import { Interface, JsonRpcProvider, getAddress, isAddress, keccak256 } from 'ethers';
import { chainId } from './chains.mjs';

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_TARGETS = 32;

function targets(root) {
  const found = new Map();
  const visit = node => {
    if (isAddress(node.to)) {
      const key = node.to.toLowerCase();
      const entry = found.get(key) ?? { address: getAddress(node.to), selectors: new Set(), operations: new Set() };
      if (/^0x[0-9a-fA-F]{8}$/.test(node.selector)) entry.selectors.add(node.selector.toLowerCase());
      entry.operations.add(node.operation);
      found.set(key, entry);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  if (found.size > MAX_TARGETS) throw new Error(`Call graph has more than ${MAX_TARGETS} unique target contracts`);
  return [...found.values()];
}

export async function sourcifyLookup(network, address) {
  const id = chainId(network);
  const response = await fetch(`https://sourcify.dev/server/v2/contract/${id}/${address}?fields=abi,runtimeBytecode.onchainBytecode`, { signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Sourcify ${response.status}`);
  return response.json();
}

async function inspectOne(entry, provider, network, blockTag, lookup, depth = 0, historicalUnavailable = false) {
  const base = { address: entry.address, network, blockTag, selectors: [...entry.selectors], operations: [...entry.operations] };
  let code;
  let effectiveBlockTag = blockTag;
  try { code = await provider.getCode(entry.address, blockTag); }
  catch (error) {
    if (blockTag === 'latest') return { ...base, status: 'unavailable', reason: `RPC bytecode unavailable: ${error.shortMessage ?? error.message}` };
    try { code = await provider.getCode(entry.address, 'latest'); effectiveBlockTag = 'latest'; }
    catch { return { ...base, status: 'unavailable', reason: `Historical and current RPC bytecode unavailable: ${error.shortMessage ?? error.message}` }; }
  }
  base.blockTag = effectiveBlockTag;
  if (historicalUnavailable || (effectiveBlockTag === 'latest' && blockTag !== 'latest')) base.historicalUnavailable = true;
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(code)) return { ...base, status: 'unavailable', reason: 'RPC returned invalid bytecode' };
  if (code === '0x') return { ...base, status: 'no_code', reason: 'No bytecode at this address for the selected block' };
  const bytecodeHash = keccak256(code);
  const result = { ...base, bytecodeHash, byteLength: (code.length - 2) / 2, status: 'unverified', source: null, reason: 'No matching verified source was found' };
  try {
    const source = await lookup(network, entry.address);
    if (source) {
      const matchedBytecode = source.runtimeBytecode?.onchainBytecode;
      if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(matchedBytecode ?? '')) {
        result.reason = 'Sourcify did not return runtime bytecode for an independent comparison';
      } else if (keccak256(matchedBytecode) !== bytecodeHash) {
        result.status = 'mismatch';
        result.reason = 'Sourcify verified bytecode differs from RPC bytecode at the selected block';
      } else if (!['exact_match', 'match'].includes(source.runtimeMatch ?? source.match)) {
        result.reason = 'Sourcify returned no recognized runtime match status';
      } else {
        result.status = base.historicalUnavailable ? 'verified_current' : 'verified';
        result.reason = `Sourcify ${source.runtimeMatch ?? source.match}; runtime bytecode matches ${base.historicalUnavailable ? 'current RPC only (historical state unavailable)' : 'RPC at the inspected block'}`;
        result.source = `https://repo.sourcify.dev/${chainId(network)}/${entry.address}`;
        if (Array.isArray(source.abi) && entry.selectors.size) {
          try {
            const iface = new Interface(source.abi);
            if (source.abi.length && iface.fragments.length === 0) result.abiWarning = 'Verified ABI could not be parsed';
            else result.abiSelectors = [...entry.selectors].map(selector => ({ selector, present: Boolean(iface.getFunction(selector)) }));
          } catch (error) { result.abiWarning = `Verified ABI could not be parsed: ${error.message}`; }
        }
      }
    }
  } catch (error) { result.reason = `Verified source lookup unavailable: ${error.message}`; }
  // ERC-1967 is only one proxy standard. A zero slot is not proof of a direct
  // contract; other proxies and diamonds must remain explicitly unresolved.
  if (depth === 0) {
    try {
      const slot = await provider.getStorage(entry.address, IMPLEMENTATION_SLOT, effectiveBlockTag);
      const implementation = `0x${slot.slice(-40)}`;
      if (isAddress(implementation) && !/^0x0{40}$/i.test(implementation)) {
        result.proxy = { standard: 'ERC-1967', implementation: getAddress(implementation) };
        result.proxy.implementationCode = await inspectOne({ address: result.proxy.implementation, selectors: entry.selectors, operations: entry.operations }, provider, network, effectiveBlockTag, lookup, 1, Boolean(base.historicalUnavailable));
      }
    } catch (error) { result.proxyCheck = `ERC-1967 slot unavailable: ${error.shortMessage ?? error.message}`; }
  }
  return result;
}

export async function inspectTargetCode(call, network, { rpcUrl, provider, blockTag = 'latest', sourceLookup = sourcifyLookup } = {}) {
  const entries = targets(call);
  if (!rpcUrl && !provider) return entries.map(entry => ({ address: entry.address, network, blockTag, selectors: [...entry.selectors], status: 'unavailable', reason: 'No RPC configured for this network' }));
  const rpc = provider ?? new JsonRpcProvider(rpcUrl);
  try {
    const chain = await rpc.getNetwork();
    if (Number(chain.chainId) !== chainId(network)) throw new Error('RPC chain does not match the transaction network');
  } catch (error) {
    return entries.map(entry => ({ address: entry.address, network, blockTag, selectors: [...entry.selectors], status: 'unavailable', reason: error.message }));
  }
  const reports = [];
  for (const entry of entries) reports.push(await inspectOne(entry, rpc, network, blockTag, sourceLookup));
  return reports;
}
