# ABI sources by network

This matrix describes lookup routes, not a guarantee that an individual contract has published source. The tool tries Sourcify first, then the listed chain explorer. A response is useful for decoding only when it supplies a parseable ABI. A function name identifies calldata format; it cannot prove the called code's behavior.

| Network | Chain ID | Additional explorer lookup | Key |
| --- | ---: | --- | --- |
| Ethereum | 1 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Gnosis | 100 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Polygon PoS | 137 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Arbitrum One | 42161 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| OP Mainnet | 10 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Base | 8453 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Sepolia | 11155111 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Polygon Amoy | 80002 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| BNB Smart Chain | 56 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Avalanche C-Chain | 43114 | Etherscan V2 | `ETHERSCAN_API_KEY` |
| Katana | 747474 | Katana Blockscout, then Etherscan V2 | Etherscan fallback key |
| X Layer | 196 | OKLink | `OKLINK_API_KEY` optional, subject to its public access limits |
| Immutable zkEVM | 13371 | Immutable Blockscout | None |

All thirteen also have a Sourcify lookup. Etherscan V2's live chain list was checked on 2026-11-08; X Layer and Immutable zkEVM were absent, so they have separate routes. Configure keys only on the server. There is no per-user explorer key field in the web UI.

PolygonScan is part of the Etherscan V2 lookup path: the tool sends the same `ETHERSCAN_API_KEY` to `api.etherscan.io/v2/api` with `chainid=137`, `module=contract`, and `action=getsourcecode`. PolygonScan is the source link shown to the reviewer, not a second API endpoint or key. The hosted service uses this route only when its optional Etherscan secret is enabled; otherwise it tries Sourcify and any available keyless routes. An explorer ABI alone is not a bytecode match at a historical block.

## Evidence levels

1. **Verified at inspected block:** the chain RPC returned bytecode for that block, Sourcify or a verified Blockscout record returned runtime bytecode, and their hashes matched. This still does not prove that the function is safe.
2. **Verified current only:** the historical RPC call failed, so bytecode could only be compared with current state. A prior upgrade could have changed the implementation.
3. **Explorer ABI only:** Etherscan V2 or OKLink returned an ABI, or Blockscout returned an ABI without a verified bytecode record. Calldata arguments can be decoded, but the explorer response did not establish that the ABI corresponds to the bytecode at the reviewed block. This cannot earn the bytecode or fully confirmed decoding evidence points.
4. **Candidate signature:** a 4byte database supplied a matching signature without a contract ABI. The label is tentative.
5. **Unknown:** no supported source produced a matching ABI or signature. The raw selector and calldata remain visible.

For an upgradeable contract, the tool reads ERC-1967 implementation storage, recognized SafeProxy singleton storage, or a supported proxy getter at the relevant block when the RPC serves it. An explorer's current `Implementation` field is never substituted for historical storage. Other proxy patterns and dynamic modules need a trace or independent review.

Etherscan requests are paced below its documented free tier rate. All source requests have a timeout, bounded response size, fixed destination, and cache. A public deployment still needs its own quotas and provider budget. Provider errors should appear as unavailable evidence rather than a fabricated verification result.

Provider documentation: [Etherscan V2 supported chains](https://docs.etherscan.io/supported-chains), [Etherscan getsourcecode](https://docs.etherscan.io/api-reference/endpoint/getsourcecode), [Blockscout smart contract API](https://docs.blockscout.com/api-reference/get-smart-contract), [OKLink API](https://www.oklink.com/docs/en/), [Sourcify API](https://docs.sourcify.dev/docs/api/).

## Per-source evidence and Sourcify import

Every target check lists what each source returned, in query order, instead of a single "not verified":

| Outcome | Meaning |
| --- | --- |
| `match` | The source's verified runtime bytecode is identical to the RPC bytecode. |
| `different_bytecode` | The source has a verified contract at this address, but for different bytecode (sizes and hashes are shown). The code at the address is not what that source describes. |
| `abi_only` | An explorer has verified source and ABI, but its API returns no compiled bytecode, so it cannot be compared here. |
| `not_verified` / `not_configured` | No verified source, or the explorer key is not configured on this service. |
| `rate_limited` / `error` | The provider was unavailable. One retry honours a short `Retry-After`; these results are cached for one minute only, never as "not verified". |
| `rejected` / `failed` / `pending` | Result of the Sourcify import described below. |

When no source matches and only an Etherscan-family explorer holds the source, the tool asks Sourcify to import it (`POST /v2/verify/etherscan/{chainId}/{address}`). Sourcify fetches the source, compiles it on its own infrastructure (Solidity or Vyper) and compares it with the current chain code; this tool compiles nothing and runs no downloaded code. A match is then served by Sourcify and the target becomes `verified`. The import publishes a public Sourcify verification. This service never sends its own Etherscan key to Sourcify. Set `SOURCIFY_IMPORT=off` to disable it. Sourcify rejects an import when it already holds an exact match for an earlier version at the same address (for example, a system contract replaced by a hard fork); the report then says so.

A verified source for different bytecode always produces a `TARGET_SOURCE_DIVERGENCE` finding (a warning, or info when a pinned hard-fork allocation explains it), even when another source supplies an ABI.
