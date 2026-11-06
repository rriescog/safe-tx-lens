import { getAddress, isAddress } from 'ethers';
import { chainId } from './chains.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseInput(input, network = 'eth') {
  if (typeof input === 'object' && input !== null) return { kind: 'json', transaction: input, network };
  if (typeof input !== 'string') throw new Error('Input must be a hash, Safe URL, address, or transaction JSON');
  const value = input.trim();
  if (value.startsWith('{')) return { kind: 'json', transaction: JSON.parse(value), network };
  if (HASH.test(value)) return { kind: 'hash', hash: value, network };
  if (isAddress(value)) return { kind: 'safe', address: getAddress(value), network };
  try {
    const url = new URL(value);
    if (url.hostname !== 'app.safe.global') throw new Error('Only app.safe.global URLs are accepted');
    const safe = url.searchParams.get('safe');
    const id = url.searchParams.get('id');
    if (!safe) throw new Error('Safe URL needs a safe= network:address parameter');
    const match = /^([a-z0-9]+):(0x[0-9a-fA-F]{40})$/.exec(safe);
    if (!match || !isAddress(match[2])) throw new Error('Invalid Safe URL address');
    chainId(match[1]);
    if (id) {
      const hash = id.match(/0x[0-9a-fA-F]{64}/)?.[0];
      if (hash) return { kind: 'hash', hash, network: match[1], expectedSafe: getAddress(match[2]) };
    }
    return { kind: 'safe', address: getAddress(match[2]), network: match[1] };
  } catch (error) {
    if (error.message?.startsWith('Only ') || error.message?.startsWith('Safe URL') || error.message?.startsWith('Invalid ')) throw error;
  }
  throw new Error('Unrecognized input. Use a Safe hash, Safe address, app.safe.global URL, or JSON.');
}
