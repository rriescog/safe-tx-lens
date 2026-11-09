import { Interface, JsonRpcProvider, TypedDataEncoder, getAddress, id, isAddress } from 'ethers';
import { chainId } from './chains.mjs';
import { decodeCall, enrichCandidateCalls, enrichVerifiedCalls, summarizeCalls } from './decode.mjs';
import { assessConfidence } from './confidence.mjs';
import { assessRisk } from './risk.mjs';
import { fetchTransaction, safeGet } from './safe-api.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { inspectTargetCode } from './target-code.mjs';
import { enrichTokenCalls } from './token-metadata.mjs';
import { readJsonResponse } from './response-boundary.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const SAFE_TYPES = { SafeTx: [
  { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
  { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' },
  { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
  { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
] };
const HASH_IFACE = new Interface(['function getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256) view returns (bytes32)']);
const EXEC_IFACE = new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)']);
const STATE_IFACE = new Interface(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function nonce() view returns (uint256)']);
const EXEC_SUCCESS_TOPIC = id('ExecutionSuccess(bytes32,uint256)').toLowerCase();
const EXEC_FAILURE_TOPIC = id('ExecutionFailure(bytes32,uint256)').toLowerCase();
const APPROVE_HASH_TOPIC = id('ApproveHash(bytes32,address)').toLowerCase();

export function normalizeTransaction(raw) {
  const tx = raw?.transaction ?? raw;
  if (!tx || !isAddress(tx.safe) || !isAddress(tx.to)) throw new Error('Transaction needs valid safe and to addresses');
  const data = tx.data ?? '0x';
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || data.length > 2000002) throw new Error('Invalid or oversized calldata');
  const operation = Number(tx.operation ?? 0);
  if (operation !== 0 && operation !== 1) throw new Error('Unsupported operation');
  const number = (value, label) => {
    const string = String(value ?? '0');
    if (!/^\d+$/.test(string)) throw new Error(`Invalid ${label}`);
    return string;
  };
  return {
    safe: getAddress(tx.safe), to: getAddress(tx.to), data, operation,
    value: number(tx.value, 'value'), safeTxGas: number(tx.safeTxGas, 'safeTxGas'),
    baseGas: number(tx.baseGas, 'baseGas'), gasPrice: number(tx.gasPrice, 'gasPrice'),
    gasToken: getAddress(tx.gasToken ?? ZERO), refundReceiver: getAddress(tx.refundReceiver ?? ZERO),
    nonce: number(tx.nonce, 'nonce'), safeTxHash: tx.safeTxHash ?? null,
    isExecuted: Boolean(tx.isExecuted), isSuccessful: tx.isSuccessful ?? null,
    blockNumber: tx.blockNumber ?? null, confirmationsRequired: tx.confirmationsRequired ?? null,
    signatures: /^0x(?:[0-9a-fA-F]{2})+$/.test(tx.signatures ?? '') && tx.signatures.length <= 20002 ? tx.signatures : null,
    transactionHash: tx.transactionHash ?? null, executor: isAddress(tx.executor) ? getAddress(tx.executor) : null, confirmations: tx.confirmations ?? [],
  };
}

export function calculateHash(tx, network) {
  const { safe, safeTxHash, isExecuted, isSuccessful, transactionHash, executor, confirmations, blockNumber, confirmationsRequired, signatures, ...message } = tx;
  return TypedDataEncoder.hash({ chainId: chainId(network), verifyingContract: safe }, SAFE_TYPES, message);
}

export function calculateHashComponents(tx, network) {
  const { safe, safeTxHash, isExecuted, isSuccessful, transactionHash, executor, confirmations, blockNumber, confirmationsRequired, signatures, ...message } = tx;
  const domain = { chainId: chainId(network), verifyingContract: safe };
  // Expose the two intermediate hashes for an independent second opinion.
  // They are calculated by the same local library as the final Safe hash.
  return { domainHash: TypedDataEncoder.hashDomain(domain), messageHash: TypedDataEncoder.hashStruct('SafeTx', SAFE_TYPES, message) };
}

export function classifyIntent(call) {
  const findings = [];
  const walk = (node, path) => {
    const method = node.method?.split('(')[0] ?? null;
    const add = (severity, code, message) => findings.push({ severity, code, path, message });
    if (node.operation === 1) add('critical', 'DELEGATECALL', 'Delegatecall runs target code in the Safe storage context; inspect target bytecode and simulation.');
    if (node.value !== '0') add('info', 'NATIVE_VALUE', `Sends ${node.value} wei from the Safe.`);
    if (!method && node.data !== '0x') add('warning', 'UNKNOWN_SELECTOR', `Selector ${node.selector} has no matching verified ABI in this review. A label from a signature database would not prove behavior.`);
    if (node.decodeBasis === 'selector_candidate') add('warning', 'SELECTOR_CANDIDATE', `Selector ${node.selector} was decoded from a 4byte signature candidate; the signature has not been matched to this target's bytecode or verified ABI.`);
    if (['upgradeTo', 'upgradeToAndCall', 'upgradeAndCall', 'updateImplementation', 'changeAdmin'].includes(method)) add('critical', 'UPGRADE', `Possible implementation or admin change: ${method}.`);
    if (['addOwnerWithThreshold', 'removeOwner', 'swapOwner', 'changeThreshold', 'enableModule', 'disableModule', 'setGuard', 'setFallbackHandler'].includes(method)) add('critical', 'SAFE_AUTHORITY', `Safe authority change: ${method}.`);
    if (['approve', 'increaseAllowance', 'setApprovalForAll'].includes(method)) add('warning', 'APPROVAL', `Approval or operator change: ${method}.`);
    if (method === 'approveHash') add('warning', 'SAFE_HASH_APPROVAL', 'Approves a 32-byte hash as this Safe owner. Resolve the hash to full transaction fields before trusting what it authorizes.');
    if (['transfer', 'transferFrom'].includes(method)) add('info', 'TOKEN_TRANSFER', `Token transfer intent: ${method}.`);
    if (method === 'cleanMapToken') add('warning', 'TOKEN_MAPPING_CHANGE', 'Token mapping cleanup can affect bridge lookups; verify the target contract and resulting state.');
    if (method === 'multiSend') add('warning', 'MULTISEND_TARGET_UNVERIFIED', 'Inner calls are decoded from the bytes, but this tool has not verified that the target bytecode is the canonical Safe MultiSend contract.');
    if (method === 'multiSend' && node.children.length === 0) add('warning', 'EMPTY_BATCH', 'MultiSend decoded with no inner calls.');
    node.children.forEach((child, index) => walk(child, `${path}.${index + 1}`));
  };
  walk(call, '1');
  return findings;
}

export function classifyEffects(simulation, safeAddress) {
  if (!simulation) return [];
  const effects = [];
  for (const diff of simulation.storageDiffs ?? []) {
    if (diff.from == null || diff.to == null || diff.from === '' || diff.to === '') continue;
    const label = String(diff.label ?? 'raw storage slot');
    const safeSlotZero = diff.address?.toLowerCase() === safeAddress?.toLowerCase() && /^0x0{64}$/i.test(label);
    const sensitive = safeSlotZero || /owner|threshold|module|guard|fallback|implementation|admin|paused/i.test(label);
    effects.push({ kind: safeSlotZero ? 'safe_singleton' : sensitive ? 'authority_or_control' : 'storage', severity: sensitive ? 'critical' : 'info', address: diff.address, label: safeSlotZero ? 'Safe singleton (storage slot 0)' : label, before: diff.from, after: diff.to });
  }
  for (const diff of simulation.balanceDiffs ?? []) {
    if (diff.from == null || diff.to == null || diff.from === '' || diff.to === '') continue;
    effects.push({ kind: 'native_balance', severity: 'warning', address: diff.address, before: diff.from, after: diff.to });
  }
  for (const change of simulation.assetChanges ?? []) {
    effects.push({ kind: 'asset_transfer', severity: 'warning', address: change.token, label: change.type, before: change.from, after: change.to, amount: change.amount });
  }
  return effects;
}

async function onchainHash(tx, rpcUrl) {
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const input = HASH_IFACE.encodeFunctionData('getTransactionHash', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce]);
  const blockTag = tx.isExecuted && Number.isInteger(tx.blockNumber) && tx.blockNumber > 0 ? tx.blockNumber - 1 : 'latest';
  const output = await provider.call({ to: tx.safe, data: input, blockTag });
  return { hash: HASH_IFACE.decodeFunctionResult('getTransactionHash', output)[0], chainId: Number(network.chainId), blockTag };
}

// approveHash(bytes32) does not contain the approved transaction's fields.
// Resolve the hash through a bounded Safe lookup, recalculate it from the
// returned fields, then separately ask the target Safe through RPC. Never
// render the approved transaction as a child call: approving a hash does not
// execute that transaction.
async function inspectApprovedHashes(call, tx, network, options) {
  const nodes = [];
  const walk = (node, path) => {
    if (node.method?.split('(')[0] === 'approveHash' && node.selector === '0xd4d9bdcd') nodes.push({ node, path });
    node.children.forEach((child, index) => walk(child, `${path}.${index + 1}`));
  };
  walk(call, '1');
  if (!nodes.length) return [];
  const enabled = options.inspectApprovedHashes ?? options.verifyTargets === true;
  const provider = options.approvalProvider ?? (options.rpcUrl && enabled ? new JsonRpcProvider(options.rpcUrl) : null);
  const lookup = options.approvalLookup ?? fetchTransaction;
  const results = [];
  let receipt;
  if (enabled && tx.isExecuted && tx.transactionHash && provider) {
    try {
      if (Number((await provider.getNetwork()).chainId) === chainId(network)) receipt = await provider.getTransactionReceipt(tx.transactionHash);
    } catch { /* A missing receipt leaves onchain approval unverified. */ }
  }
  for (const { node, path } of nodes) {
    const approvedHash = node.args?.[0]?.value;
    if (!/^0x[0-9a-fA-F]{64}$/.test(approvedHash ?? '')) continue;
    const result = { path, network, targetSafe: node.to, approvedHash, status: enabled ? 'unavailable' : 'not_checked', onchainApproval: tx.isExecuted ? 'unavailable' : 'pending', transaction: null, rpc: null, reason: null };
    node.approval = result;
    results.push(result);
    if (!enabled) continue;
    if (results.length > 4) { result.status = 'limit_reached'; result.reason = 'Only the first four approved hashes are resolved per review.'; continue; }
    if (receipt) {
      const ownerTopic = `0x${tx.safe.slice(2).toLowerCase().padStart(64, '0')}`;
      result.onchainApproval = receipt.status === 1 && (receipt.logs ?? []).some(log => log.address?.toLowerCase() === node.to.toLowerCase() && log.topics?.[0]?.toLowerCase() === APPROVE_HASH_TOPIC && log.topics?.[1]?.toLowerCase() === approvedHash.toLowerCase() && log.topics?.[2]?.toLowerCase() === ownerTopic) ? 'observed' : 'not_observed';
    }
    try {
      const raw = await lookup(approvedHash, network);
      const linked = normalizeTransaction(raw);
      const calculated = calculateHash(linked, network);
      result.transaction = { hash: approvedHash, safe: linked.safe, nonce: linked.nonce, to: linked.to, selector: linked.data.slice(0, 10), operation: linked.operation, isExecuted: linked.isExecuted, executionHash: linked.transactionHash, source: raw.lookupSource ?? 'safe_api', calculatedHash: calculated };
      if (linked.safe.toLowerCase() !== node.to.toLowerCase() || calculated.toLowerCase() !== approvedHash.toLowerCase() || linked.safeTxHash && linked.safeTxHash.toLowerCase() !== approvedHash.toLowerCase()) {
        result.status = 'mismatch';
        result.reason = 'The returned transaction Safe, embedded hash, or locally recalculated hash differs from the hash approved by this call.';
        continue;
      }
      result.status = 'matched_fields';
      if (!provider) continue;
      try {
        const chain = await provider.getNetwork();
        if (Number(chain.chainId) !== chainId(network)) { result.rpc = { status: 'unavailable', reason: 'RPC chain does not match the selected network.' }; continue; }
        const input = HASH_IFACE.encodeFunctionData('getTransactionHash', [linked.to, linked.value, linked.data, linked.operation, linked.safeTxGas, linked.baseGas, linked.gasPrice, linked.gasToken, linked.refundReceiver, linked.nonce]);
        const blockTag = linked.isExecuted && Number.isInteger(linked.blockNumber) && linked.blockNumber > 0 ? linked.blockNumber - 1 : 'latest';
        const output = await provider.call({ to: linked.safe, data: input, blockTag });
        const contractHash = HASH_IFACE.decodeFunctionResult('getTransactionHash', output)[0];
        result.rpc = { status: contractHash.toLowerCase() === approvedHash.toLowerCase() ? 'pass' : 'mismatch', hash: contractHash, blockTag };
        if (result.rpc.status === 'pass') result.status = 'rpc_matched';
        else { result.status = 'mismatch'; result.reason = 'The target Safe contract returned a different transaction hash through RPC.'; }
      } catch { result.rpc = { status: 'unavailable', reason: 'The target Safe contract hash could not be read through RPC.' }; }
    } catch (error) {
      result.reason = /\b429\b/.test(error.message) ? 'Safe proposal source rate limit or quota reached.' : /\b404\b/.test(error.message) ? 'No transaction was found for this hash in the configured Safe proposal source.' : 'The approved transaction fields could not be recovered from the configured Safe proposal source.';
    }
  }
  return results;
}

async function safeState(tx, network) {
  return safeGet(network, `/safes/${tx.safe}/`);
}

async function rpcSafeState(tx, rpcUrl, network) {
  const provider = new JsonRpcProvider(rpcUrl);
  if (Number((await provider.getNetwork()).chainId) !== chainId(network)) throw new Error('RPC chain does not match the transaction network');
  let blockTag = 'latest';
  if (tx.isExecuted) {
    const receipt = tx.transactionHash ? await provider.getTransactionReceipt(tx.transactionHash) : null;
    if (receipt) blockTag = receipt.blockNumber - 1;
    else if (Number.isInteger(tx.blockNumber) && tx.blockNumber > 0) blockTag = tx.blockNumber - 1;
  }
  const read = async (name, atBlock) => {
    const result = await provider.call({ to: tx.safe, data: STATE_IFACE.encodeFunctionData(name, []), blockTag: atBlock });
    return STATE_IFACE.decodeFunctionResult(name, result)[0];
  };
  let state;
  try { state = await Promise.all([read('getOwners', blockTag), read('getThreshold', blockTag), read('nonce', blockTag)]); }
  catch (error) {
    if (blockTag === 'latest') throw error;
    blockTag = 'latest';
    state = await Promise.all([read('getOwners', blockTag), read('getThreshold', blockTag), read('nonce', blockTag)]);
  }
  const [owners, threshold, nonce] = state;
  return { owners: [...owners], threshold: threshold.toString(), nonce: nonce.toString(), blockTag, source: blockTag === 'latest' && tx.isExecuted ? 'rpc_current_fallback' : 'rpc' };
}

function collectSignatures(tx, threshold) {
  const confirmations = tx.confirmations.filter(c => c.owner && /^0x[0-9a-fA-F]{130}$/.test(c.signature ?? ''));
  const unique = new Map(confirmations.map(c => [c.owner.toLowerCase(), c]));
  const ordered = [...unique.values()].sort((a, b) => a.owner.toLowerCase().localeCompare(b.owner.toLowerCase()));
  if (ordered.length < threshold) return null;
  return `0x${ordered.slice(0, threshold).map(c => c.signature.slice(2)).join('')}`;
}

async function simulate(tx, network, safeInfo, options) {
  // Credentials stay server-side. The same local config loader serves CLI, UI, and MCP.
  const credentials = await localCredentials();
  const key = options.tenderlyKey ?? credentials.TENDERLY_ACCESS_KEY;
  const account = options.tenderlyAccount ?? credentials.TENDERLY_ACCOUNT;
  const project = options.tenderlyProject ?? credentials.TENDERLY_PROJECT;
  if (!key || !account || !project) return { unavailable: 'Tenderly credentials not configured' };
  const required = Number(tx.isExecuted && tx.confirmationsRequired ? tx.confirmationsRequired : safeInfo.threshold);
  let signatures = tx.signatures ?? collectSignatures(tx, required);
  let conditional = false;
  let conditionalOwner = null;
  if (!signatures) {
    const unusable = () => ({ unavailable: `A faithful Safe execution needs ${required} signatures. This proposal has too few usable signatures, and a conditional preview could not be checked against current Safe storage.` });
    if (tx.isExecuted || !(options.rpcUrl ?? options.simulationRpcUrl) || BigInt(tx.nonce) !== BigInt(safeInfo.nonce ?? -1)) return unusable();
    const owner = safeInfo.owners?.find(isAddress);
    if (!owner) return unusable();
    try {
      const provider = options.simulationProvider ?? new JsonRpcProvider(options.rpcUrl ?? options.simulationRpcUrl);
      if (Number((await provider.getNetwork()).chainId) !== chainId(network)) return unusable();
      // Standard Safe versions store threshold at slot 4. Confirm it before
      // creating a *hypothetical* override; never alter live chain state.
      const slot = await provider.getStorage(tx.safe, 4);
      if (BigInt(slot) !== BigInt(required)) return unusable();
      const ownerIface = new Interface(['function isOwner(address) view returns (bool)']);
      const answer = await provider.call({ to: tx.safe, data: ownerIface.encodeFunctionData('isOwner', [owner]) });
      if (!ownerIface.decodeFunctionResult('isOwner', answer)[0]) return unusable();
      conditional = true;
      conditionalOwner = getAddress(owner);
      // Safe approved-hash signature: owner in r, zero s, v=1. It is valid
      // only because the simulated outer sender is that same owner.
      signatures = `0x${conditionalOwner.slice(2).padStart(64, '0')}${'0'.repeat(64)}01`;
    } catch { return unusable(); }
  }
  const input = EXEC_IFACE.encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signatures]);
  let blockNumber;
  if (tx.isExecuted) {
    if (!tx.executor) return { unavailable: 'Historical executor unknown; cannot reproduce signature checks faithfully' };
    if (!tx.transactionHash || !options.rpcUrl) return { unavailable: 'Historical execution needs RPC_URL to simulate at the preceding block' };
    const receipt = await new JsonRpcProvider(options.rpcUrl).getTransactionReceipt(tx.transactionHash);
    if (receipt) blockNumber = receipt.blockNumber - 1;
    else if (Number.isInteger(tx.blockNumber) && tx.blockNumber > 0) blockNumber = tx.blockNumber - 1;
    else return { unavailable: 'Historical execution receipt unavailable' };
  }
  const endpoint = `https://api.tenderly.co/api/v1/account/${encodeURIComponent(account)}/project/${encodeURIComponent(project)}/simulate`;
  // For an executed Safe transaction msg.sender must equal the real outer
  // transaction sender; approved-hash signatures can depend on that context.
  const executor = conditionalOwner ?? tx.executor ?? tx.confirmations.find(c => c.signatureType === 'APPROVED_HASH' && c.owner)?.owner ?? safeInfo.owners?.[0] ?? tx.safe;
  const stateObjects = conditional ? { [tx.safe]: { storage: { [`0x${'0'.repeat(63)}4`]: `0x${'0'.repeat(63)}1` } } } : undefined;
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Key': key },
    body: JSON.stringify({ network_id: String(chainId(network)), from: executor, to: tx.safe, input, gas: 8000000, gas_price: '0', save: true, save_if_fails: true, simulation_type: 'full', ...(stateObjects ? { state_objects: stateObjects } : {}), ...(blockNumber !== undefined ? { block_number: blockNumber } : {}) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return { unavailable: `Tenderly API returned ${response.status}` };
  const result = await readJsonResponse(response, 16_000_000);
  const transaction = result.transaction ?? {};
  const info = transaction.transaction_info ?? {};
  const storageDiffs = [];
  const stateValue = value => typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  // A decoded variable and its raw slot are two views of the same change. Prefer
  // the named variable; use raw slots when the provider has no decoded variable.
  for (const item of Array.isArray(info.state_diff) ? info.state_diff : []) {
    if (item.soltype?.name && item.original != null && item.dirty != null && stateValue(item.original) !== stateValue(item.dirty)) {
      storageDiffs.push({ address: item.address, label: item.soltype.name, from: stateValue(item.original), to: stateValue(item.dirty) });
    } else for (const raw of Array.isArray(item.raw) ? item.raw : []) if (raw.original != null && raw.dirty != null && stateValue(raw.original) !== stateValue(raw.dirty)) {
      storageDiffs.push({ address: item.address, label: String(raw.key ?? 'raw slot'), from: stateValue(raw.original), to: stateValue(raw.dirty) });
    }
  }
  // balance_changes are transfer summaries, not before/after native balances.
  // Only balance_diff records may be displayed as measured balance changes.
  const balanceRecords = Array.isArray(info.call_trace?.balance_diff) ? info.call_trace.balance_diff : Array.isArray(info.balance_diff) ? info.balance_diff : [];
  const balanceSummaryCount = Array.isArray(info.balance_changes) ? info.balance_changes.length : 0;
  const balanceDiffs = [];
  let balanceDataIncompleteCount = 0;
  for (const record of balanceRecords) {
    const before = record?.original ?? record?.before;
    const after = record?.dirty ?? record?.after;
    if (!isAddress(record?.address) || !['string', 'number', 'bigint'].includes(typeof before) || !['string', 'number', 'bigint'].includes(typeof after) || String(before) === '' || String(after) === '') {
      balanceDataIncompleteCount++;
      continue;
    }
    if (String(before) !== String(after)) balanceDiffs.push({ address: record.address, from: String(before), to: String(after) });
  }
  const assetChanges = (info.asset_changes ?? []).map(change => ({
    type: String(change.type ?? 'token'), token: String(change.token_info?.contract_address ?? change.asset?.address ?? change.token_address ?? ''),
    from: String(change.from ?? change.from_address ?? ''), to: String(change.to ?? change.to_address ?? ''), amount: String(change.amount ?? change.raw_amount ?? ''),
  }));
  let safeExecutionSuccess = null;
  const output = transaction.output ?? info.call_trace?.output;
  if (typeof output === 'string' && /^0x[0-9a-fA-F]{64}$/.test(output)) {
    try { safeExecutionSuccess = Boolean(EXEC_IFACE.decodeFunctionResult('execTransaction', output)[0]); } catch {}
  }
  for (const log of info.logs ?? info.call_trace?.logs ?? []) {
    const topic = String(log.topics?.[0] ?? log.raw?.topics?.[0] ?? '').toLowerCase();
    if (log.address?.toLowerCase() === tx.safe.toLowerCase() && topic === EXEC_SUCCESS_TOPIC) safeExecutionSuccess = true;
    if (log.address?.toLowerCase() === tx.safe.toLowerCase() && topic === EXEC_FAILURE_TOPIC) safeExecutionSuccess = false;
  }
  return { mode: conditional ? 'conditional_threshold_override' : 'faithful', conditionalOwner, evmSuccess: transaction.status === true, safeExecutionSuccess, success: transaction.status === true && safeExecutionSuccess === true ? true : transaction.status === false || safeExecutionSuccess === false ? false : null, url: result.simulation?.id ? `https://dashboard.tenderly.co/${encodeURIComponent(account)}/${encodeURIComponent(project)}/simulator/${result.simulation.id}` : null, stateDiffAvailable: Array.isArray(info.state_diff), storageDiffs, balanceDiffs, balanceSummaryCount, balanceDataIncompleteCount, assetChanges, error: transaction.error_message ?? null, blockNumber: blockNumber ?? 'latest' };
}

export async function analyze(raw, network = 'eth', options = {}) {
  chainId(network);
  const tx = normalizeTransaction(raw);
  const calculatedHash = calculateHash(tx, network);
  const hashComponents = calculateHashComponents(tx, network);
  const warnings = [];
  const checks = [{ name: 'Local EIP-712 hash', method: 'local_eip712', status: tx.safeTxHash ? calculatedHash.toLowerCase() === tx.safeTxHash.toLowerCase() ? 'pass' : 'fail' : 'unverified', detail: calculatedHash }];
  if (checks[0].status === 'fail') warnings.push('The API or JSON safeTxHash does not match the transaction fields. Do not sign.');
  if (options.rpcUrl) {
    try {
      const chain = await onchainHash(tx, options.rpcUrl);
      checks.push({ name: tx.isExecuted && tx.blockNumber ? 'Safe contract hash at pre-execution block' : 'Safe contract hash', method: 'onchain_rpc', status: chain.chainId === chainId(network) && chain.hash.toLowerCase() === calculatedHash.toLowerCase() ? 'pass' : 'fail', detail: chain.hash });
      if (checks.at(-1).status === 'fail') warnings.push('The Safe contract hash or RPC chain differs from the locally calculated hash. Do not sign.');
    } catch (error) { checks.push({ name: tx.isExecuted && tx.blockNumber ? 'Safe contract hash at pre-execution block' : 'Safe contract hash', method: 'onchain_rpc', status: 'unavailable', detail: String(error.shortMessage ?? error.message).slice(0, 240) }); }
  }
  const call = decodeCall(tx);
  // A selector is only a decoding hypothesis. Pin every resolved target to
  // bytecode on the selected chain and compare Sourcify's verified runtime.
  const targetChecks = options.verifyTargets ? await inspectTargetCode(call, network, { rpcUrl: options.rpcUrl, provider: options.targetProvider, blockTag: tx.isExecuted && Number.isInteger(tx.blockNumber) && tx.blockNumber > 0 ? tx.blockNumber - 1 : 'latest', sourceLookup: options.sourceLookup, maxTargets: options.targetLimit }) : [];
  enrichVerifiedCalls(call, targetChecks);
  if (options.decodeCandidates) await enrichCandidateCalls(call, { lookup: options.selectorLookup });
  // A batch can upgrade a proxy and then call a function that exists only in
  // the proposed new implementation. Check that new bytecode separately. It
  // remains conditional: calldata alone cannot prove the upgrade succeeded.
  if (options.verifyTargets) {
    const proposed = new Map();
    const visit = node => {
      if (node.method?.startsWith('updateImplementation(')) {
        const next = node.args?.find(arg => arg.name === 'newImplementation')?.value;
        if (isAddress(next)) proposed.set(node.to.toLowerCase(), getAddress(next));
      }
      node.children?.forEach(visit);
    };
    visit(call);
    let plannedChecks = 0;
    for (const target of targetChecks) {
      const next = proposed.get(target.address.toLowerCase());
      const missing = target.proxy?.implementationCode?.abiSelectors?.filter(selector => !selector.present && !target.abiSelectors?.some(outer => outer.selector === selector.selector && outer.present)) ?? [];
      if (!next || !missing.length || plannedChecks >= 2) continue;
      plannedChecks++;
      const nodes = missing.map(selector => ({ to: next, data: selector.selector, selector: selector.selector, operation: 0, children: [] }));
      const [planned] = await inspectTargetCode({ ...nodes[0], children: nodes.slice(1) }, network, { rpcUrl: options.rpcUrl, provider: options.targetProvider, blockTag: tx.isExecuted && Number.isInteger(tx.blockNumber) && tx.blockNumber > 0 ? tx.blockNumber - 1 : 'latest', sourceLookup: options.sourceLookup, maxTargets: 1 });
      target.plannedImplementation = next;
      target.plannedImplementationCode = planned;
    }
  }
  if (options.enrichTokens) await enrichTokenCalls(call, network, { rpcUrl: options.rpcUrl, provider: options.tokenProvider, blockTag: tx.isExecuted && Number.isInteger(tx.blockNumber) && tx.blockNumber > 0 ? tx.blockNumber - 1 : 'latest' });
  const approvals = await inspectApprovedHashes(call, tx, network, options);
  for (const approval of approvals) {
    checks.push({ name: `Approved Safe hash ${approval.approvedHash}`, method: 'nested_approval', status: approval.status === 'mismatch' ? 'fail' : ['rpc_matched', 'matched_fields'].includes(approval.status) ? 'pass' : 'unavailable', detail: approval.reason ?? (approval.status === 'rpc_matched' ? 'Approved hash matches recovered transaction fields and the target contract getTransactionHash response through RPC. This does not certify the target code.' : approval.status === 'matched_fields' ? 'Approved hash matches recovered transaction fields locally; target contract hash was not confirmed through RPC.' : 'The approved transaction could not be fully checked.') });
    if (approval.status === 'mismatch') warnings.push(`Approved Safe hash ${approval.approvedHash} does not match the recovered transaction or target Safe contract. Do not sign.`);
  }
  const actions = summarizeCalls(call);
  const findings = classifyIntent(call);
  for (const target of targetChecks) {
    if (target.status === 'mismatch') findings.push({ severity: 'critical', code: 'TARGET_CODE_MISMATCH', path: target.address, message: target.reason });
    // A plain value transfer to an EOA has no runtime code by design.
    if (target.status === 'no_code' && target.selectors.length) findings.push({ severity: 'warning', code: 'TARGET_NO_CODE', path: target.address, message: target.reason });
    // Proxy ABI describes dispatch, not the functions that run through it.
    // A missing selector is meaningful only after checking the implementation.
    const effectiveTarget = target.proxy ? target.proxy.implementationCode : target;
    const missing = ['verified', 'verified_current'].includes(effectiveTarget?.status) ? effectiveTarget.abiSelectors?.filter(selector => !selector.present && !(target.proxy && target.abiSelectors?.some(outer => outer.selector === selector.selector && outer.present))) ?? [] : [];
    const planned = target.plannedImplementationCode;
    const plannedCoversMissing = missing.length && ['verified', 'verified_current'].includes(planned?.status) && missing.every(selector => planned.abiSelectors?.some(item => item.selector === selector.selector && item.present));
    if (plannedCoversMissing) findings.push({ severity: 'info', code: 'UPGRADE_TARGET_ABI_CONDITIONAL', path: target.address, message: `The missing selector exists in the verified proposed implementation ${target.plannedImplementation}. This interpretation depends on the upgrade executing before the call.` });
    else if (missing.length) findings.push({ severity: 'warning', code: 'TARGET_ABI_MISMATCH', path: target.address, message: `The decoded selector is absent from the matching verified ${target.proxy ? 'implementation' : 'target'} ABI; the function label may be wrong.` });
  }
  if (options.verifyTargets && targetChecks.some(target => !['verified', 'verified_current'].includes(target.status) || (target.proxy && !['verified', 'verified_current'].includes(target.proxy.implementationCode?.status)))) warnings.push('At least one called target or proxy implementation lacks matching verified runtime bytecode. A decoded selector is only a hypothesis about behavior.');
  if (tx.to.toLowerCase() === tx.safe.toLowerCase() && tx.data === '0x' && tx.value === '0' && tx.operation === 0) {
    findings.push({ severity: 'info', code: 'SAFE_REJECTION', path: '1', message: 'Empty self-call: this consumes the Safe nonce if executed and can cancel a competing proposal at the same nonce.' });
  }
  if (tx.gasToken !== ZERO || tx.refundReceiver !== ZERO || tx.gasPrice !== '0') findings.push({ severity: 'warning', code: 'GAS_REFUND', path: '1', message: 'Custom gas payment fields may transfer value outside the apparent call.' });
  let safeInfo = options.safeInfo ?? null;
  if (!safeInfo && options.fetchState !== false) {
    try { safeInfo = await safeState(tx, network); }
    catch (error) {
      if (options.rpcUrl) {
        try { safeInfo = await rpcSafeState(tx, options.rpcUrl, network); }
        catch (rpcError) { warnings.push(`Safe state unavailable: API ${error.message}; RPC ${rpcError.message}`); }
      } else warnings.push(`Safe state unavailable: ${error.message}`);
    }
  }
  if (safeInfo && !tx.isExecuted && BigInt(tx.nonce) < BigInt(safeInfo.nonce)) findings.push({ severity: 'warning', code: 'STALE_NONCE', path: '1', message: 'Safe nonce has already passed this proposal.' });
  if (tx.isExecuted && safeInfo && (safeInfo.source === 'rpc_current_fallback' || !safeInfo.source)) warnings.push('Signer and threshold context is from the current Safe state; historical owners and threshold were not independently recovered.');
  let simulation = null;
  if (options.simulate) {
    // Never spend simulation quota on fields that already fail hash verification.
    try { simulation = checks.some(check => check.status === 'fail') ? { unavailable: 'Safe hash verification failed; simulation skipped' } : safeInfo ? await simulate(tx, network, safeInfo, options) : { unavailable: 'Current Safe state unavailable' }; }
    catch (error) { simulation = { unavailable: error.message }; }
  }
  if (tx.isExecuted && typeof tx.isSuccessful === 'boolean' && typeof simulation?.success === 'boolean' && tx.isSuccessful !== simulation.success) {
    findings.push({ severity: 'critical', code: 'EXECUTION_MISMATCH', path: '1', message: 'Historical simulation result differs from the Safe Transaction Service execution result. Investigate the block, signatures, and full trace.' });
  }
  const effects = classifyEffects(simulation?.unavailable ? null : simulation, tx.safe);
  const risk = assessRisk({ call, actions, findings, effects, checks, simulation, transaction: tx });
  const confidence = assessConfidence({ call, checks, targetChecks, simulation, transaction: tx });
  const status = checks.some(c => c.status === 'fail') ? 'BLOCK' : findings.some(f => f.severity === 'critical' || f.code === 'SAFE_HASH_APPROVAL') || effects.some(e => e.severity === 'critical') ? 'REVIEW' : 'INSPECT';
  const executionStatus = tx.isExecuted ? tx.isSuccessful === true ? 'executed_success' : tx.isSuccessful === false ? 'executed_failure' : 'executed_outcome_unknown' : 'execution_not_established';
  return { network, chainId: chainId(network), hash: tx.safeTxHash ?? calculatedHash, calculatedHash, hashComponents, status, executionStatus, risk, confidence, checks, approvals, targetChecks, targetVerificationAttempted: options.verifyTargets === true, rpc: options.rpcProvenance ? { kind: options.rpcProvenance.kind, label: options.rpcProvenance.label } : { kind: options.rpcUrl ? 'custom' : 'none', label: options.rpcUrl ? 'Custom RPC configured for this request' : 'No RPC used' }, transaction: tx, safeState: safeInfo ? { nonce: safeInfo.nonce, threshold: safeInfo.threshold, owners: safeInfo.owners, source: safeInfo.source ?? 'safe_api', blockTag: safeInfo.blockTag ?? 'current' } : null, call, actions, findings, simulation, effects, warnings, reviewedAt: new Date().toISOString() };
}

export async function analyzeHash(hash, network, options = {}) {
  const raw = await fetchTransaction(hash, network);
  if (raw.safeTxHash?.toLowerCase() !== hash.toLowerCase()) throw new Error('Safe API returned a different hash');
  if (options.expectedSafe && raw.safe?.toLowerCase() !== options.expectedSafe.toLowerCase()) throw new Error('Safe URL address does not match transaction');
  const report = await analyze(raw, network, options);
  return { ...report, executionStatus: executionStatusWithSource(report, raw.lookupSource), evidence: { source: raw.lookupSource, retrievedAt: new Date().toISOString(), requestedHash: hash } };
}

export function executionStatusWithSource(report, source) {
  if (report.transaction.isExecuted) return report.executionStatus;
  if (source === 'safe_api_untrusted') return 'unsigned_reported';
  if (source === 'safe_api' || source === 'safe_gateway') return 'pending_reported';
  return report.executionStatus;
}
