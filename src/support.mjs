import { getAddress, isAddress } from 'ethers';
import { CHAINS } from './chains.mjs';

// Donation destinations are explicit deployment configuration. Never derive
// them from a transaction, a connected wallet, or third-party metadata.
const OWNER_EVM_ADDRESS = '0x36560ad123164440a5187243783614237d783e98';
const OWNER_EVM_NETWORKS = ['eth', 'pol', 'gno', 'arb1', 'oeth', 'base', 'zkevm', 'bnb', 'avax'];
const DEFAULT_WALLETS = JSON.stringify(OWNER_EVM_NETWORKS.map(network => ({ network, address: OWNER_EVM_ADDRESS })));

export function publicSupportConfig(raw = process.env.PUBLIC_DONATION_WALLETS ?? DEFAULT_WALLETS) {
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid donation wallet configuration');
  const wallets = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(CHAINS, entry.network) || !isAddress(entry.address)) throw new Error('Invalid donation wallet configuration');
    return { network: entry.network, address: getAddress(entry.address) };
  });
  return { wallets };
}
