import { Interface, getAddress } from 'ethers';

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
      result.args = parsed.fragment.inputs.map((input, index) => ({ name: input.name, value: clean(parsed.args[index]) }));
      if (parsed.name === 'multiSend') {
        result.children = unpackMultiSend(parsed.args[0]).map(child => decodeCall({ ...child, stage: result.stage, via: 'batch call' }, depth + 1, budget));
      } else if (['scheduleBatch', 'executeBatch'].includes(parsed.name)) {
        const [targets, values, datas] = parsed.args;
        if (targets.length !== values.length || targets.length !== datas.length || targets.length > 100) throw new Error('Invalid timelock batch lengths');
        result.children = targets.map((to, index) => decodeCall({ to, value: String(values[index]), data: datas[index], operation: 0, stage: parsed.name === 'scheduleBatch' ? 'schedule' : result.stage, via: parsed.name }, depth + 1, budget));
      } else if (['schedule', 'execute', 'update', 'upgradeToAndCall'].includes(parsed.name)) {
        const isUpgrade = parsed.name === 'upgradeToAndCall';
        const target = parsed.args[0];
        const value = ['schedule', 'execute'].includes(parsed.name) ? parsed.args[1] : 0n;
        const data = isUpgrade ? parsed.args[1] : parsed.name === 'update' ? parsed.args[1] : parsed.args[2];
        if (typeof data === 'string' && data !== '0x') {
          const stage = parsed.name === 'schedule' ? 'schedule' : result.stage;
          result.children = [decodeCall({ to: target, value: String(value), data, operation: 0, stage, via: isUpgrade ? 'upgradeToAndCall (proxy context)' : parsed.name }, depth + 1, budget)];
        }
      }
    }
  } catch (error) { result.decodeError = error.message; }
  return result;
}

export function summarizeCalls(root) {
  const actions = [];
  const visit = (node, path) => {
    if (node.children.length) {
      node.children.forEach((child, index) => visit(child, `${path}.${index + 1}`));
      return;
    }
    const method = node.method?.split('(')[0] ?? null;
    const argument = name => node.args?.find(item => item.name === name)?.value;
    let label;
    if (method === 'updateImplementation') label = `Update proxy implementation to ${argument('newImplementation')}`;
    else if (method === 'forceUnstake') label = `Force unstake validator #${argument('validatorId')}`;
    else if (method === 'forceUnstakePOL') label = `Force unstake POL validator #${argument('validatorId')}`;
    else if (method === 'reinitializeValidatorState') label = `Reinitialize validator state; expected increase ${argument('expectedIncrease')}`;
    else if (method === 'cleanMapToken') label = `Clean token mapping: root ${argument('rootToken')}, child ${argument('childToken')}`;
    else if (method) label = `${method}(${(node.args ?? []).filter(arg => typeof arg.value !== 'string' || !arg.value.startsWith('0x') || arg.value.length <= 42).map(arg => String(arg.value)).join(', ')})`;
    else if (node.data === '0x') label = node.value === '0' ? 'Empty call / Safe nonce consumption' : `Native value transfer: ${node.value} wei`;
    else label = `Unknown call ${node.selector}`;
    actions.push({ path, stage: node.stage, to: node.to, label, method: node.method, selector: node.selector });
  };
  visit(root, '1');
  return actions;
}
