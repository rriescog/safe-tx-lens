export const CHAINS = Object.freeze({
  eth: 1, gno: 100, pol: 137, arb1: 42161, oeth: 10, base: 8453,
  sep: 11155111, zkevm: 1101, bnb: 56, avax: 43114,
});

export function chainId(prefix) {
  if (!Object.hasOwn(CHAINS, prefix)) throw new Error(`Unsupported Safe network: ${prefix}`);
  return CHAINS[prefix];
}
