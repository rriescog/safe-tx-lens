import { isAddress } from 'ethers';
import { chainId } from './chains.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;

// All network-facing entry points treat text, JSON metadata, ABI names and
// contract source as untrusted data. No user text is ever sent to an LLM.
// Structural checks prevent oversized work and source substitution; escaping
// at render time prevents these values from becoming browser instructions.
export function validateInspectionRequest(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Expected one inspection request object');
  const network = payload.network ?? 'eth';
  if (network !== 'auto') chainId(network);
  if (!['pending', 'history', 'both'].includes(payload.scope ?? 'pending')) throw new Error('Invalid transaction scope');
  for (const key of ['simulate', 'verifyTargets', 'decodeCandidates']) if (payload[key] !== undefined && typeof payload[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  if (payload.safeAddress !== undefined && (!isAddress(payload.safeAddress) || payload.safeAddress.length !== 42)) throw new Error('Invalid Safe address');
  if (payload.safeHash !== undefined && (typeof payload.safeHash !== 'string' || !HASH.test(payload.safeHash))) throw new Error('Invalid Safe hash');
  const input = payload.input;
  if (typeof input === 'string' && (input.length < 1 || input.length > 2000000)) throw new Error('Invalid input length');
  if (typeof input !== 'string' && (!input || Array.isArray(input) || typeof input !== 'object')) throw new Error('Input must be a hash, address, URL, or transaction JSON');
  return payload;
}
