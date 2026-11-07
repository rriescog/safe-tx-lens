#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { resolve } from '../src/resolve.mjs';
import { analyzeExecutionHash } from '../src/onchain.mjs';

const NETWORK = z.union([z.enum(['eth', 'gno', 'pol', 'arb1', 'oeth', 'base', 'sep', 'kat', 'xlayer', 'bnb', 'avax']), z.string().regex(/^[1-9][0-9]{0,15}$/)]).default('eth');
const COMMON = { network: NETWORK, rpcUrl: z.string().url().optional().describe('Optional EVM RPC URL. Ethereum uses a public RPC by default.'), simulate: z.boolean().default(false).describe('Explicitly run a Tenderly simulation when credentials and compatible signatures are available.') };
const COMMON_AUTO = { ...COMMON, network: z.union([z.enum(['auto', 'eth', 'gno', 'pol', 'arb1', 'oeth', 'base', 'sep', 'kat', 'xlayer', 'bnb', 'avax']), z.string().regex(/^[1-9][0-9]{0,15}$/)]).default('auto') };

function output(work) {
  return async args => {
    try {
      const result = await work(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  };
}

serveStdio(() => {
  const server = new McpServer({ name: 'safe-tx-lens', version: '0.2.0' });
  const annotations = { readOnlyHint: true, destructiveHint: false };

  server.registerTool('inspect', {
    title: 'Inspect Safe transaction or Safe address',
    description: 'Inspect a Safe transaction hash, onchain execution transaction hash, Safe URL, or Safe address. Auto-detects supported networks from available sources; a Safe URL specifies its network. Pending offchain hashes require a proposal source.',
    inputSchema: z.object({ input: z.string().min(1), ...COMMON_AUTO }), annotations,
  }, output(({ input, network, rpcUrl, simulate }) => resolve(input, network, { rpcUrl, simulate })));

  server.registerTool('inspect_json', {
    title: 'Inspect exported Safe transaction JSON',
    description: 'Analyze a Safe transaction object or a Safe Transaction Builder export supplied by the caller. Builder JSON is decoded as a plan without claiming an unverifiable Safe hash.',
    inputSchema: z.object({ transaction: z.record(z.string(), z.unknown()), safeAddress: z.string().optional(), safeHash: z.string().optional(), ...COMMON }), annotations,
  }, output(({ transaction, safeAddress, safeHash, network, rpcUrl, simulate }) => resolve(transaction, network, { rpcUrl, simulate, safeAddress, safeHash, fetchState: Boolean(rpcUrl || simulate) })));

  server.registerTool('inspect_execution', {
    title: 'Inspect executed Safe transaction by onchain hash',
    description: 'Reconstruct and verify a Safe execTransaction from its onchain Ethereum transaction hash and receipt; no Safe API key required.',
    inputSchema: z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), ...COMMON }), annotations,
  }, output(({ hash, network, rpcUrl, simulate }) => analyzeExecutionHash(hash, network, { rpcUrl, simulate })));

  server.registerTool('list_pending', {
    title: 'List pending Safe proposals',
    description: 'Inspect pending offchain transactions for a Safe address from available proposal sources. Auto-detects supported networks when possible.',
    inputSchema: z.object({ safe: z.string().min(1), ...COMMON_AUTO }), annotations,
  }, output(({ safe, network, rpcUrl, simulate }) => resolve(safe, network, { rpcUrl, simulate, limit: 20 })));

  server.registerTool('list_history', {
    title: 'List executed Safe transactions',
    description: 'Inspect the latest 20 executed multisig transactions for a Safe address. Ethereum can fall back to recent RPC logs. Auto-detects supported networks when possible.',
    inputSchema: z.object({ safe: z.string().min(1), ...COMMON_AUTO }), annotations,
  }, output(({ safe, network, rpcUrl, simulate }) => resolve(safe, network, { rpcUrl, simulate, scope: 'history', limit: 20 })));

  return server;
});
