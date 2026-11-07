import { chainId } from './chains.mjs';
import { localCredentials } from './tenderly-storage.mjs';
import { getAddress } from 'ethers';
import { createHash } from 'node:crypto';

const GATEWAY = 'https://safe-client.safe.global';
const unsignedInteger = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && /^\d+$/.test(value);

async function gatewayGet(network, path) {
  // Reject dot segments and encoded separators before URL normalization can
  // turn a transaction lookup into a request for another API resource.
  if (!/^\/[a-zA-Z0-9/_?=&.-]+$/.test(path) || path.includes('..')) throw new Error('Invalid Safe Gateway path');
  const response = await fetch(`${GATEWAY}/v1/chains/${chainId(network)}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Safe Client Gateway ${response.status}`);
  return response.json();
}

export function gatewayTransaction(raw) {
  const data = raw?.txData;
  const info = raw?.detailedExecutionInfo;
  const to = data?.to?.value;
  const safe = raw?.safeAddress;
  const safeTxHash = info?.safeTxHash;
  if (!safe || !to || !safeTxHash || !info || data?.value == null || data?.operation == null || info.nonce == null || info.safeTxGas == null || info.baseGas == null || info.gasPrice == null || !info.gasToken || !info.refundReceiver?.value) throw new Error('Safe Gateway transaction lacks fields needed for independent hash verification');
  return {
    safe, to, safeTxHash, value: String(data.value), data: data.hexData ?? '0x', operation: Number(data.operation), nonce: String(info.nonce),
    safeTxGas: String(info.safeTxGas), baseGas: String(info.baseGas), gasPrice: String(info.gasPrice), gasToken: info.gasToken, refundReceiver: info.refundReceiver.value,
    isExecuted: raw.executedAt != null || ['SUCCESS', 'FAILED'].includes(raw.txStatus), isSuccessful: raw.txStatus === 'SUCCESS' ? true : raw.txStatus === 'FAILED' ? false : null,
    transactionHash: raw.txHash ?? null, executor: raw.executor?.value ?? info.executor?.value ?? null, confirmationsRequired: info.confirmationsRequired ?? null,
    confirmations: (info.confirmations ?? []).map(c => ({ owner: c.signer?.value, signature: c.signature ?? null })),
  };
}

async function gatewaySafe(address, network) {
  const raw = await gatewayGet(network, `/safes/${address}`);
  if (!raw || !unsignedInteger(raw.nonce) || !unsignedInteger(raw.threshold) || !Array.isArray(raw.owners)) throw new Error('Safe Client Gateway returned an incomplete Safe state');
  return { nonce: raw.nonce, threshold: raw.threshold, owners: (raw.owners ?? []).map(owner => owner.value), source: 'safe_gateway' };
}

async function gatewayTransactionByHash(hash, network) {
  return gatewayTransaction(await gatewayGet(network, `/transactions/${hash}`));
}

let anonymousQuotaUntil = 0;
const authenticatedCooldown = new Map();

export async function safeGet(network, path, apiKey) {
  apiKey ??= (await localCredentials()).SAFE_API_KEY;
  chainId(network);
  if (/^[0-9]+$/.test(network)) throw new Error('No Transaction Service alias configured for this chain ID; trying Safe Client Gateway');
  if (!/^\/[a-zA-Z0-9/_?=&.-]+$/.test(path) || path.includes('..')) throw new Error('Invalid Safe API path');
  if (!apiKey && Date.now() < anonymousQuotaUntil) throw new Error('Safe anonymous monthly quota exhausted. Import transaction JSON for offchain proposals or use an onchain execution hash.');
  const keyId = apiKey ? createHash('sha256').update(apiKey).digest('hex') : null;
  if (keyId && Date.now() < (authenticatedCooldown.get(keyId) ?? 0)) throw new Error('Safe API rate limit or quota is cooling down; retry after the limit resets');
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`https://api.safe.global/tx-service/${network}/api/v1${path}`, { headers, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    if (response.status === 429) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      const reset = Number(response.headers.get(remaining === '0' ? 'x-ratelimit-reset' : 'retry-after'));
      const seconds = Number.isFinite(reset) && reset > 0 ? Math.min(reset, 2592000) : remaining === '0' ? 3600 : 5;
      if (keyId) {
        authenticatedCooldown.set(keyId, Date.now() + seconds * 1000);
        throw new Error(`Safe API 429: authenticated quota or rate limit reached; retry after ${seconds} seconds`);
      }
      if (remaining === '0') {
        anonymousQuotaUntil = Date.now() + seconds * 1000;
        throw new Error('Safe API 429: anonymous monthly quota exhausted. Import transaction JSON for offchain proposals or use an onchain execution hash.');
      }
      throw new Error(`Safe API 429: anonymous rate limit reached; retry after ${seconds} seconds`);
    }
    throw new Error(`Safe API ${response.status}: ${[401, 403].includes(response.status) ? apiKey ? 'authenticated access rejected' : 'API key required or access denied' : 'request failed'}`);
  }
  return response.json();
}

export async function fetchTransaction(hash, network) {
  const sources = (await localCredentials()).SAFE_API_KEY
    ? [['safe_api', () => safeGet(network, `/multisig-transactions/${hash}/`)], ['safe_gateway', () => gatewayTransactionByHash(hash, network)]]
    : [['safe_gateway', () => gatewayTransactionByHash(hash, network)], ['safe_api', () => safeGet(network, `/multisig-transactions/${hash}/`)]];
  const errors = [];
  for (const [name, source] of sources) {
    try { return { ...await source(), lookupSource: name }; } catch (error) { errors.push(error.message); }
  }
  throw new Error(errors.join('; '));
}

export async function fetchSafeTransactions(address, network, scope = 'pending', limit = 100) {
  if (!['pending', 'history'].includes(scope)) throw new Error('Invalid transaction scope');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid transaction limit');
  // The Transaction Service rejects lowercase EVM addresses with HTTP 422.
  // Inventories commonly store lowercase addresses, so normalize at the API boundary.
  address = getAddress(address);
  const service = async () => {
    const safe = await safeGet(network, `/safes/${address}/`);
    const page = await safeGet(network, `/safes/${address}/multisig-transactions/?executed=${scope === 'history'}&limit=${limit}&ordering=-nonce`);
    if (!safe || !unsignedInteger(safe.nonce) || !unsignedInteger(safe.threshold) || !Array.isArray(safe.owners)) throw new Error('Safe API returned an incomplete Safe state');
    if (!page || !Array.isArray(page.results) || !Number.isInteger(page.count)) throw new Error('Safe API returned an invalid transaction list');
    return { safe, transactions: page.results, truncated: Boolean(page.next), source: 'safe_api' };
  };
  const gateway = async () => {
    const [safe, page] = await Promise.all([gatewaySafe(address, network), gatewayGet(network, `/safes/${address}/transactions/${scope === 'history' ? 'history' : 'queued'}?limit=${limit}`)]);
    if (!page || !Array.isArray(page.results)) throw new Error('Safe Client Gateway returned an invalid transaction list');
    if (page.results.some(item => !item || typeof item.transaction?.id !== 'string')) throw new Error('Safe Client Gateway returned a malformed transaction entry');
    const ids = page.results.map(item => item.transaction?.id).filter(id => typeof id === 'string' && id.startsWith('multisig_')).slice(0, limit);
    const transactions = [];
    for (const id of ids) transactions.push(gatewayTransaction(await gatewayGet(network, `/transactions/${id}`)));
    return { safe, transactions, truncated: Boolean(page.next), source: 'safe_gateway' };
  };
  const errors = [];
  for (const source of (await localCredentials()).SAFE_API_KEY ? [service, gateway] : [gateway, service]) {
    try { return await source(); } catch (error) { errors.push(error.message); }
  }
  throw new Error(errors.join('; '));
}

export async function fetchQueue(address, network) {
  return fetchSafeTransactions(address, network, 'pending', 100);
}
