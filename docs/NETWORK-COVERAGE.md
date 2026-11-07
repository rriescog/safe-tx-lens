# Network endpoint coverage

Last live probe: **2026-11-07 11:18 UTC**. This is a dated observation, not a promise of future availability.

The probe made **30 authenticated Safe Transaction Service requests**, paced by 600 ms and capped at three per named network. It stopped automatically if Safe returned HTTP 429 or its remaining quota fell below 100. Nine public RPC endpoints were checked once each with `eth_chainId`; Polygon zkEVM had no configured RPC. The Safe key and quota headers are not published in the UI snapshot.

| Network | Chain ID | Safe indexer | Pending endpoint | History endpoint | RPC chain ID |
| --- | ---: | --- | --- | --- | --- |
| Ethereum | 1 | 200, synced | 200 | 200 | Matched |
| Gnosis | 100 | 200, synced | 200 | 200 | Matched |
| Polygon | 137 | 200, synced | 200 | 200 | Matched |
| Arbitrum One | 42161 | 200, synced | 200 | 200 | Matched |
| Optimism | 10 | 200, synced | 200 | 200 | Matched |
| Base | 8453 | 200, synced | 200 | 200 | Matched |
| Sepolia | 11155111 | 200, synced | 200 | 200 | Matched |
| Polygon zkEVM | 1101 | 404 | 404 | 404 | No default RPC |
| BNB Chain | 56 | 200, synced | 200 | 200 | Matched |
| Avalanche | 43114 | 200, synced | 200 | 200 | Matched |

The pending and history calls used the zero address with `limit=1`. Their empty `results` arrays prove those endpoints answered with the expected list format; they do **not** prove that a particular Safe or transaction exists, that a pending proposal is recoverable, or that decoding and historical state verification work for every contract. A 404 for Polygon zkEVM means the configured Safe Transaction Service alias did not serve these endpoints during this probe. A supplied transaction JSON can still be decoded locally for chain 1101; onchain checks require an explicit RPC.

One separate end-to-end sample used the public [Polygon PoS Council Safe](https://docs.polygon.technology/pos/reference/commit-chain-multisigs) on Ethereum with `limit=1` for each scope. Safe Transaction Service returned pending nonce 243 and executed nonce 244; both locally recomputed Safe hashes matched the returned hashes. This sample spent four additional Safe requests and does not validate the other eight available networks' individual transactions.

For another EVM chain ID, the tool can ask Safe Client Gateway for the selected chain and recompute the Safe hash if complete transaction fields are returned. Such chains are **not** part of this probe or auto-discovery and must not be shown as covered until tested.

Run the bounded probe again with:

```sh
npm run check:networks -- --live --snapshot web/network-coverage.json
```

Safe counts [one API unit per HTTP request](https://docs.safe.global/core-api/api-authentication). The probe reads `X-RateLimit-Remaining`, never retries a 429, and does not write credentials to the snapshot.
