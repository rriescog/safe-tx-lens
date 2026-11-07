# Safe Tx Lens

Read-only inspection for Safe multisig proposals. Give it a Safe transaction hash, an onchain execution hash, a Safe URL, a Safe address, or transaction JSON. It recalculates the EIP-712 hash, recursively opens supported nested calls, rates review priority from the decoded action and observed effects, and optionally simulates the actual `execTransaction` through Tenderly. The CLI can poll a Safe's offchain queue; the local UI and MCP server expose the same analysis.

## Why

A compromised multisig interface can show a benign description while presenting different calldata for approval. Safe Tx Lens helps a team compare the Safe hash, complete transaction fields, nested calls, target bytecode, and optional simulation before signing. The signing device's displayed hash and an independently obtained reference are critical parts of that review.

## How to use the review

1. Paste a Safe transaction hash, onchain execution hash, Safe address, Safe URL, or JSON export. For a Safe address, choose queued proposals or executed history and then select a transaction.
2. Check the source and time of the transaction fields. Compare the recalculated hash with the exact hash shown on your signing device.
3. Follow the decoded call graph and proposed changes. Check whether target bytecode verification actually ran and whether it matched source at the relevant block.
4. If configured, run one simulation and read only the state changes the provider returned. Use a separate implementation and a separately trusted source for the final review.

The UI has a one-click example based on a public Ethereum Safe execution. Its transaction fields are bundled with the app and decoded locally, so the example does not consume an upstream request or imply a fresh verification. Inspecting a user-supplied hash uses a live lookup.

On Chrome, the UI can be installed as an app when served on localhost or HTTPS. The service worker caches only an offline explanation page; transaction inputs, API responses and reports are never cached for offline viewing. The moving network strip includes Katana and X Layer icons from their respective [Katana brand kit](https://docs.katana.network/katana/additional-resources/brand-kit/) and [X Layer media kit](https://github.com/okx/xlayer-docs/tree/main/media-kit). Chain marks remain the property of their owners; their display does not imply endorsement or grant trademark rights under this project's MIT license.

The hosted interface and its Safe, RPC, Sourcify, and Tenderly providers are additional trust boundaries. For a stronger independent check, install the source on infrastructure you control, select an RPC you trust separately, and compare results with another implementation. This repository is currently private while the service is being prepared for a public MIT-licensed release; a hosted report is not a safety guarantee.

**This is an aid for human review, not a proof of safety.** A matching hash proves the supplied fields hash to the expected value. It does not prove target bytecode is benign. A successful simulation covers one chain state and one execution path. Verify the hash on a hardware wallet and inspect every critical call independently.

**Decoding is not proof of behavior.** For a selected transaction, the tool reads runtime bytecode from that chain's RPC and compares its hash with Sourcify's verified runtime bytecode. It checks selectors against the matching ABI and follows ERC-1967 implementation slots. Missing source, a bytecode mismatch, and unavailable historical RPC state stay visible. Other proxy patterns, delegatecall semantics, and code changes within a transaction need independent review. It does not decompile arbitrary EVM bytecode.

## Quick start

Node.js 20 or newer:

```sh
npm install
node bin/safe-tx-lens.mjs serve
```

Open <http://127.0.0.1:4173>. Choose hash, Safe address, Safe URL, or JSON in the guided form; it also recognizes pasted inputs automatically. The report distinguishes transaction fields fetched from Safe services from its local hash calculation and contract hash check via RPC. The UI binds only to localhost and never requests a wallet connection or signature.

```sh
# The Safe transaction hash is enough when the Safe API is available.
node bin/safe-tx-lens.mjs inspect 0xYOUR_SAFE_TX_HASH --network eth

# An executed Ethereum transaction can be reconstructed from public RPC without any API key.
node bin/safe-tx-lens.mjs inspect 0xYOUR_ONCHAIN_EXECUTION_HASH --network eth

# A Safe address discovers supported networks and inspects their pending proposals.
node bin/safe-tx-lens.mjs inspect 0xYOUR_SAFE_ADDRESS --network auto

# List recent executed history, or pending plus executed, for a Safe address.
node bin/safe-tx-lens.mjs inspect 0xYOUR_SAFE_ADDRESS --network eth --scope history
node bin/safe-tx-lens.mjs inspect 0xYOUR_SAFE_ADDRESS --network eth --scope both

# A Safe URL carries the network and, when present, the transaction hash.
node bin/safe-tx-lens.mjs inspect 'https://app.safe.global/transactions/tx?safe=eth:0xYOUR_SAFE_ADDRESS&id=multisig_...'

# Local JSON works even when the Safe API is rate limited.
node bin/safe-tx-lens.mjs inspect @transaction.json --network eth --rpc https://YOUR_RPC --json

# Safe Transaction Builder exports are accepted as plans, even without nonce or Safe hash.
node bin/safe-tx-lens.mjs inspect @builder-export.json --network eth
node bin/safe-tx-lens.mjs inspect @builder-export.json --network eth --safe-hash 0xYOUR_SAFE_TX_HASH

# Monitor new proposals and confirmations. Emits JSON for piping to your own alerting system.
node bin/safe-tx-lens.mjs watch 0xYOUR_SAFE_ADDRESS --network eth --interval 30
```

Eleven named networks have public RPC defaults, including [Katana](https://docs.katana.network/katana/technical-reference/network-information/) and [X Layer](https://web3.okx.com/it/onchainos/dev-docs/xlayer/developer/rpc-endpoints/rpc-endpoints). These endpoints need no user key but have no service guarantee. Katana and X Layer RPC chain IDs and Safe indexing, queued and history endpoints responded in the [bounded endpoint probe](docs/NETWORK-COVERAGE.md); that empty-address check does not establish that a particular transaction is indexed. No key is needed for local JSON analysis or reconstruction from an onchain execution transaction hash when a public RPC responds. Pending proposals are offchain, so an EVM RPC cannot recover their calldata from a Safe transaction hash. Safe Transaction Service access is needed for reliable hash-only lookup of pending proposals. [Anonymous access](https://docs.safe.global/core-api/how-to-use-api-keys) has a monthly quota; `SAFE_API_KEY` enables authenticated access.

For a Safe hash, the UI, CLI, and MCP look up offchain proposals through Safe services and can use an optional Etherscan event index to locate executed transactions. An indexed execution is reconstructed and checked against the EVM RPC; an index hit by itself is not treated as proof. For a Safe address, Safe services supply the pending queue and executed history; Ethereum history can fall back to a recent RPC scan. The RPC scan covers roughly the latest 8,000 blocks and reports its range. If every pending source fails, the queue is marked **unavailable**, never empty. Listings show at most 20 per category in the UI and MCP.

A bare Safe hash does not encode a readable network or Safe address. The UI defaults to **Auto-detect**, which first checks public RPC receipts for a Safe execution event, then searches supported chain indexes and Safe Transaction Services for a proposal hash. A Safe URL supplies its own network. A bare Safe address is probed on supported chains; when found on several, the UI lets the reviewer choose a network. Network discovery depends on reachable services and may miss unsupported or unavailable chains. For an executed transaction, the report labels the onchain execution hash, block, and time separately from decoded intent. An empty measured state-diff section means no trace or simulation supplied those effects.

### Credentials and RPC setup

Copy `.env.example` to `.env`, fill only the services you use, then start with `node --env-file=.env bin/safe-tx-lens.mjs serve`. `.env` is gitignored; never paste a key into the web UI. Keys embedded in an RPC URL are secrets too.

| Setting | Needed for | Local CLI/UI/MCP | Hosted community service today |
| --- | --- | --- | --- |
| `SAFE_API_KEY` | Reliable queued hash lookup and Safe pending/history listings | Recommended; anonymous quota is limited | Required; provision a dedicated service key as a server secret |
| `RPC_URL_ETH`, `RPC_URL_POL` | Independent Ethereum/Polygon chain reads: Safe contract hash, execution receipt/logs, target bytecode, ERC-1967 slot, historical state when available | Recommended for dependable reviews; public RPC defaults exist | Dedicated RPC URLs are **not yet wired** into hosted mode; it uses public defaults |
| Other `RPC_URL_<NETWORK>` | The same onchain checks on another selected network | Optional per selected chain | Dedicated URLs are **not yet wired** into hosted mode |
| `ETHERSCAN_API_KEY` | Optional index for older executed Safe hashes | Optional | Not provisioned in the current deployment |
| `TENDERLY_ACCESS_KEY`, `TENDERLY_ACCOUNT`, `TENDERLY_PROJECT` | Optional simulation and measured state changes | Optional | Optional dedicated community project; disabled by default |
| Sourcify | Verified runtime bytecode and ABI lookup | No key | No key; public API fair use applies |

The network suffixes are `ETH` (Ethereum, chain 1), `POL` (Polygon PoS, 137), `GNO` (Gnosis, 100), `ARB1` (Arbitrum One, 42161), `OETH` (Optimism, 10), `BASE` (8453), `SEP` (Sepolia, 11155111), `KAT` (Katana, 747474), `XLAYER` (X Layer, 196), `BNB` (56), and `AVAX` (43114). A numeric chain ID uses `RPC_URL_<CHAIN_ID>` for explicit local inspection. Configure one endpoint **per network** for multi-chain use: the single `RPC_URL` or `--rpc` overrides every network in that process/request, so it is suitable only when inspecting one selected chain. The tool checks the RPC's `eth_chainId` against the selected network and reports a mismatch rather than trusting the wrong chain. For historical bytecode/storage checks, choose a provider that serves the required past block; if it cannot, the report labels current-only or unavailable evidence.

Safe Transaction Service calls use its `katana` and `okb` aliases for the user-facing `kat` and `xlayer` network names. The UI accepts Safe URLs with those aliases and keeps chain IDs 747474 and 196 for hashing and RPC checks.

Ethereum and Polygon PoS had working Safe indexing, pending and history endpoints, and matching public RPC chain IDs in the [dated network probe](docs/NETWORK-COVERAGE.md). That probe did **not** establish that every transaction, contract, or historical block can be verified. For a dependable public service, dedicated Ethereum and Polygon RPC endpoints, caching, provider failure handling, and end-to-end tests must be added to hosted mode before claiming that standard. A paid RPC plan alone does not change the present hosted configuration.

[Safe Builder](https://safe.global/plans) provides a free authenticated plan with a monthly quota; Safe lists it for prototyping and its Growth plan for production. For simulation, set the Tenderly variables above, then use `--simulate` with CLI `inspect` or select the simulation button for one report in the UI. A simulation is saved in the configured Tenderly project. The local UI links to its trace for project members; the public UI shows returned effects but does not publish a private project URL. Tenderly simulations require an explicit sharing action before anyone can open them publicly.

In the UI, open one transaction and select **Run simulation and inspect state changes**. This sends that transaction's calldata and signatures to the configured Tenderly project. The report separates decoded intent from storage, balance, and asset changes returned by the simulation. If signatures are insufficient, hash verification fails, or the provider omits the state diff, it reports that limit rather than claiming no changes. Simulation is opt-in per transaction so browsing a Safe queue does not submit dozens of simulations.

```sh
export SAFE_API_KEY='...'
export ETHERSCAN_API_KEY='...'
export RPC_URL_ETH='https://YOUR_ETHEREUM_RPC'
export RPC_URL_POL='https://YOUR_POLYGON_RPC'
export TENDERLY_ACCESS_KEY='...'
export TENDERLY_ACCOUNT='your-account'
export TENDERLY_PROJECT='your-project'
node bin/safe-tx-lens.mjs serve
```

The JSON input should contain `safe`, `to`, `value`, `data`, `operation`, `nonce`, `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, and `refundReceiver`; absent numeric/gas fields default to zero. Include `safeTxHash` to check it against the calculated hash. For historical simulation include `transactionHash`, `blockNumber`, and either the exact `signatures` bytes from an onchain `execTransaction` or `confirmationsRequired` and `confirmations` from the Safe Transaction Service.

Safe Transaction Builder exports have a different shape: `version`, `chainId`, `meta`, and `transactions`. The tool decodes each top-level transaction and nested timelock/governance call. The export's `meta.checksum` is **not** a Safe transaction hash. A Builder export omits the Safe nonce and gas fields, so it cannot prove a Safe hash on its own. In the UI, enter a Safe transaction hash in the comparison field to fetch the actual Safe transaction and check the target, value, operation, and calldata of every call in order. Executed Ethereum Safe hashes can also be found in recent onchain logs when Safe API access is exhausted; queued hashes still require the Safe Transaction Service.

## MCP server

`node bin/safe-tx-lens-mcp.mjs` starts a local stdio MCP server using the [official TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/). It exposes five read-only tools: `inspect`, `inspect_json`, `inspect_execution`, `list_pending`, and `list_history`. `inspect_json` can review offchain proposals without any API key; `inspect_execution` uses public Ethereum RPC. `list_pending` needs a reachable Safe Transaction Service. `list_history` can fall back to recent Ethereum RPC logs.

In Codex CLI/Desktop, register this checkout with:

```sh
codex mcp add safe-tx-lens -- node /absolute/path/to/safe-tx-lens/bin/safe-tx-lens-mcp.mjs
```

Example MCP host configuration (replace the path with your checkout):

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

The [VPS deployment guide](deploy/README.md) prepares a community service with a dedicated Safe API key, shared web/MCP quota, and CI/CD. Tenderly simulation is optional and requires a separate community project. A VPS and domain have not yet been configured, so this repository is not a live public SaaS.

## What the report distinguishes

| Layer | Evidence | Limit |
| --- | --- | --- |
| Hash | The user's supplied hash when available; local EIP-712 recomputation; onchain Safe `getTransactionHash` through an RPC when available | A pass confirms agreement about the supplied fields, not malicious target code or valid signer approvals |
| Decoded action and risk | Built-in ABI for common transfers, approvals, Safe authority changes, upgrades, timelock calls, governance forwarding, validator calls, and recursive MultiSend; action-based impact and review priority | A matching selector does not verify the target bytecode or prove the action will execute; unknown selectors stay unknown |
| Target code | Chain-checked RPC bytecode hash compared with Sourcify's verified runtime; ABI selector check; ERC-1967 implementation inspection | Matching source does not prove safe behavior; unverified source or archive state is reported; other proxy patterns need manual review |
| Observed effect | Storage, native balance, and asset changes reported by a simulation, with Safe singleton slot 0 highlighted | Only available when simulation succeeds and the provider returns changes |
| Execution | Safe Transaction Service status and optional historical simulation at the previous block | A simulated success never guarantees future execution |

Simulation uses the transaction's actual fields and either exact onchain signature bytes or standard 65-byte confirmation signatures. It does **not** override Safe threshold or storage. If there are too few compatible signatures, it reports simulation unavailable. Historical simulations require the real execution sender and an RPC receipt or block number; the tool will not guess a sender because it can change Safe signature checks. Building complex offchain contract signature layouts from confirmations needs further support.

The report names the origin of the transaction fields. For a queued Safe hash, Safe Transaction Service or Client Gateway supplies the fields; local EIP-712 calculation checks that they produce the requested hash. The Safe contract hash check asks the contract through an RPC, independently of the Safe service if that RPC is separately trusted. If the input is only a Safe address, there is no independently supplied reference hash until the reviewer compares the result with the signing device. Imported JSON is not a second source if it was downloaded from the same Safe service. API confirmation labels and signatures are not independently validated by the hash checks.

Normal hash and Safe address lookups never read monitor snapshots. A local CLI can explicitly opt into a snapshot fallback with `--monitor-fallback`; incomplete records are marked unverified. The hosted service never enables this fallback. A Tenderly simulation is a separate, explicit action.

`watch` polls the first 100 pending proposals, reports new proposals and confirmation-count changes, and fetches the final status when a tracked proposal leaves the queue. It is a local process, not a hosted 24/7 monitor. The UI displays up to 20 pending proposals per refresh and marks when a tracked proposal leaves the queue. The interface never submits a transaction or a signature.

## Prior work and design choices

This project builds on ideas from [pcaversaccio's Safe transaction hash utility](https://github.com/pcaversaccio/safe-tx-hashes-util), the [Cyfrin fork](https://github.com/Cyfrin/safe-tx-hashes), and [OpenZeppelin Safe Utils](https://github.com/OpenZeppelin/safe-utils). The report shows its EIP-712 domain and message hashes and a command for pcaversaccio's separate implementation. Its standard mode also retrieves the fields from Safe Transaction Service, so agreement is a calculation cross-check, not independent evidence for the fields; its interactive mode can use manually supplied fields. That AGPL-licensed script is not bundled or run by this MIT project. The workflow follows [SEAL's secure multisig verification guidance](https://github.com/security-alliance/frameworks/blob/develop/docs/pages/wallet-security/signing-and-verification/secure-multisig-safe-verification.mdx). Safe's [Transaction Service](https://docs.safe.global/core-api/api-safe-transaction-service) supplies offchain proposals; Tenderly supplies optional execution traces. No code was copied from those projects.

The added focus is a single input surface for hash, URL, JSON, and offchain queue; one report that keeps declared intent separate from simulated effects; and an explicit distinction between verified, unavailable, and failed checks.

## Security and limitations

- Supported Safe Transaction Service network prefixes are listed in `src/chains.mjs`. A Safe URL must be on `app.safe.global`.
- Other EVM chain IDs can be entered explicitly in the UI, CLI (`--network 130`), or MCP. JSON with a valid chain ID can select that chain automatically for offline decoding and EIP-712 hashing. Safe Client Gateway must serve that chain for pending proposals; set `RPC_URL_<CHAIN_ID>` or `--rpc` to check contract bytecode. Hash-only or address-only automatic chain discovery remains limited to the twelve named integrations: a 32-byte hash has no chain ID, and probing every Safe-supported chain on each public request would exhaust provider quotas. For another chain, supply its chain ID or a Safe URL that contains it. An unavailable Safe service is reported rather than guessed.
- [Dated network coverage](docs/NETWORK-COVERAGE.md) records actual Safe indexing, pending and history endpoint responses alongside RPC chain-ID checks. The UI displays the same dated snapshot; a live request may differ. Recheck with `npm run check:networks -- --live --snapshot web/network-coverage.json`. The script caps and paces Safe requests, stops on HTTP 429 or low remaining quota, and never publishes the key or quota headers in the UI snapshot.
- The tool fetches from fixed Safe, Tenderly, and Sourcify endpoints plus network-specific public RPCs. `--rpc` or `RPC_URL_<NETWORK>` selects another RPC. The local UI listens on `127.0.0.1` and does not expose API keys to the browser.
- The built-in ABI list covers common calls. Unknown selectors are decoded with a Sourcify ABI only after the source runtime bytecode matches an RPC response for the target or its ERC-1967 implementation. A function name describes the call format, not what the contract will actually do. Historical code may be unavailable; the report labels current-only matches.
- The colored 0–10 figure measures evidence coverage, not safety or the probability of an exploit. A failed Safe hash check forces it to zero. Unavailable historical code caps the score.
- Browser and API inputs, uploaded JSON, ABI labels, and MCP arguments are treated as untrusted data. The service validates structure and size, and the UI escapes or constructs text nodes for external values. There is no LLM in the inspection path, so transaction content is never promoted into prompt instructions.
- Unavailable routes and unexpected inspection failures return a readable apology and incident reference. The server logs only that reference, time, category, and HTTP status; it does not put the URL, IP, hash, calldata, or credentials in the incident record. Expected bad input is explained without creating an incident. The reference is for operator follow-up; no external alerting service is configured yet.
- The public service verifies code for a selected transaction, with the request charged to the same per-client quota as other web and MCP requests. Queue listings remain lightweight. A public demo without source-verification capacity is separately labeled.
- Donation addresses are not shown until the maintainer configures `PUBLIC_DONATION_WALLETS` as a JSON array of `{ "network": "eth", "address": "0x..." }` entries. Check the network and address before sending funds. No Bitcoin address is configured. Network logo files come from [Trust Wallet Assets](https://github.com/trustwallet/assets) under its MIT license, reproduced in `web/assets/chains/LICENSE`.
- State diffs can omit internal semantics and token transfers depending on Tenderly's response. Raw storage slots are shown without invented variable names.
- A compromised RPC, Safe API, Tenderly service, computer, browser, or signing device can still mislead the reviewer. Cross-check against another provider and the hardware wallet display.
- There is no claim that this tool alone would have prevented Bybit or any other incident. Operators need independent verification, signer process controls, and incident response procedures.

Report vulnerabilities privately; see [SECURITY.md](SECURITY.md).

## Development

```sh
npm test
```

MIT licensed. Contributions for verified ABI sources, proxy detection, richer state effects, and safe historical replay are welcome.
