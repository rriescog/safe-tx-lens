export const CHAINS = Object.freeze({
  eth: 1, gno: 100, pol: 137, arb1: 42161, oeth: 10, base: 8453,
  sep: 11155111, bnb: 56, avax: 43114,
  kat: 747474, xlayer: 196,
});

// Product-facing names and Safe Transaction Service URL aliases differ for
// some Agglayer networks. Keep chain IDs as the source of EIP-712 truth.
export const SAFE_SERVICE_ALIAS = Object.freeze({ kat: 'katana', xlayer: 'okb' });
export function safeServiceAlias(network) { return SAFE_SERVICE_ALIAS[network] ?? network; }
export function internalNetwork(alias) { return Object.keys(SAFE_SERVICE_ALIAS).find(network => SAFE_SERVICE_ALIAS[network] === alias) ?? alias; }

export function chainId(prefix) {
  if (typeof prefix === 'string' && /^[1-9][0-9]{0,15}$/.test(prefix) && Number.isSafeInteger(Number(prefix))) return Number(prefix);
  if (!Object.hasOwn(CHAINS, prefix)) throw new Error(`Unsupported Safe network: ${prefix}`);
  return CHAINS[prefix];
}
