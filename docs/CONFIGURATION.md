# Configuration

Safe Tx Lens runs without credentials for local JSON decoding and best-effort onchain inspection through public RPCs. A pending Safe transaction hash requires an offchain proposal source; a hash alone does not contain its calldata, Safe address, or chain ID.

## Local process

Copy `.env.example` to `.env` and fill only the services you intend to use. The file is ignored by Git. Load it with Node.js:

```sh
node --env-file=.env bin/safe-tx-lens.mjs serve
```

The same environment applies to the CLI and local stdio MCP server. Keep provider URLs containing tokens secret. Never send keys through the web form, transaction JSON, MCP tool arguments, or issue reports.

| Setting | Purpose | Required? |
| --- | --- | --- |
| `SAFE_API_KEY` | Authenticated Safe Transaction Service lookups for queued proposals and history | Recommended for offchain lookup; required by community mode |
| `RPC_URL_<NETWORK>` | Onchain receipt, Safe contract, bytecode, proxy storage, and historical reads for one network | Optional locally; a matching public RPC is attempted by default |
| `RPC_URL` or `--rpc` | Override RPC for a single selected network | Optional; avoid for multi-network auto-detection |
| `ETHERSCAN_API_KEY` | Optional Etherscan V2 ABI and executed-transaction index lookups where supported | Optional |
| `OKLINK_API_KEY` | Optional OKLink ABI lookup where supported | Optional |
| `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT`, `TENDERLY_PROJECT` | Explicit Tenderly simulation and returned state effects | Optional; all three are needed |

The named network codes and chain IDs are defined in [`src/chains.mjs`](../src/chains.mjs). An explicit numeric EVM chain ID can be used for local inspection, but it does not imply that Safe list APIs or verified-source services exist for that chain. For source routes, see [ABI sources](ABI-SOURCES.md). For a dated endpoint probe, see [network coverage](NETWORK-COVERAGE.md).

Each RPC must answer with the selected chain ID. A current-state read does not establish historical bytecode or storage: choose an archive-capable provider for past-block checks. Public endpoints have independent rate limits and may omit old blocks. The tool reports unavailable evidence instead of treating a missing historical response as a successful verification.

### Simulation

Simulation is opt-in per transaction. It sends calldata and available signatures to the configured Tenderly project. Results cover one execution path at one chain state; they do not guarantee that a queued transaction will execute or that its signer approvals are valid. A conditional preview that overrides state inside the simulation is labeled separately. The browser shows returned effects without making a private Tenderly project link public.

## Hosted community service

The hosted UI and `/mcp` endpoint share a server-side quota. They do not use visitor credentials. The deployment requires a **dedicated** Safe API key stored as a file-mounted secret. Tenderly is disabled unless a separate community project, access key, and deployment variables are configured. Follow [deployment](../deploy/README.md) for exact files, repository variables, and rollback.

The current community mode rejects `RPC_URL` and `RPC_URL_<NETWORK>` in its environment. It uses the public RPC defaults in [`src/onchain.mjs`](../src/onchain.mjs); putting a private RPC URL on the VPS will not enable it. Adding quota-controlled, server-only dedicated RPCs requires an implementation change. Do not place a personal provider token in a public browser or MCP configuration.

The community service never reads a local Tenderly monitor snapshot. It fetches a requested Safe transaction from available sources or analyzes caller-supplied JSON. A provider outage, missing Safe index, or exhausted quota is reported as unavailable rather than converted into a negative finding about the transaction.

## Data handling

The application parses Safe URLs from the allowed Safe domain; it does not fetch an arbitrary URL supplied by a user. Transaction metadata, ABI text, source, JSON files, and MCP arguments are untrusted data. Browser uploads are parsed, not executed, and have size limits. The public service logs a generated incident reference and category for unexpected failures without logging the hash, calldata, URL, IP address, or credentials in its application incident record. Reverse proxies and infrastructure may keep separate access logs; review those settings when self-hosting.
