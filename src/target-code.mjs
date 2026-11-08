import { Interface, JsonRpcProvider, getAddress, isAddress, keccak256 } from 'ethers';
import { chainId } from './chains.mjs';
import { lookupContractSource, sourcifyLookup } from './abi-sources.mjs';

export { sourcifyLookup };

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const MAX_TARGETS = 32;

function targets(root) {
  const found = new Map();
  const visit = node => {
    if (isAddress(node.to)) {
      const key = node.to.toLowerCase();
      const entry = found.get(key) ?? { address: getAddress(node.to), selectors: new Set(), operations: new Set(), needsDecode: false };
      if (/^0x[0-9a-fA-F]{8}$/.test(node.selector)) entry.selectors.add(node.selector.toLowerCase());
      if (node.data !== '0x' && (!node.method || node.decodeBasis === 'selector_candidate')) entry.needsDecode = true;
      entry.operations.add(node.operation);
      found.set(key, entry);
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  if (found.size > MAX_TARGETS) throw new Error(`Call graph has more than ${MAX_TARGETS} unique target contracts`);
  return [...found.values()];
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
    const source = await lookup(network, entry.address, { runtimeCode: code, blockTag: effectiveBlockTag });
    if (source) {
      const matchedBytecode = source.runtimeBytecode?.onchainBytecode;
      if (source.explorerAbi && !matchedBytecode && Array.isArray(source.abi)) {
        result.status = 'explorer_abi';
        result.source = source.sourceUrl ?? null;
        result.sourceProvider = source.sourceProvider;
        result.reason = `ABI supplied by ${source.sourceProvider}; runtime bytecode was not independently matched to verified source${blockTag !== 'latest' ? ' at the historical block' : ''}`;
      } else if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(matchedBytecode ?? '')) {
        result.reason = 'Source provider did not return runtime bytecode for an independent comparison';
      } else if (keccak256(matchedBytecode) !== bytecodeHash) {
        result.status = 'mismatch';
        result.reason = 'Explorer verified bytecode differs from RPC bytecode at the selected block';
      } else if (!['exact_match', 'match'].includes(source.runtimeMatch ?? source.match)) {
        result.reason = 'Source provider returned no recognized runtime match status';
      } else {
        result.status = base.historicalUnavailable ? 'verified_current' : 'verified';
        result.reason = `${source.sourceProvider ?? 'Sourcify'} ${source.runtimeMatch ?? source.match}; runtime bytecode matches ${base.historicalUnavailable ? 'current RPC only (historical state unavailable)' : 'RPC at the inspected block'}`;
        result.source = source.sourceUrl ?? `https://repo.sourcify.dev/${chainId(network)}/${entry.address}`;
        result.sourceProvider = source.sourceProvider ?? 'sourcify';
      }
      if (['verified', 'verified_current', 'explorer_abi'].includes(result.status)) {
        if (Array.isArray(source.abi) && entry.selectors.size && source.abi.length > 512) {
          result.abiWarning = 'Verified ABI is too large to decode within the review limit';
        } else if (Array.isArray(source.abi) && entry.selectors.size) {
          try {
            const iface = new Interface(source.abi);
            // SafeProxy forwards calls through its singleton in storage slot 0.
            // Its own verified ABI contains masterCopy(), not Safe functions.
            // Some verified SafeProxy builds expose only constructor+fallback
            // in their ABI, while implementing masterCopy() in assembly.
            const safeProxyFallback = source.abi.some(item => item?.type === 'constructor' && item.inputs?.some(input => input.name === '_singleton')) && source.abi.some(item => item?.type === 'fallback');
            result.safeProxyCandidate = Boolean(iface.getFunction('masterCopy()')) || (safeProxyFallback && code.toLowerCase().includes('a619486e'));
            // Older transparent proxies expose both getters and dispatch
            // unknown selectors through fallback, without using ERC-1967.
            result.getterProxyCandidate = Boolean(iface.getFunction('implementation()') && iface.getFunction('proxyType()') && source.abi.some(item => item?.type === 'fallback'));
            if (source.abi.length && iface.fragments.length === 0) result.abiWarning = 'Verified ABI could not be parsed';
            else {
              result.abiSelectors = [...entry.selectors].map(selector => ({ selector, present: Boolean(iface.getFunction(selector)) }));
              // Keep only functions actually called by this report. The ABI is
              // trusted for decoding only after its runtime matched RPC code.
              result.verifiedFunctions = [...entry.selectors].flatMap(selector => {
                const fragment = iface.getFunction(selector);
                if (!fragment) return [];
                const abi = fragment.format('json');
                return abi.length <= 4096 ? [{ selector, signature: fragment.format('sighash'), abi }] : [];
              });
            }
          } catch (error) { result.abiWarning = `Verified ABI could not be parsed: ${error.message}`; }
        }
      }
    }
  } catch (error) { result.reason = `Verified source lookup unavailable: ${error.message}`; }
  // ERC-1967 is only one proxy standard. Check SafeProxy's slot-0 singleton
  // only when the verified outer ABI exposes masterCopy(), avoiding a random
  // slot-0 value being presented as a proxy implementation.
  if (depth === 0) {
    try {
      const slot = await provider.getStorage(entry.address, IMPLEMENTATION_SLOT, effectiveBlockTag);
      const implementation = `0x${slot.slice(-40)}`;
      if (isAddress(implementation) && !/^0x0{40}$/i.test(implementation)) {
        result.proxy = { standard: 'ERC-1967', implementation: getAddress(implementation) };
        result.proxy.implementationCode = await inspectOne({ address: result.proxy.implementation, selectors: entry.selectors, operations: entry.operations }, provider, network, effectiveBlockTag, lookup, 1, Boolean(base.historicalUnavailable));
      }
    } catch (error) { result.proxyCheck = `ERC-1967 slot unavailable: ${error.shortMessage ?? error.message}`; }
    if (!result.proxy && result.safeProxyCandidate) {
      try {
        const slot = await provider.getStorage(entry.address, 0, effectiveBlockTag);
        const singleton = `0x${slot.slice(-40)}`;
        if (isAddress(singleton) && !/^0x0{40}$/i.test(singleton)) {
          result.proxy = { standard: 'SafeProxy', implementation: getAddress(singleton) };
          result.proxy.implementationCode = await inspectOne({ address: result.proxy.implementation, selectors: entry.selectors, operations: entry.operations }, provider, network, effectiveBlockTag, lookup, 1, Boolean(base.historicalUnavailable));
        }
      } catch (error) { result.proxyCheck = `Safe singleton slot unavailable: ${error.shortMessage ?? error.message}`; }
    }
    if (!result.proxy && result.getterProxyCandidate) {
      try {
        const iface = new Interface(['function implementation() view returns (address)']);
        // ethers v6 reads blockTag from the transaction request; a second
        // argument is ignored and would silently query the current proxy.
        const data = await provider.call({ to: entry.address, data: iface.encodeFunctionData('implementation'), blockTag: effectiveBlockTag });
        const implementation = iface.decodeFunctionResult('implementation', data)[0];
        if (isAddress(implementation) && implementation.toLowerCase() !== entry.address.toLowerCase() && !/^0x0{40}$/i.test(implementation)) {
          result.proxy = { standard: 'implementation() fallback', implementation: getAddress(implementation) };
          result.proxy.implementationCode = await inspectOne({ address: result.proxy.implementation, selectors: entry.selectors, operations: entry.operations }, provider, network, effectiveBlockTag, lookup, 1, Boolean(base.historicalUnavailable));
        }
      } catch (error) { result.proxyCheck = `Implementation getter unavailable: ${error.shortMessage ?? error.message}`; }
    }
  }
  return result;
}

export async function inspectTargetCode(call, network, { rpcUrl, provider, blockTag = 'latest', sourceLookup = lookupContractSource, maxTargets = MAX_TARGETS } = {}) {
  const entries = targets(call);
  if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > MAX_TARGETS) throw new Error('Invalid target verification limit');
  if (!rpcUrl && !provider) return entries.map(entry => ({ address: entry.address, network, blockTag, selectors: [...entry.selectors], status: 'unavailable', reason: 'No RPC configured for this network' }));
  const rpc = provider ?? new JsonRpcProvider(rpcUrl);
  try {
    const chain = await rpc.getNetwork();
    if (Number(chain.chainId) !== chainId(network)) throw new Error('RPC chain does not match the transaction network');
  } catch (error) {
    return entries.map(entry => ({ address: entry.address, network, blockTag, selectors: [...entry.selectors], status: 'unavailable', reason: error.message }));
  }
  // Public reviews spend their small lookup budget on undecoded calls first.
  // Retain skipped entries as unavailable so the report never claims that all
  // target bytecode was checked after inspecting only a subset.
  const ordered = maxTargets < entries.length ? [...entries].sort((a, b) => Number(b.needsDecode) - Number(a.needsDecode)) : entries;
  const reports = [];
  for (const [index, entry] of ordered.entries()) {
    if (index >= maxTargets) reports.push({ address: entry.address, network, blockTag, selectors: [...entry.selectors], status: 'unavailable', reason: 'Automatic target verification limit reached; inspect this target separately' });
    else reports.push(await inspectOne(entry, rpc, network, blockTag, sourceLookup));
  }
  return reports;
}
