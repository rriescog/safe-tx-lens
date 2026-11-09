# MCP usage

Safe Tx Lens exposes read-only MCP tools. The community endpoint is `https://safetxlens.org/mcp` over Streamable HTTP and shares the web UI's quota. Upstream lookups may be unavailable or rate limited. A local stdio server is available when you run your own copy.

Each MCP call requests only the analysis or Safe transaction list named by its tool. `list_history` means executed transactions belonging to the supplied Safe; it never reads previous users' requests. The application does not save a per-user request history, hashes, calldata, or IP addresses in its quota file. It saves aggregate daily/monthly usage counts; per-IP counters remain in process memory for the current day. Error logs contain a generated incident ID, category, time, and status without the input. An operator's reverse proxy or infrastructure may have separate access logs, so a self-hosted instance should configure those explicitly.

## Connect to the community service

Codex CLI/Desktop:

```sh
codex mcp add safe-tx-lens --url https://safetxlens.org/mcp
```

Other MCP clients should add `https://safetxlens.org/mcp` as a **Streamable HTTP** server using that client's own configuration format. The hosted endpoint exposes `inspect`, `inspect_json`, `list_pending`, and `list_history`; it does not run arbitrary URLs or accept a caller-supplied RPC endpoint. Web and MCP requests share daily, monthly and per-IP limits.

## Run your own local MCP

Clone the repository and run `npm ci`. From the checkout root, register the local process:

```sh
codex mcp add safe-tx-lens-local -- node "$PWD/bin/safe-tx-lens-mcp.mjs"
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

After registering the server, restart your MCP client so it discovers the tools. Try the published Safenet Beta rewards distribution on Ethereum:

```text
Use safe-tx-lens.inspect with input 0x53de3b97560824bbe774b2290e70bfdc37c5b9c502ac5e62d652e5f24190dc2a and network eth. Show the Safe address, nonce, decoded calls, source of each check, and remaining evidence gaps.
```

For a queued proposal, call `list_pending` with its Safe address and network, then pass one returned Safe hash to `inspect`. A Safe transaction hash identifies the signed fields, but it does not contain the network or Safe address; discovery depends on a reachable proposal source. If a lookup fails, provide the Safe URL or exported transaction JSON. A local MCP client can inspect JSON without sending it to a hosted Safe Tx Lens instance.

The local server can run a Tenderly simulation only when `simulate: true` and credentials are configured. A queued proposal without enough signatures may receive a clearly marked conditional preview using a temporary 1-of-N threshold override inside Tenderly, after checking current Safe storage and an owner via RPC. It cannot prove that the actual Safe execution will succeed. Never infer approval from that preview.

## Hosted `/mcp`

The hosted `https://safetxlens.org/mcp` endpoint exposes `inspect`, `inspect_json`, `list_pending`, and `list_history`. It caps queue/history results at five, input bodies at 256 KB, and rejects caller-supplied RPC URLs, credentials, and polling. Supplied URLs must be HTTPS links to `app.safe.global`; the service parses them for Safe fields and never fetches them as URLs. Bare hashes, Safe addresses, and transaction JSON remain valid data inputs. It does not expose `inspect_execution` as a separate tool; `inspect` accepts an execution hash. The web UI and MCP share an operator-wide daily/monthly budget and a per-IP request allowance for analysis calls. MCP initialization, ping, and tool discovery use a separate, bounded per-IP control allowance, so clients can reconnect and see the tools even when analysis quota is exhausted. On analysis exhaustion the HTTP response is 429 with `Retry-After`.

For one complete transaction, `inspect` or `inspect_json` can request `simulate: true` if the hosted service has a Tenderly project configured. This is explicit, uses a separate allowance of up to three requests/day/IP and 100/month globally by default, and returns measured effects without disclosing the operator's private Tenderly dashboard URL. The shared analysis budget or Tenderly plan may stop requests sooner. The option returns a configuration error when Tenderly is unavailable. `list_pending` and `list_history` cannot simulate an entire list; select a transaction first. A simulation can still be unavailable or conditional, and does not automatically make evidence confidence 10/10.

MCP tool descriptions are instructions to the client about input format, not a security guarantee. Treat transaction metadata, ABI text, JSON files, and contract source as untrusted data. Verify every important hash on a signing device and compare critical results with a separate implementation.

## Verification

`npm test` exercises the local stdio MCP process and a remote Streamable HTTP client against a local community server with stubbed providers. No test claims that every live Safe, RPC, or Tenderly endpoint is available. The dated [network coverage](NETWORK-COVERAGE.md) records separately what was actually probed.
