import { FunctionFragment, Interface, JsonRpcProvider, getAddress, isAddress, keccak256 } from 'ethers';
import { chainId } from './chains.mjs';
import { lookupContractSource, sourcifyLookup } from './abi-sources.mjs';

export { sourcifyLookup };

const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// Circle's FiatTokenProxy uses the older ZeppelinOS implementation slot.
// Read it only when verified outer code and ABI identify that proxy pattern.
const LEGACY_IMPLEMENTATION_SLOT = '0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3';
const MAX_TARGETS = 32;
// These exact runtime fingerprints were reviewed against the linked Sourcify
// source. In both implementations, fallback delegatecalls the same address
// returned by implementation(). A matching getter alone cannot prove this.
const VERIFIED_GETTER_FALLBACKS = new Map([
  ['0x16a91aacbcdd1004cdf64fae29bcb2647e0b8652868adba817af4db0944a9a69', { pattern: 'GovernanceProxy delegatecall fallback', source: 'https://repo.sourcify.dev/1/0x6e7a5820baD6cebA8Ef5ea69c0C92EbbDAc9CE48' }],
  ['0x21e86e6f958f52aed4a68a4741a2ee6fce762ba95648aabb9fdb07b4647b6e9a', { pattern: 'StakeManagerProxy delegatecall fallback', source: 'https://repo.sourcify.dev/1/0x5e3Ef299fDDf15eAa0432E6e66473ace8c13D908' }],
]);
const VERIFIED_LEGACY_FALLBACKS = new Map([
  ['0xd80d4b7c890cb9d6a4893e6b52bc34b56b25335cb13716e0d1d31383e6b41505', { pattern: 'Circle FiatTokenProxy delegatecall fallback', source: 'https://repo.sourcify.dev/1/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }],
]);

// Protocol hard forks can replace a system contract's runtime code in place
// (Polygon Bor `blockAlloc`, BSC `core/systemcontracts` upgrades). Source verifiers may then hold only the earlier
// version. Each entry pins the exact replacement code hash from the client
// configuration and the exact earlier code hash whose verified ABI is reused,
// minus selectors the replacement no longer dispatches. Any other code still
// fails as a mismatch.
const PROTOCOL_CODE_REPLACEMENTS = new Map([
  ['137:0x0000000000000000000000000000000000001001:0xaa002524bd13fa0fbfb6a6a7d709631ae5de76234759499503616ad1edb21b82', {
    label: 'Polygon StateReceiver replaced by the Bor Uburu hard fork at block 96787900',
    previousCodeHash: '0x8347355457cf3921b2f8358ef5a79b3935328ae40d6519238f2487525bade90d',
    removedSelectors: [],
    source: 'https://github.com/0xPolygon/bor/blob/156755608234bb4220460abd4d8c9ef691691010/internal/cli/server/chains/mainnet.go#L133',
  }],
  ['137:0x0000000000000000000000000000000000001010:0x82c4ebd167e81e53bef0589ab868a9399ebc29b3d6dcbbe3c4cfe54644bf9d58', {
    label: 'Polygon MRC20 (POL native token) replaced by the Bor Ahmedabad hard fork at block 62278656',
    previousCodeHash: '0xb6bc58482cd4072e43dcd798c70a4fc727f8115490558f747acc14e13aac0ccf',
    removedSelectors: ['0x7019d41a'],
    source: 'https://github.com/0xPolygon/bor/blob/156755608234bb4220460abd4d8c9ef691691010/internal/cli/server/chains/mainnet.go#L116',
  }],
  ['80002:0x0000000000000000000000000000000000001001:0x161913be6f75f70eb639c4f48e4fc39bb08b2d50abc8073b9c8581544fe667e1', {
    label: 'Polygon Amoy StateReceiver replaced by the Bor Uburu hard fork at block 51978200',
    previousCodeHash: '0xafb3ac1ecfe7e09981532289ed99255d53923adaa801edeec3763fbd49437376',
    removedSelectors: [],
    source: 'https://github.com/0xPolygon/bor/blob/156755608234bb4220460abd4d8c9ef691691010/builder/files/genesis-amoy.json#L87',
  }],
  ['56:0x0000000000000000000000000000000000001004:0x823b8a71daca169b3880c7c2b0ff7bce9e44a295d19ab9f44180c9b2d90b1d43', {
    label: 'BNB Chain TokenHub replaced by the BSC Pascal hard fork',
    previousCodeHash: '0x8019bd2d9e60807df3309c5d7028e6dab1c19c46bbef615f8e6105c995ab0e66',
    removedSelectors: ['0xfb063e8f', '0xfc3e5908', '0xff9c0027', '0xebf71d53', '0xf0148472', '0xf1fad104', '0xd9e6dae9', '0xa496fba2', '0xa7c9f02d', '0x96713da9', '0x8b87b21f', '0x7942fd05', '0x70fd5bad', '0x718a8aa8', '0x66dea52a', '0x4a3acdf4', '0x4bf6c882', '0x3dffc387', '0x0bee7a67'],
    source: 'https://github.com/bnb-chain/bsc/blob/4bd1c73016e31038a0ce9fdadce24d19d7128e25/core/systemcontracts/pascal/mainnet/TokenHubContract',
  }],
  ['56:0x0000000000000000000000000000000000001005:0x8444c96b44d320e76019c082e60cf5f1c6c25c853b87aa986afa396c02c73815', {
    label: 'BNB Chain RelayerIncentivize replaced by the BSC Pascal hard fork',
    previousCodeHash: '0x034a95df5ae5fa54aaa99d7a21f5994a579ff5391bc72365f26e78b13e1f22e8',
    removedSelectors: ['0xe75d72c7', '0xfc3e5908', '0xbd4cc830', '0xaf400681', '0x96713da9', '0x70fd5bad', '0x7942fd05', '0x4bf6c882', '0x54133307', '0x3dffc387', '0x08f2ec06', '0x0bee7a67'],
    source: 'https://github.com/bnb-chain/bsc/blob/4bd1c73016e31038a0ce9fdadce24d19d7128e25/core/systemcontracts/pascal/mainnet/RelayerIncentivizeContract',
  }],
  ['56:0x0000000000000000000000000000000000001008:0xd287b3cd3ee885f935ef0a2464e0ec3db253ae7318194dafe9ffd9bfab17a513', {
    label: 'BNB Chain TokenManager replaced by the BSC Pascal hard fork',
    previousCodeHash: '0xba01fba414d7817fad08adcbd99f181f8deda65a5fd19e42e28d6c24c5cd87e5',
    removedSelectors: ['0xfa9e9159', '0xfc3e5908', '0xfe3a2af5', '0xd9e6dae9', '0xc8e704a4', '0xd7109ce6', '0xb7950317', '0xbd32d3f9', '0xab67a485', '0x9a854bbd', '0x859180fb', '0x95b9ad26', '0x96713da9', '0x7d078e13', '0x7942fd05', '0x66dea52a', '0x70fd5bad', '0x5d499b1b', '0x5f558f86', '0x61368475', '0x4bc81c00', '0x4bf6c882', '0x401809f9', '0x487c88ac', '0x3dffc387', '0x1f91600b', '0x23996b53', '0x2d89ac32', '0x0bee7a67', '0x0f212b1b'],
    source: 'https://github.com/bnb-chain/bsc/blob/4bd1c73016e31038a0ce9fdadce24d19d7128e25/core/systemcontracts/pascal/mainnet/TokenManagerContract',
  }],
  ['56:0x0000000000000000000000000000000000002004:0x14fd07d5f04900d20ac14ce8b39cfada460105b156d694370127b144964e7a68', {
    label: 'BNB Chain BSCGovernor replaced by the BSC Pasteur hard fork',
    previousCodeHash: '0x7ae300ba9ca804d2ae45d86928e518eb806263d17a905b6e89afcee4998296c1',
    removedSelectors: [],
    source: 'https://github.com/bnb-chain/bsc/blob/4bd1c73016e31038a0ce9fdadce24d19d7128e25/core/systemcontracts/pasteur/mainnet/GovernorContract',
  }],
]);

// One line per source, in query order, so every report states what each
// provider actually answered instead of a generic "not verified".
export function evidenceReason(evidence = [], fallback = '') {
  const lines = (evidence ?? []).map(item => `${item.label}: ${item.detail}`);
  return lines.length ? lines.join(' ') : fallback;
}

export function recognizeGetterFallback(check) {
  if (check.status !== 'verified' || check.proxy?.standard !== 'implementation() fallback' || check.proxy.implementationCode?.status !== 'verified') return null;
  const known = VERIFIED_GETTER_FALLBACKS.get(check.bytecodeHash?.toLowerCase());
  return known ? { status: 'verified_at_block', pattern: known.pattern, source: known.source, blockTag: check.blockTag } : null;
}

export function recognizeLegacyFallback(check) {
  if (check.status !== 'verified' || check.proxy?.standard !== 'ZeppelinOS implementation slot' || check.proxy.implementationCode?.status !== 'verified') return null;
  const known = VERIFIED_LEGACY_FALLBACKS.get(check.bytecodeHash?.toLowerCase());
  return known ? { status: 'verified_at_block', pattern: known.pattern, source: known.source, blockTag: check.blockTag } : null;
}

// Read the same proxy mechanism at a later block. A verified ABI tells us
// what a selector means, while this read establishes which implementation
// the proxy points to at that block. It cannot resolve intra-block order.
export async function proxyImplementationAt(check, provider, blockTag) {
  const standard = check.proxy?.standard;
  let address;
  if (standard === 'implementation() fallback') {
    const iface = new Interface(['function implementation() view returns (address)']);
    const raw = await provider.call({ to: check.address, data: iface.encodeFunctionData('implementation'), blockTag });
    address = iface.decodeFunctionResult('implementation', raw)[0];
  } else {
    const slot = standard === 'ERC-1967' ? IMPLEMENTATION_SLOT : standard === 'ZeppelinOS implementation slot' ? LEGACY_IMPLEMENTATION_SLOT : standard === 'SafeProxy' ? 0 : null;
    if (slot === null) return null;
    const raw = await provider.getStorage(check.address, slot, blockTag);
    address = `0x${raw.slice(-40)}`;
  }
  return isAddress(address) && !/^0x0{40}$/i.test(address) ? getAddress(address) : null;
}

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
    let source = await lookup(network, entry.address, { runtimeCode: code, blockTag: effectiveBlockTag });
    if (Array.isArray(source?.evidence)) result.sourceEvidence = source.evidence;
    if (source?.noSource) source = null;
    if (!source) result.reason = evidenceReason(result.sourceEvidence, 'No source provider has a verified source for this address');
    if (source) {
      const matchedBytecode = source.runtimeBytecode?.onchainBytecode;
      const matches = /^0x(?:[0-9a-fA-F]{2})+$/.test(matchedBytecode ?? '') && keccak256(matchedBytecode) === bytecodeHash;
      const sourcifyCode = source.sourcifyCandidate?.runtimeBytecode?.onchainBytecode ?? (source.explorerAbi ? null : matchedBytecode);
      const replacement = PROTOCOL_CODE_REPLACEMENTS.get(`${chainId(network)}:${entry.address.toLowerCase()}:${bytecodeHash}`);
      const pinnedReplacement = !matches && replacement && /^0x(?:[0-9a-fA-F]{2})+$/.test(sourcifyCode ?? '') && keccak256(sourcifyCode) === replacement.previousCodeHash;
      if (matches) {
        if (!['exact_match', 'match'].includes(source.runtimeMatch ?? source.match)) {
          result.reason = 'Source provider returned no recognized runtime match status';
        } else {
          result.status = base.historicalUnavailable ? 'verified_current' : 'verified';
          result.reason = `${source.importedFrom ? `Sourcify (source imported from ${source.importedFrom})` : source.sourceProvider ?? 'Sourcify'} ${source.runtimeMatch ?? source.match}; runtime bytecode matches ${base.historicalUnavailable ? 'current RPC only (historical state unavailable)' : 'RPC at the inspected block'}`;
          result.source = source.sourceUrl ?? `https://repo.sourcify.dev/${chainId(network)}/${entry.address}`;
          result.sourceProvider = source.sourceProvider ?? 'sourcify';
        }
      } else if (pinnedReplacement) {
        // Prefer the explorer ABI (published for the current code); otherwise
        // reuse the earlier verified ABI minus selectors the new code dropped.
        const removed = new Set(replacement.removedSelectors);
        const earlierAbi = (source.sourcifyCandidate?.abi ?? source.abi ?? []).filter(item => {
          if (item?.type !== 'function') return true;
          try { return !removed.has(FunctionFragment.from(item).selector); } catch { return false; }
        });
        const explorerAbi = source.explorerAbi && Array.isArray(source.abi);
        source = { ...source, abi: explorerAbi ? source.abi : earlierAbi };
        result.status = 'explorer_abi';
        result.sourceProvider = 'Client hard-fork allocation';
        result.source = replacement.source;
        result.protocolReplacement = { label: replacement.label, previousSource: `https://repo.sourcify.dev/${chainId(network)}/${entry.address}`, abiFrom: explorerAbi ? source.sourceProvider : 'earlier verified version' };
        result.sourceEvidence = [...(result.sourceEvidence ?? []), { provider: 'protocol', label: 'Client hard-fork configuration', outcome: 'match', detail: `${replacement.label}. The RPC bytecode hash equals the code pinned in the client configuration, and Sourcify's verified source is the version that code replaced.`, url: replacement.source }];
        result.reason = `${replacement.label}. ${evidenceReason(result.sourceEvidence)}`;
      } else if (source.explorerAbi && Array.isArray(source.abi)) {
        result.status = 'explorer_abi';
        result.source = source.sourceUrl ?? null;
        result.sourceProvider = source.sourceProvider;
        result.reason = `ABI from ${source.sourceProvider}; runtime bytecode not matched to verified source${blockTag !== 'latest' ? ' at the historical block' : ''}. ${evidenceReason(result.sourceEvidence)}`;
      } else if (/^0x(?:[0-9a-fA-F]{2})+$/.test(matchedBytecode ?? '')) {
        result.status = 'mismatch';
        result.reason = `Verified source describes different bytecode than the RPC returned at the selected block. ${evidenceReason(result.sourceEvidence)}`;
      } else {
        result.reason = `Source provider did not return runtime bytecode for an independent comparison. ${evidenceReason(result.sourceEvidence)}`;
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
            result.legacyProxyCandidate = Boolean(iface.getFunction('implementation()') && iface.getFunction('admin()') && source.abi.some(item => item?.type === 'fallback') && code.toLowerCase().includes(LEGACY_IMPLEMENTATION_SLOT.slice(2)));
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
    if (!result.proxy && result.legacyProxyCandidate) {
      try {
        const slot = await provider.getStorage(entry.address, LEGACY_IMPLEMENTATION_SLOT, effectiveBlockTag);
        const implementation = `0x${slot.slice(-40)}`;
        if (isAddress(implementation) && implementation.toLowerCase() !== entry.address.toLowerCase() && !/^0x0{40}$/i.test(implementation)) {
          result.proxy = { standard: 'ZeppelinOS implementation slot', implementation: getAddress(implementation) };
          result.proxy.implementationCode = await inspectOne({ address: result.proxy.implementation, selectors: entry.selectors, operations: entry.operations }, provider, network, effectiveBlockTag, lookup, 1, Boolean(base.historicalUnavailable));
        }
      } catch (error) { result.proxyCheck = `Legacy implementation slot unavailable: ${error.shortMessage ?? error.message}`; }
    }
    const forwarding = recognizeGetterFallback(result) ?? recognizeLegacyFallback(result);
    if (forwarding) result.proxy.forwarding = forwarding;
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
