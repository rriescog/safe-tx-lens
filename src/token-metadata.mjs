import { Interface, JsonRpcProvider, formatUnits, getAddress } from 'ethers';
import { chainId } from './chains.mjs';

const ERC20 = new Interface(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const TOKEN_METHODS = new Set(['transfer', 'transferFrom', 'approve', 'increaseAllowance', 'decreaseAllowance']);

// Symbols and decimals are contract responses, not an authenticated token
// registry. Bound lookups and validate every response before displaying it.
export async function enrichTokenCalls(root, network, { rpcUrl, provider, blockTag = 'latest' } = {}) {
  if (!rpcUrl && !provider) return root;
  const nodes = [];
  const walk = node => { if (TOKEN_METHODS.has(node.method?.split('(')[0])) nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(root);
  if (!nodes.length) return root;
  const rpc = provider ?? new JsonRpcProvider(rpcUrl);
  try { if (Number((await rpc.getNetwork()).chainId) !== chainId(network)) return root; }
  catch { return root; }
  const cache = new Map();
  for (const node of nodes) {
    const address = getAddress(node.to);
    if (!cache.has(address.toLowerCase())) {
      if (cache.size >= 6) break;
      try {
        const [symbolRaw, decimalsRaw] = await Promise.all([
          rpc.call({ to: address, data: ERC20.encodeFunctionData('symbol', []), blockTag }),
          rpc.call({ to: address, data: ERC20.encodeFunctionData('decimals', []), blockTag }),
        ]);
        const symbol = ERC20.decodeFunctionResult('symbol', symbolRaw)[0];
        const decimals = Number(ERC20.decodeFunctionResult('decimals', decimalsRaw)[0]);
        if (!/^[A-Za-z0-9.$_+-]{1,16}$/.test(symbol) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error('Invalid token metadata');
        cache.set(address.toLowerCase(), { symbol, decimals, address, blockTag, source: 'contract call via RPC; unverified token identity' });
      } catch { cache.set(address.toLowerCase(), null); }
    }
    const token = cache.get(address.toLowerCase());
    if (!token) continue;
    // ERC-20 ABI parameter names are optional. The integer is the second
    // argument of transfer/approve and the third of transferFrom.
    const method = node.method?.split('(')[0];
    const amountIndex = method === 'transferFrom' ? 2 : 1;
    const amount = node.args?.[amountIndex]?.value;
    node.token = { ...token, amount: typeof amount === 'string' && /^\d+$/.test(amount) ? formatUnits(amount, token.decimals) : null };
  }
  return root;
}
