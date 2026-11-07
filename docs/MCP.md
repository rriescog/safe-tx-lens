# MCP usage

Safe Tx Lens exposes two read-only MCP transports. The local stdio server uses your local configuration. A future hosted community deployment exposes `/mcp` over Streamable HTTP and shares the web UI's quota. The private GitHub repository is not yet a public hosted service.

## Local setup

Install dependencies with `npm ci` and register the checkout in your MCP client:

```sh
codex mcp add safe-tx-lens -- node /absolute/path/to/safe-tx-lens/bin/safe-tx-lens-mcp.mjs
```

For a client that accepts JSON configuration:

```json
{
  "mcpServers": {
    "safe-tx-lens": {
      "command": "node",
      "args": ["/absolute/path/to/safe-tx-lens/bin/safe-tx-lens-mcp.mjs"]
    }
  }
}
```

Keep `SAFE_API_KEY`, Tenderly credentials, and any `RPC_URL_<NETWORK>` in the local process environment or `.env.local`; do not put keys in prompts or MCP tool arguments. EVM RPC defaults are public endpoints and can fail or lack archive state. An offchain pending Safe hash needs a reachable proposal source. A Safe URL supplies the chain and address. A bare hash has neither, so automatic discovery checks only the configured mainnet integrations.

## Local tools

| Tool | Input | Result and limits |
| --- | --- | --- |
| `inspect` | `input`, optional `network`, `rpcUrl`, `simulate` | Safe hash, execution hash, Safe URL, or address; `network` defaults to `auto` |
| `inspect_json` | `transaction`, optional `safeAddress`, `safeHash`, `network`, `rpcUrl`, `simulate` | Decodes Safe transaction JSON or Builder export; Builder plans do not have a Safe hash by themselves |
| `inspect_execution` | `hash`, optional `network`, `rpcUrl`, `simulate` | Reconstructs an onchain Safe execution from RPC and verifies its emitted Safe hash; `network` defaults to Ethereum |
| `list_pending` | `safe`, optional `network`, `rpcUrl`, `simulate` | Up to 20 unexecuted records; stale nonces are identified; API confirmations are not independently verified |
| `list_history` | `safe`, optional `network`, `rpcUrl`, `simulate` | Up to 20 executed records; a recent RPC fallback may cover only a bounded block range |

Example prompts to an MCP client:

```text
Use safe-tx-lens.inspect on the Safe URL https://app.safe.global/home?safe=eth:0x... and show pending nonces.
Use safe-tx-lens.inspect_execution on 0x... on network eth; explain the decoded calls and evidence gaps.
```

The local server can run a Tenderly simulation only when `simulate: true` and credentials are configured. A queued proposal without enough signatures may receive a clearly marked conditional preview using a temporary 1-of-N threshold override inside Tenderly, after checking current Safe storage and an owner via RPC. It cannot prove that the actual Safe execution will succeed. Never infer approval from that preview.

## Hosted `/mcp`

When `serve --community` is deployed behind HTTPS, use `https://YOUR_DOMAIN/mcp` with an MCP client that supports Streamable HTTP. This endpoint exposes `inspect`, `inspect_json`, `list_pending`, and `list_history`. It caps queue/history results at five, input bodies at 256 KB, and rejects caller-supplied RPC URLs, credentials, polling and simulation parameters. It does not expose `inspect_execution` as a separate tool; `inspect` accepts an execution hash. The web UI and MCP share an operator-wide daily/monthly budget and a per-IP request allowance. On exhaustion the HTTP response is 429 with `Retry-After`.

MCP tool descriptions are instructions to the client about input format, not a security guarantee. Treat transaction metadata, ABI text, JSON files, and contract source as untrusted data. Verify every important hash on a signing device and compare critical results with a separate implementation.

## Verification

`npm test` exercises the local stdio MCP process and a remote Streamable HTTP client against a local community server with stubbed providers. No test claims that every live Safe, RPC, or Tenderly endpoint is available. The dated [network coverage](NETWORK-COVERAGE.md) records separately what was actually probed.
