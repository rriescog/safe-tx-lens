import { isAddress } from 'ethers';
import { chainId } from './chains.mjs';

const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_JSON_NODES = 10000;
const MAX_JSON_DEPTH = 32;

// Bound the work a syntactically valid JSON document can trigger. An HTTP
// byte limit alone does not stop extremely deep or wide objects, and the
// decoder legitimately traverses supplied Builder and Safe records.
export function validateTransactionJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Transaction JSON must be one JSON object');
  const pending = [[value, 0]];
  const seen = new WeakSet();
  let nodes = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('Transaction JSON is too complex');
    if (typeof item === 'string' && item.length > 2000000) throw new Error('Transaction JSON field is too large');
    if (!item || typeof item !== 'object') continue;
    if (seen.has(item)) throw new Error('Transaction JSON contains a repeated object');
    seen.add(item);
    for (const [key, child] of Object.entries(item)) {
      if (key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Transaction JSON contains an unsupported field');
      pending.push([child, depth + 1]);
    }
  }
  return value;
}

// All network-facing entry points treat text, JSON metadata, ABI names and
// contract source as untrusted data. No user text is ever sent to an LLM.
// Structural checks prevent oversized work and source substitution; escaping
// at render time prevents these values from becoming browser instructions.
export function validateInspectionRequest(payload) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('Expected one inspection request object');
  const allowed = new Set(['input', 'network', 'scope', 'simulate', 'verifyTargets', 'decodeCandidates', 'safeAddress', 'safeHash']);
  for (const key of Object.keys(payload)) if (!allowed.has(key)) throw new Error(`Unsupported request field: ${key}`);
  const network = payload.network ?? 'eth';
  if (network !== 'auto') chainId(network);
  if (!['pending', 'history', 'both'].includes(payload.scope ?? 'pending')) throw new Error('Invalid transaction scope');
  for (const key of ['simulate', 'verifyTargets', 'decodeCandidates']) if (payload[key] !== undefined && typeof payload[key] !== 'boolean') throw new Error(`Invalid ${key}`);
  if (payload.safeAddress !== undefined && (!isAddress(payload.safeAddress) || payload.safeAddress.length !== 42)) throw new Error('Invalid Safe address');
  if (payload.safeHash !== undefined && (typeof payload.safeHash !== 'string' || !HASH.test(payload.safeHash))) throw new Error('Invalid Safe hash');
  const input = payload.input;
  if (typeof input === 'string' && (input.length < 1 || input.length > 2000000)) throw new Error('Invalid input length');
  if (typeof input !== 'string' && (!input || Array.isArray(input) || typeof input !== 'object')) throw new Error('Input must be a hash, address, URL, or transaction JSON');
  if (typeof input === 'object') validateTransactionJson(input);
  else if (input.trimStart().startsWith('{')) {
    try { validateTransactionJson(JSON.parse(input)); }
    catch (error) { if (error instanceof SyntaxError) throw new Error('Invalid transaction JSON'); throw error; }
  }
  return payload;
}
