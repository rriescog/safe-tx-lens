import { Interface, getAddress, id } from 'ethers';

const IFACE = new Interface([
  'function transfer(address to,uint256 amount)',
  'function transferFrom(address from,address to,uint256 amount)',
  'function approve(address spender,uint256 amount)',
  'function setApprovalForAll(address operator,bool approved)',
  'function increaseAllowance(address spender,uint256 amount)',
  'function decreaseAllowance(address spender,uint256 amount)',
  'function addOwnerWithThreshold(address owner,uint256 threshold)',
  'function removeOwner(address prevOwner,address owner,uint256 threshold)',
  'function swapOwner(address prevOwner,address oldOwner,address newOwner)',
  'function changeThreshold(uint256 threshold)',
  'function enableModule(address module)',
  'function disableModule(address prevModule,address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
  'function upgradeTo(address implementation)',
  'function upgradeToAndCall(address implementation,bytes data)',
  'function upgradeAndCall(address proxy,address implementation,bytes data)',
  'function updateImplementation(address newImplementation)',
  'function changeAdmin(address newAdmin)',
  'function schedule(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt,uint256 delay)',
  'function execute(address target,uint256 value,bytes data,bytes32 predecessor,bytes32 salt)',
  'function scheduleBatch(address[] targets,uint256[] values,bytes[] datas,bytes32 predecessor,bytes32 salt,uint256 delay)',
  'function executeBatch(address[] targets,uint256[] values,bytes[] datas,bytes32 predecessor,bytes32 salt)',
  'function update(address target,bytes data)',
  'function forceUnstake(uint256 validatorId)',
  'function forceUnstakePOL(uint256 validatorId)',
  'function reinitializeValidatorState(uint256 expectedIncrease)',
  'function cleanMapToken(address rootToken,address childToken)',
  'function multiSend(bytes transactions)',
]);

// Bound recursive decoding so hostile or malformed nested calldata cannot
// consume unbounded CPU or produce an unusably large review graph.
const MAX_DEPTH = 8;
const MAX_NODES = 256;

function clean(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(clean);
  return value;
}

export function unpackMultiSend(packed) {
  // Safe MultiSend records are tightly packed, not ABI-encoded tuples.
  // Each record is operation(1) + target(20) + value(32) + length(32) + data.
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(packed)) throw new Error('Invalid MultiSend hex bytes');
  const bytes = Buffer.from(packed.slice(2), 'hex');
  const result = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 85) throw new Error('Truncated MultiSend record');
    const operation = bytes[offset++];
    if (operation !== 0 && operation !== 1) throw new Error('Invalid MultiSend operation');
    const to = getAddress(`0x${bytes.subarray(offset, offset + 20).toString('hex')}`); offset += 20;
    const value = BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`).toString(); offset += 32;
    const length = BigInt(`0x${bytes.subarray(offset, offset + 32).toString('hex')}`); offset += 32;
    if (length > BigInt(bytes.length - offset) || length > 1000000n) throw new Error('Invalid MultiSend data length');
    const data = `0x${bytes.subarray(offset, offset + Number(length)).toString('hex')}`; offset += Number(length);
    result.push({ operation, to, value, data });
    if (result.length > 100) throw new Error('MultiSend has over 100 calls');
  }
  return result;
}

export function decodeCall(tx, depth = 0, budget = { count: 0 }) {
  budget.count++;
  const result = { to: tx.to, value: String(tx.value ?? '0'), operation: Number(tx.operation ?? 0), selector: tx.data?.slice(0, 10) ?? '0x', data: tx.data ?? '0x', method: null, args: null, children: [], stage: tx.stage ?? 'call', via: tx.via ?? null };
  if (budget.count > MAX_NODES || depth > MAX_DEPTH) {
    result.decodeError = 'Nested decode limit reached';
    return result;
  }
  if (result.data === '0x') return result;
  try {
    const parsed = IFACE.parseTransaction({ data: result.data, value: result.value });
    if (parsed) {
      result.method = parsed.signature;
      result.decodeBasis = 'known_signature';
      result.args = parsed.fragment.inputs.map((input, index) => ({ name: input.name, value: clean(parsed.args[index]) }));
      if (parsed.name === 'multiSend') {
        result.children = unpackMultiSend(parsed.args[0]).map(child => decodeCall({ ...child, stage: result.stage, via: 'batch call' }, depth + 1, budget));
      } else if (['scheduleBatch', 'executeBatch'].includes(parsed.name)) {
        const [targets, values, datas] = parsed.args;
        if (targets.length !== values.length || targets.length !== datas.length || targets.length > 100) throw new Error('Invalid timelock batch lengths');
        result.children = targets.map((to, index) => decodeCall({ to, value: String(values[index]), data: datas[index], operation: 0, stage: parsed.name === 'scheduleBatch' ? 'schedule' : result.stage, via: parsed.name }, depth + 1, budget));
      } else if (['schedule', 'execute', 'update', 'upgradeToAndCall', 'upgradeAndCall'].includes(parsed.name)) {
        const isUpgrade = ['upgradeToAndCall', 'upgradeAndCall'].includes(parsed.name);
        // upgradeToAndCall is called on the proxy; ProxyAdmin.upgradeAndCall
        // receives the proxy as its first argument. Initializer calldata runs
        // in the proxy's storage context, never at the new implementation.
        const target = parsed.name === 'upgradeToAndCall' ? result.to : parsed.args[0];
        const value = ['schedule', 'execute'].includes(parsed.name) ? parsed.args[1] : 0n;
        const data = parsed.name === 'upgradeAndCall' ? parsed.args[2] : ['upgradeToAndCall', 'update'].includes(parsed.name) ? parsed.args[1] : parsed.args[2];
        if (typeof data === 'string' && data !== '0x') {
          const stage = parsed.name === 'schedule' ? 'schedule' : result.stage;
          result.children = [decodeCall({ to: target, value: String(value), data, operation: 0, stage, via: isUpgrade ? `${parsed.name} (proxy context)` : parsed.name }, depth + 1, budget)];
        }
      }
    }
  } catch (error) { result.decodeError = error.message; }
  return result;
}

export function enrichVerifiedCalls(root, targetChecks) {
  const byAddress = new Map(targetChecks.map(check => [check.address.toLowerCase(), check]));
  const visit = node => {
    if (node.data !== '0x') {
      const target = byAddress.get(node.to.toLowerCase());
      const source = target?.proxy?.implementationCode ?? target;
      if (source && ['verified', 'verified_current'].includes(source.status)) {
        const functionInfo = source.verifiedFunctions?.find(item => item.selector === node.selector.toLowerCase());
        if (functionInfo) {
          try {
            const iface = new Interface([typeof functionInfo.abi === 'string' && functionInfo.abi.startsWith('{') ? JSON.parse(functionInfo.abi) : functionInfo.abi]);
            const parsed = iface.parseTransaction({ data: node.data, value: node.value });
            if (parsed) {
              if (node.method && node.method !== parsed.signature && node.children.length) {
                node.children = [];
                node.decodeError = 'Verified ABI differs from the built-in nested decoder; its old child calls were discarded.';
              }
              node.method = parsed.signature;
              node.args = parsed.fragment.inputs.map((input, index) => ({ name: input.name || `arg${index}`, value: clean(parsed.args[index]) }));
              node.decodeBasis = 'verified_abi';
              node.decodeSource = source.status === 'verified_current' ? 'verified current bytecode (historical code unavailable)' : 'verified bytecode at inspected block';
              node.decodeSourceUrl = source.source;
            }
          } catch (error) { node.decodeError = `Verified ABI could not decode calldata: ${error.message}`; }
        }
      }
    }
    node.children.forEach(visit);
  };
  visit(root);
  return root;
}

const candidateCache = new Map();

// A 4byte database supplies signatures for a selector, not proof that the
// called contract implements one of them. Never call this a verified ABI.
export async function lookupSelectorCandidates(selector) {
  const key = selector.toLowerCase();
  const cached = candidateCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.names;
  const response = await fetch(`https://api.4byte.sourcify.dev/signature-database/v1/lookup?function=${key}`, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`Signature database ${response.status}`);
  const raw = await response.text();
  if (raw.length > 65536) throw new Error('Signature lookup response exceeded review limit');
  const body = JSON.parse(raw);
  const names = Array.isArray(body?.result?.function?.[key]) ? body.result.function[key].filter(item => !item.filtered && typeof item.name === 'string').slice(0, 12).map(item => item.name) : [];
  if (candidateCache.size >= 256) candidateCache.delete(candidateCache.keys().next().value);
  candidateCache.set(key, { names, expires: Date.now() + 15 * 60_000 });
  return names;
}

export async function enrichCandidateCalls(root, { lookup = lookupSelectorCandidates, maxLookups = 8 } = {}) {
  const pending = [];
  const visit = node => {
    if (!node.method && /^0x[0-9a-fA-F]{8}$/.test(node.selector)) pending.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  const selectors = [...new Set(pending.map(node => node.selector.toLowerCase()))].slice(0, maxLookups);
  const results = new Map();
  for (const selector of selectors) {
    try { results.set(selector, await lookup(selector)); }
    catch { results.set(selector, []); }
  }
  for (const node of pending) {
    const signatures = results.get(node.selector.toLowerCase()) ?? [];
    const matches = new Map();
    for (const signature of signatures.slice(0, 12)) {
      if (typeof signature !== 'string' || signature.length > 256) continue;
      try {
        if (id(signature).slice(0, 10).toLowerCase() !== node.selector.toLowerCase()) continue;
        const iface = new Interface([`function ${signature}`]);
        const parsed = iface.parseTransaction({ data: node.data, value: node.value });
        if (!parsed || iface.encodeFunctionData(parsed.fragment, parsed.args).toLowerCase() !== node.data.toLowerCase()) continue;
        matches.set(parsed.signature, parsed);
      } catch { /* An invalid or incompatible candidate is not evidence. */ }
    }
    if (matches.size === 1) {
      const parsed = matches.values().next().value;
      node.method = parsed.signature;
      node.args = parsed.fragment.inputs.map((input, index) => ({ name: input.name || `arg${index}`, value: clean(parsed.args[index]) }));
      node.decodeBasis = 'selector_candidate';
    } else if (matches.size > 1) node.decodeCandidates = [...matches.keys()].slice(0, 5);
  }
  return root;
}

export function summarizeCalls(root) {
  const actions = [];
  const visit = (node, path) => {
    const method = node.method?.split('(')[0] ?? null;
    const argument = name => node.args?.find(item => item.name === name)?.value;
    let label;
    if (method === 'upgradeAndCall') label = `Upgrade proxy ${argument('proxy')} to implementation ${argument('implementation')}${node.children.length ? ' and call initializer' : ''}`;
    else if (method === 'upgradeToAndCall') label = `Upgrade proxy ${node.to} to implementation ${argument('implementation')}${node.children.length ? ' and call initializer' : ''}`;
    else if (method === 'updateImplementation') label = `Update proxy implementation to ${argument('newImplementation')}`;
    else if (method === 'forceUnstake') label = `Force unstake validator #${argument('validatorId')}`;
    else if (method === 'forceUnstakePOL') label = `Force unstake POL validator #${argument('validatorId')}`;
    else if (method === 'reinitializeValidatorState') label = `Reinitialize validator state; expected increase ${argument('expectedIncrease')}`;
    else if (method === 'cleanMapToken') label = `Clean token mapping: root ${argument('rootToken')}, child ${argument('childToken')}`;
    else if (node.token && method === 'transfer') label = `Transfer ${node.token.amount ?? argument('amount')} ${node.token.symbol} to ${argument('to')}`;
    else if (node.token && method === 'transferFrom') label = `Transfer ${node.token.amount ?? argument('amount')} ${node.token.symbol} from ${argument('from')} to ${argument('to')}`;
    else if (node.token && method === 'approve') label = `Approve ${node.token.amount ?? argument('amount')} ${node.token.symbol} for ${argument('spender')}`;
    else if (method) label = `${method}(${(node.args ?? []).filter(arg => typeof arg.value !== 'string' || !arg.value.startsWith('0x') || arg.value.length <= 42).map(arg => String(arg.value)).join(', ')})`;
    else if (node.data === '0x') label = node.value === '0' ? 'Empty call / Safe nonce consumption' : `Native value transfer: ${node.value} wei`;
    else label = `Unknown call ${node.selector}`;
    if (!node.children.length || ['upgradeAndCall', 'upgradeToAndCall'].includes(method)) actions.push({ path, stage: node.stage, to: node.to, label, method: node.method, selector: node.selector, decodeBasis: node.decodeBasis ?? null });
    node.children.forEach((child, index) => visit(child, `${path}.${index + 1}`));
  };
  visit(root, '1');
  return actions;
}
