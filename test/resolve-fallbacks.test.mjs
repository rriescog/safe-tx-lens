import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from '../src/resolve.mjs';
import { calculateHash, normalizeTransaction } from '../src/analyze.mjs';
import { Interface, id } from 'ethers';

const tx = JSON.parse(await readFile('examples/safe-pending.json', 'utf8'));
const monitorRecord = (prefix = 'eth') => ({
  prefix, safeAddress: tx.safe, txStatus: 'AWAITING_CONFIRMATIONS',
  txData: { to: { value: tx.to }, value: tx.value, hexData: tx.data, operation: tx.operation },
  detailedExecutionInfo: { safeTxHash: tx.safeTxHash, nonce: tx.nonce, confirmations: [] },
});
const monitor = records => ({ PENDING_TXN_DATA: JSON.stringify(records) });
const noEtherscan = () => new Response(JSON.stringify({ status: '0', message: 'No records found', result: [] }), { status: 200 });

async function withSources({ records = {}, safePages = false } = {}, run) {
  const old = { fetch: globalThis.fetch, safe: process.env.SAFE_API_KEY, etherscan: process.env.ETHERSCAN_API_KEY, tenderly: process.env.TENDERLY_ACCESS_KEY, account: process.env.TENDERLY_ACCOUNT, project: process.env.TENDERLY_PROJECT };
  process.env.SAFE_API_KEY = 'resolve-test-key';
  process.env.ETHERSCAN_API_KEY = 'resolve-test-index-key';
  process.env.TENDERLY_ACCESS_KEY = 'resolve-test-monitor-key';
  process.env.TENDERLY_ACCOUNT = 'resolve-test-account';
  process.env.TENDERLY_PROJECT = 'resolve-test-project';
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('api.tenderly.co')) return new Response(JSON.stringify([{ key: 'PENDING_TXN_DATA', value: monitor(records).PENDING_TXN_DATA }]), { status: 200 });
    if (value.includes('api.etherscan.io')) return noEtherscan();
    if (value.includes('api.safe.global')) {
      if (!safePages) return new Response('unavailable', { status: 503 });
      if (value.endsWith(`/safes/${tx.safe}/`)) return new Response(JSON.stringify({ address: tx.safe, nonce: tx.nonce, threshold: 1, owners: [tx.safe] }), { status: 200 });
      if (value.includes(`/safes/${tx.safe}/multisig-transactions/`)) return new Response(JSON.stringify({ count: 1, results: [tx], next: null }), { status: 200 });
      if (value.endsWith(`/multisig-transactions/${tx.safeTxHash}/`)) return new Response(JSON.stringify(tx), { status: 200 });
    }
    return new Response('unavailable', { status: 503 });
  };
  try { return await run(); }
  finally {
    globalThis.fetch = old.fetch;
    for (const [name, previous] of [['SAFE_API_KEY', old.safe], ['ETHERSCAN_API_KEY', old.etherscan], ['TENDERLY_ACCESS_KEY', old.tenderly], ['TENDERLY_ACCOUNT', old.account], ['TENDERLY_PROJECT', old.project]]) {
      if (previous === undefined) delete process.env[name]; else process.env[name] = previous;
    }
  }
}

test('an explicitly enabled monitor can rescue a hash and queue after Safe services fail', async () => withSources({ records: { multisig_first: monitorRecord() } }, async () => {
  const report = await resolve(tx.safeTxHash, 'auto', { rpcUrl: '', verifyTargets: false, fetchState: false, monitorFallback: true });
  assert.equal(report.network, 'eth');
  assert.equal(report.hash, tx.safeTxHash);
  assert.equal(report.evidence.source, 'tenderly_monitor');
  assert.equal(report.evidence.requestedHash, tx.safeTxHash);
  assert.equal(report.status, 'UNVERIFIED');
  assert.match(report.warnings.join(' '), /Do not sign based on this report alone/);
  const queue = await resolve(tx.safe, 'eth', { rpcUrl: '', verifyTargets: false, fetchState: false, monitorFallback: true });
  assert.equal(queue.source, 'tenderly_monitor');
  assert.equal(queue.reports.length, 1);
  assert.equal(queue.reports[0].evidence.source, 'tenderly_monitor');
  assert.match(queue.warnings.join(' '), /snapshot/);
}));

test('ambiguous monitor chains never silently choose a network', async () => withSources({ records: { multisig_a: monitorRecord('eth'), multisig_b: monitorRecord('matic') } }, async () => {
  await assert.rejects(() => resolve(tx.safeTxHash, 'auto', { rpcUrl: '', monitorFallback: true }), /multiple networks/);
}));

test('Safe services take priority over a configured Tenderly snapshot and default never reads it', async () => withSources({ records: { multisig_first: monitorRecord() }, safePages: true }, async () => {
  const original = globalThis.fetch;
  let monitorCalls = 0;
  globalThis.fetch = async (...args) => { if (String(args[0]).includes('api.tenderly.co')) monitorCalls++; return original(...args); };
  try {
    const options = { rpcUrl: '', verifyTargets: false, fetchState: false, monitorFallback: true };
    const report = await resolve(tx.safeTxHash, 'eth', options);
    assert.equal(report.evidence.source, 'safe_api');
    assert.equal(report.executionStatus, 'pending_reported');
    assert.equal(report.checks[0].status, 'pass');
    const queue = await resolve(tx.safe, 'eth', options);
    assert.equal(queue.source, 'safe_api');
    assert.equal(queue.reports[0].executionStatus, 'pending_reported');
    assert.equal(queue.reports[0].checks[0].status, 'pass');
    assert.equal(monitorCalls, 0);
  } finally { globalThis.fetch = original; }
}));

test('ordinary hash inspection never reads Tenderly even when Safe services fail', async () => withSources({ records: { multisig_first: monitorRecord() } }, async () => {
  const original = globalThis.fetch;
  let monitorCalls = 0;
  globalThis.fetch = async (...args) => { if (String(args[0]).includes('api.tenderly.co')) monitorCalls++; return original(...args); };
  try {
    await assert.rejects(() => resolve(tx.safeTxHash, 'eth', { rpcUrl: '', verifyTargets: false }), /Safe API 503/);
    assert.equal(monitorCalls, 0);
  } finally { globalThis.fetch = original; }
}));

test('Safe address can fetch both queue and history with source attribution', async () => withSources({ safePages: true }, async () => {
  const queue = await resolve(tx.safe, 'eth', { scope: 'both', limit: 1, rpcUrl: '', verifyTargets: false, fetchState: false });
  assert.equal(queue.availability, 'available');
  assert.equal(queue.source, 'safe_api');
  assert.equal(queue.reports.length, 2);
  assert.ok(queue.reports.every(report => report.evidence.source === 'safe_api'));
  assert.equal(queue.safeState.threshold, 1);
}));

test('failed queue sources are unavailable, while JSON chain detection stays offline', async () => withSources({}, async () => {
  const queue = await resolve(tx.safe, 'eth', { rpcUrl: '', verifyTargets: false });
  assert.equal(queue.availability, 'unavailable');
  assert.match(queue.warnings.join(' '), /pending unavailable/);
  const builder = { chainId: '1', meta: {}, transactions: [{ to: tx.to, value: '0', data: '0x' }] };
  const plan = await resolve(builder, 'auto', { rpcUrl: '' });
  assert.equal(plan.network, 'eth');
  const otherChain = await resolve({ ...builder, chainId: '130' }, 'auto', { rpcUrl: '' });
  assert.equal(otherChain.network, '130');
  await assert.rejects(() => resolve({ ...builder, chainId: '0' }, 'auto'), /does not reveal its network/);
}));

test('an unindexed offchain hash reports source failure instead of fabricating transaction fields', async () => withSources({}, async () => {
  await assert.rejects(() => resolve(tx.safeTxHash, 'eth', { rpcUrl: '', verifyTargets: false }), /For an offchain proposal without Safe API access/);
}));

test('regular wallets and incompatible contracts are not presented as Safe queues', async () => {
  const original = globalThis.fetch;
  const address = '0x1111111111111111111111111111111111111111';
  try {
    for (const deployed of [false, true]) {
      globalThis.fetch = async (_url, options) => {
        if (!options?.body) return new Response('{}', { status: 404 });
        const request = JSON.parse(options.body);
        const result = request.method === 'eth_chainId' ? '0x1' : request.method === 'eth_getCode' ? deployed ? '0x6000' : '0x' : '0x';
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      };
      const result = await resolve(address, 'eth', { rpcUrl: 'https://rpc.example.test', fetchImpl: globalThis.fetch, verifyTargets: false });
      assert.equal(result.availability, deployed ? 'not_safe' : 'absent');
      assert.match(result.warnings.join(' '), deployed ? /does not appear to be a supported Safe/ : /regular wallet/);
    }
  } finally { globalThis.fetch = original; }
});

test('an unrelated onchain transaction reports that it is not a supported Safe execution', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  const hash = `0x${'ab'.repeat(32)}`;
  try {
    await assert.rejects(() => resolve(hash, 'eth', {
      rpcUrl: 'https://rpc.example.test',
      provider: {
        getNetwork: async () => ({ chainId: 1n }),
        getTransaction: async () => ({ to: tx.safe, data: '0x12345678' }),
        getTransactionReceipt: async () => ({ blockNumber: 1 }),
      },
    }), /does not appear to be a supported Safe execTransaction/);
  } finally { globalThis.fetch = original; }
});

test('an unseen hash can discover its network through the authenticated Safe Transaction Service', async () => withSources({}, async () => {
  const gno = { ...tx, safeTxHash: calculateHash(normalizeTransaction(tx), 'gno') };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/tx-service/gno/') && String(url).includes(gno.safeTxHash)) return new Response(JSON.stringify(gno), { status: 200 });
    return original(url, options);
  };
  try {
    const report = await resolve(gno.safeTxHash, 'auto', { rpcUrl: '', verifyTargets: false, fetchState: false });
    assert.equal(report.network, 'gno');
    assert.equal(report.hash, gno.safeTxHash);
    assert.equal(report.checks[0].status, 'pass');
  } finally { globalThis.fetch = original; }
}));

test('auto-discovered Safe execution uses its RPC receipt, retries a transient failure, and skips Safe API', async () => withSources({}, async () => {
  const executionHash = `0x${'ab'.repeat(32)}`;
  const eventTopic = id('ExecutionSuccess(bytes32,uint256)');
  const fetchImpl = async (url, options) => {
    const method = JSON.parse(options.body).method;
    const ethereum = String(url).includes('eth-mainnet.g.alchemy.com');
    return new Response(JSON.stringify({ result: method === 'eth_chainId' ? '0x1' : ethereum ? { logs: [{ topics: [eventTopic] }] } : null }), { status: 200 });
  };
  const previousFetch = globalThis.fetch;
  let safeCalls = 0;
  globalThis.fetch = async (...args) => { if (String(args[0]).includes('safe.global')) safeCalls++; return previousFetch(...args); };
  let attempts = 0;
  const analyzeExecution = async (hash, network) => {
    attempts++;
    assert.equal(hash, executionHash);
    assert.equal(network, 'eth');
    if (attempts === 1) throw new Error('RPC temporarily unavailable');
    return { hash, network, evidence: { source: 'onchain_execution' } };
  };
  try {
    const report = await resolve(executionHash, 'auto', { fetchImpl, analyzeExecution, verifyTargets: false });
    assert.equal(report.evidence.source, 'onchain_execution');
    assert.equal(attempts, 2);
    assert.equal(safeCalls, 0);
    await assert.rejects(() => resolve(executionHash, 'auto', { fetchImpl, analyzeExecution: async () => { throw new Error('RPC down'); } }), /Onchain execution source unavailable/);
    assert.equal(safeCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
}));

test('auto-discovered execution follows a non-Ethereum network', async () => withSources({}, async () => {
  const executionHash = `0x${'cd'.repeat(32)}`;
  const fetchImpl = async (url, options) => {
    const method = JSON.parse(options.body).method;
    const polygon = String(url).includes('rpc-mainnet.matic.quiknode.pro');
    return new Response(JSON.stringify({ result: method === 'eth_chainId' ? '0x89' : polygon ? { logs: [{ topics: [id('ExecutionSuccess(bytes32,uint256)')] }] } : null }), { status: 200 });
  };
  const report = await resolve(executionHash, 'auto', {
    fetchImpl,
    analyzeExecution: async (hash, network) => {
      assert.equal(hash, executionHash);
      assert.equal(network, 'pol');
      return { hash, network, evidence: { source: 'onchain_execution' } };
    },
  });
  assert.equal(report.network, 'pol');
}));

test('auto discovery declines a hash absent from every supported indexed and proposal source', async () => withSources({}, async () => {
  await assert.rejects(() => resolve(`0x${'fe'.repeat(32)}`, 'auto', { rpcUrl: '' }), /does not reveal its network/);
}));

test('executed history explicitly reports the bounded RPC fallback after API outage', async () => withSources({}, async () => {
  const provider = {
    getNetwork: async () => ({ chainId: 1n }), getBlockNumber: async () => 10000,
    getLogs: async () => [],
  };
  const history = await resolve(tx.safe, 'eth', { scope: 'history', rpcUrl: 'https://unused.invalid', provider, verifyTargets: false, fetchState: false });
  assert.equal(history.source, 'recent_rpc');
  assert.equal(history.truncated, true);
  assert.match(history.warnings.join(' '), /RPC scanned blocks/);
}));

test('a live onchain execution removes a stale proposal from the monitor queue', async () => withSources({ records: { multisig_stale: monitorRecord() } }, async () => {
  const executionHash = `0x${'ab'.repeat(32)}`;
  const iface = new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)']);
  const state = new Interface(['function nonce() view returns (uint256)']);
  const outer = { from: tx.safe, to: tx.safe, data: iface.encodeFunctionData('execTransaction', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, '0x']) };
  const log = { address: tx.safe, topics: [id('ExecutionSuccess(bytes32,uint256)'), tx.safeTxHash], transactionHash: executionHash, data: '0x' };
  const provider = {
    getNetwork: async () => ({ chainId: 1n }), getBlockNumber: async () => 1000,
    getLogs: async () => [log], getTransaction: async () => outer,
    getTransactionReceipt: async () => ({ blockNumber: 999, logs: [log] }),
    call: async () => state.encodeFunctionResult('nonce', [tx.nonce]),
    getBlock: async () => ({ timestamp: 1700000000 }),
  };
  const queue = await resolve(tx.safe, 'eth', { scope: 'pending', rpcUrl: 'https://unused.invalid', provider, verifyTargets: false, fetchState: false, monitorFallback: true });
  assert.equal(queue.source, 'tenderly_monitor');
  assert.equal(queue.reports.length, 0);
  assert.match(queue.warnings.join(' '), /snapshot is stale/);
  const fromMonitorHash = await resolve(tx.safeTxHash, 'eth', { rpcUrl: 'https://unused.invalid', provider, verifyTargets: false, fetchState: false, monitorFallback: true });
  assert.equal(fromMonitorHash.evidence.source, 'onchain_execution');
  assert.equal(fromMonitorHash.evidence.requestedHash, tx.safeTxHash);
  const fromExecutionHash = await resolve(executionHash, 'eth', { rpcUrl: 'https://unused.invalid', provider, verifyTargets: false, fetchState: false });
  assert.equal(fromExecutionHash.hash, tx.safeTxHash);
}));

test('quota errors identify an unavailable offchain hash without guessing its Safe', async () => withSources({}, async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('safe-client.safe.global')
    ? (() => { throw new Error('Safe anonymous monthly quota exhausted'); })()
    : original(url, options);
  try {
    await assert.rejects(() => resolve(tx.safeTxHash, 'eth', { rpcUrl: '', verifyTargets: false, monitorFallback: true }), /Hash not found in the explicitly enabled Tenderly monitor snapshot.*quota is exhausted/);
  } finally { globalThis.fetch = original; }
}));

test('an indexed event cannot override the Safe address in a supplied Safe URL', async () => withSources({}, async () => {
  const hash = `0x${'ee'.repeat(32)}`;
  const safe = '0x3333333333333333333333333333333333333333';
  const expectedSafe = '0x1111111111111111111111111111111111111111';
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('api.etherscan.io')
    ? new Response(JSON.stringify({ status: '1', result: [{ address: safe, transactionHash: `0x${'dd'.repeat(32)}`, blockNumber: '0x10', topics: [id('ExecutionSuccess(bytes32,uint256)'), hash] }] }), { status: 200 })
    : original(url, options);
  try {
    const safeUrl = `https://app.safe.global/transactions/tx?safe=eth:${expectedSafe}&id=multisig_${expectedSafe}_${hash}`;
    await assert.rejects(() => resolve(safeUrl, 'eth', { rpcUrl: '' }), /Indexed Safe address differs/);
  } finally { globalThis.fetch = original; }
}));

test('indexed execution is accepted only after onchain Safe hash reconstruction', async () => withSources({}, async () => {
  const gno = { ...tx, safeTxHash: calculateHash(normalizeTransaction(tx), 'pol') };
  const executionHash = `0x${'cc'.repeat(32)}`;
  const iface = new Interface(['function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) returns (bool)']);
  const state = new Interface(['function nonce() view returns (uint256)']);
  const outer = { from: gno.safe, to: gno.safe, data: iface.encodeFunctionData('execTransaction', [gno.to, gno.value, gno.data, gno.operation, gno.safeTxGas, gno.baseGas, gno.gasPrice, gno.gasToken, gno.refundReceiver, '0x']) };
  const log = { address: gno.safe, topics: [id('ExecutionSuccess(bytes32,uint256)'), gno.safeTxHash], transactionHash: executionHash, data: '0x' };
  const provider = { getNetwork: async () => ({ chainId: 137n }), getTransaction: async () => outer, getTransactionReceipt: async () => ({ blockNumber: 999, logs: [log] }), call: async () => state.encodeFunctionResult('nonce', [gno.nonce]), getBlock: async () => ({ timestamp: 1700000000 }) };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => String(url).includes('api.etherscan.io')
    ? new Response(JSON.stringify({ status: '1', result: [{ address: gno.safe, transactionHash: executionHash, blockNumber: '0x3e7', topics: log.topics }] }), { status: 200 })
    : original(url, options);
  try {
    const report = await resolve(gno.safeTxHash, 'pol', { rpcUrl: 'https://unused.invalid', provider, verifyTargets: false, fetchState: false });
    assert.equal(report.hash, gno.safeTxHash);
    assert.equal(report.evidence.discoveredBy, 'etherscan_index');
    assert.equal(report.evidence.requestedHash, gno.safeTxHash);
    assert.equal(report.checks[0].status, 'pass');
  } finally { globalThis.fetch = original; }
}));
