import { getAddress, isAddress } from 'ethers';
import { CHAINS } from './chains.mjs';

// Donation destinations are explicit deployment configuration. Never derive
// them from a transaction, a connected wallet, or third-party metadata.
export function publicSupportConfig(raw = process.env.PUBLIC_DONATION_WALLETS ?? '[]') {
  const entries = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > 20) throw new Error('Invalid donation wallet configuration');
  const wallets = entries.map(entry => {
    if (!entry || typeof entry !== 'object' || !Object.hasOwn(CHAINS, entry.network) || !isAddress(entry.address)) throw new Error('Invalid donation wallet configuration');
    return { network: entry.network, address: getAddress(entry.address) };
  });
  return { wallets };
}
