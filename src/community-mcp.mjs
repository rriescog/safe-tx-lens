import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { resolve } from './resolve.mjs';

const network = z.enum(['auto', 'eth', 'gno', 'pol', 'arb1', 'oeth', 'base', 'sep', 'zkevm', 'bnb', 'avax']).default('auto');
const annotations = { readOnlyHint: true, destructiveHint: false };

// The hosted MCP deliberately has no caller-supplied RPC URL, credentials,
// polling, or simulation. It uses the same upstream budget as the web UI.
export function communityMcpHandler() {
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'safe-tx-lens-community', version: '0.2.0' });
    const register = (name, description, schema, run) => server.registerTool(name, {
      title: name.replaceAll('_', ' '), description, inputSchema: z.object(schema), annotations,
    }, async args => {
      try {
        const result = await run(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
      }
    });
    register('inspect', 'Inspect a Safe hash, execution hash, URL, or address on supported networks.', { input: z.string().min(1), network }, ({ input, network }) => resolve(input, network, { limit: 5, verifyTargets: false, fetchState: false }));
    register('inspect_json', 'Decode a supplied Safe transaction or Builder export.', { transaction: z.record(z.string(), z.unknown()), network }, ({ transaction, network }) => resolve(transaction, network === 'auto' ? 'eth' : network, { limit: 5, verifyTargets: false, fetchState: false }));
    register('list_pending', 'List up to five queued proposals for a Safe.', { safe: z.string().min(1), network }, ({ safe, network }) => resolve(safe, network, { scope: 'pending', limit: 5, verifyTargets: false, fetchState: false }));
    register('list_history', 'List up to five executed transactions for a Safe.', { safe: z.string().min(1), network }, ({ safe, network }) => resolve(safe, network, { scope: 'history', limit: 5, verifyTargets: false, fetchState: false }));
    return server;
  }, { responseMode: 'json', legacy: 'stateless', maxRequestBodySize: 262144 });
}
