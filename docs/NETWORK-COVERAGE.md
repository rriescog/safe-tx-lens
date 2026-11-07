# Network endpoint coverage

Last live probe: **2026-11-07 18:23 UTC**. This is a dated observation, not a promise of future availability.

The original probe made **30 authenticated Safe Transaction Service requests**, paced by 600 ms and capped at three per named network. It stopped automatically if Safe returned HTTP 429 or its remaining quota fell below 100. Nine public RPC endpoints were checked once each with `eth_chainId`. The unavailable legacy chain from that probe is excluded from the supported network list. The Safe key and quota headers are not published in the UI snapshot.

| Network | Chain ID | Safe indexer | Pending endpoint | History endpoint | RPC chain ID |
| --- | ---: | --- | --- | --- | --- |
| Ethereum | 1 | 200, synced | 200 | 200 | Matched |
| Gnosis | 100 | 200, synced | 200 | 200 | Matched |
| Polygon | 137 | 200, synced | 200 | 200 | Matched |
| Arbitrum One | 42161 | 200, synced | 200 | 200 | Matched |
| Optimism | 10 | 200, synced | 200 | 200 | Matched |
| Base | 8453 | 200, synced | 200 | 200 | Matched |
| Sepolia | 11155111 | 200, synced | 200 | 200 | Matched |
| BNB Chain | 56 | 200, synced | 200 | 200 | Matched |
| Avalanche | 43114 | 200, synced | 200 | 200 | Matched |

Two Agglayer rollups were added after that probe. At **2026-11-07 12:14 UTC**, their official public RPCs answered `eth_chainId` with the expected IDs. Six additional authenticated Safe requests used the correct service aliases (`katana` and `okb`): each indexer reported synced and each pending/history endpoint returned a valid empty-address list. This confirms endpoint availability, **not** that any particular Safe or transaction is indexed:

| Network | Chain ID | Safe indexer | Pending endpoint | History endpoint | RPC chain ID |
| --- | ---: | --- | --- | --- | --- |
| [Katana](https://docs.katana.network/katana/technical-reference/network-information/) | 747474 | 200, synced | 200 | 200 | Matched |
| [X Layer](https://web3.okx.com/it/onchainos/dev-docs/xlayer/developer/rpc-endpoints/rpc-endpoints) | 196 | 200, synced | 200 | 200 | Matched |

The pending and history calls used the zero address with `limit=1`. Their empty `results` arrays prove those endpoints answered with the expected list format; they do **not** prove that a particular Safe or transaction exists, that a pending proposal is recoverable, or that decoding and historical state verification work for every contract.

One separate end-to-end sample used the public [Polygon PoS Council Safe](https://docs.polygon.technology/pos/reference/commit-chain-multisigs) on Ethereum with `limit=1` for each scope. Safe Transaction Service returned pending nonce 243 and executed nonce 244; both locally recomputed Safe hashes matched the returned hashes. This sample spent four additional Safe requests and does not validate the other eight available networks' individual transactions.

For another EVM chain ID, the tool can ask Safe Client Gateway for the selected chain and recompute the Safe hash if complete transaction fields are returned. Such chains are **not** part of this probe or auto-discovery and must not be shown as covered until tested.

Run the bounded probe again with the current thirteen-network list (at most 39 Safe requests) with the command below. Some of those networks are only configured for onchain or JSON inspection; a failed Safe endpoint must remain marked unavailable rather than counted as covered.

```sh
npm run check:networks -- --live --snapshot web/network-coverage.json
```

Safe counts [one API unit per HTTP request](https://docs.safe.global/core-api/api-authentication). The probe reads `X-RateLimit-Remaining`, never retries a 429, and does not write credentials to the snapshot.

Immutable zkEVM (chain 13371) was added as an explicit onchain/JSON integration after an `eth_chainId` response of `0x343b` from its official public RPC on 2026-11-07. Safe proposal indexing and queue/history endpoints were not verified for this chain; do not treat it as full Safe Transaction Service coverage. Polygon Amoy and Immutable zkEVM returned HTTP 404 from the configured Safe Transaction Service endpoints in the 2026-11-07 live probe; their UI choices are limited to onchain execution hashes and supplied JSON. The old Polygon-operated Amoy RPC was retired; PublicNode returned chain ID 80002 on 2026-11-07. Neither network can currently retrieve a pending Safe hash or queue through this tool.
