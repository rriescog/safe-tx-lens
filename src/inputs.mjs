import { getAddress, isAddress } from 'ethers';
import { chainId, internalNetwork } from './chains.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseInput(input, network = 'eth') {
  if (typeof input === 'object' && input !== null) return { kind: 'json', transaction: input, network };
  if (typeof input !== 'string') throw new Error('Input must be a hash, Safe URL, address, or transaction JSON');
  const value = input.trim();
  if (value.startsWith('{')) return { kind: 'json', transaction: JSON.parse(value), network };
  if (HASH.test(value)) return { kind: 'hash', hash: value, network };
  if (isAddress(value)) return { kind: 'safe', address: getAddress(value), network };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url;
    try { url = new URL(value); }
    catch { throw new Error('Invalid Safe URL'); }
    // The supplied URL is parsed, never fetched. Exact origin and credential
    // checks avoid mistaking lookalike or user-info URLs for Safe links.
    if (url.origin !== 'https://app.safe.global' || url.username || url.password) throw new Error('Only https://app.safe.global URLs are accepted');
    if (url.searchParams.getAll('safe').length !== 1 || url.searchParams.getAll('id').length > 1) throw new Error('Safe URL needs exactly one safe= parameter and at most one id= parameter');
    const safe = url.searchParams.get('safe');
    const id = url.searchParams.get('id');
    if (!safe) throw new Error('Safe URL needs a safe= network:address parameter');
    const match = /^([a-z0-9]+):(0x[0-9a-fA-F]{40})$/.exec(safe);
    if (!match || !isAddress(match[2])) throw new Error('Invalid Safe URL address');
    const urlNetwork = internalNetwork(match[1]);
    chainId(urlNetwork);
    if (url.searchParams.has('id')) {
      const transactionId = /^multisig_(0x[0-9a-fA-F]{40})_(0x[0-9a-fA-F]{64})$/.exec(id);
      if (!transactionId || transactionId[1].toLowerCase() !== match[2].toLowerCase()) throw new Error('Invalid Safe URL transaction id');
      return { kind: 'hash', hash: transactionId[2], network: urlNetwork, expectedSafe: getAddress(match[2]) };
    }
    return { kind: 'safe', address: getAddress(match[2]), network: urlNetwork };
  }
  throw new Error('Unrecognized input. Use a Safe hash, Safe address, app.safe.global URL, or JSON.');
}
