# Network coverage

Safe Tx Lens supports EVM networks through three separate capabilities: onchain RPC reads, Safe proposal and history lookup, and verified-source discovery. Availability differs by network and provider. A supported network does not imply that every Safe, transaction, historical block, or contract source can be retrieved.

The application publishes its [network catalog](../web/network-coverage.json) and [example catalog](../web/network-examples.json). Each catalog includes a check date. Treat those records as observations at that time, not as a live service guarantee. The UI reports unavailable evidence when a provider does not answer; it must not present an unavailable queue as empty.

## Last live check (9 November 2026)

The bounded endpoint probe used 39 authenticated Safe requests. All 13 configured public RPCs returned the expected chain ID. Eleven networks returned valid Safe indexing, queue, and history endpoint responses. Polygon Amoy and Immutable zkEVM returned HTTP 404 for those Safe list endpoints: on those two networks, use an onchain execution hash or transaction JSON. An empty-address endpoint response does not prove that a particular Safe is indexed.

We also inspected one real catalog transaction per network, without simulation. All 13 transactions resolved, but the independent historical Safe contract hash and bytecode checks did **not** pass everywhere:

| Network | Safe queue/history endpoint | Sample's Safe contract hash via RPC | Sample's target-code result |
| --- | --- | --- | --- |
| Ethereum | Responded | Passed | Verified at inspected block |
| Gnosis Chain | Responded | Passed | Verified at inspected block |
| Polygon PoS | Responded | Passed | Explorer ABI only; bytecode not verified |
| Arbitrum One | Responded | Unavailable | Current code only; past code not verified |
| OP Mainnet | Responded | Passed | Verified at inspected block |
| Base | Responded | Passed | Verified at inspected block |
| BNB Chain | Responded | Unavailable | Current code only; past code not verified |
| Avalanche C-Chain | Responded | Unavailable | Explorer ABI only; bytecode not verified |
| Katana | Responded | Passed | One target verified; one ABI only |
| X Layer | Responded | Passed | Explorer ABI only; bytecode not verified |
| Ethereum Sepolia | Responded | Unavailable | Explorer ABI only; bytecode not verified |
| Polygon Amoy | 404 | Passed for execution-hash example | Explorer ABI only; bytecode not verified |
| Immutable zkEVM | 404 | Passed for execution-hash example | One target verified; one unverified |

The Sepolia public RPC was replaced after its previous provider returned a quota error. Its replacement answered the correct chain ID, but the historical Safe contract call for the sample still returned missing revert data. No network was tested for complete archive availability or successful Tenderly simulation here. A passing local EIP-712 recomputation from provider-supplied fields is separate from an independent onchain contract check.

## What the checks establish

| Check | Establishes | Does not establish |
| --- | --- | --- |
| RPC chain ID | The endpoint answered for the expected chain | Historical state, receipts, traces, or uptime |
| Safe list endpoint | The provider returned a valid queue or history response | That a particular Safe or proposal is indexed |
| Example transaction | The published sample resolved and its fields matched its Safe hash | Support for all transactions on that network |
| Verified-source lookup | A source provider returned metadata for a contract | That its current or historical bytecode matches the inspected target |

For the precise ABI and bytecode evidence levels, see [ABI sources](ABI-SOURCES.md) and the [review model](REVIEW-MODEL.md).

## Recheck endpoints

Operators can run a bounded live probe and write a fresh catalog snapshot:

```sh
npm run check:networks -- --live --snapshot web/network-coverage.json
```

The probe makes authenticated Safe requests and RPC chain-ID reads. It does not inspect arbitrary transactions or prove archive access. Review the request budget before running it against a shared API key. Keep credentials out of the snapshot and commit only the resulting public endpoint status.

To inspect one published sample per network without Tenderly simulation, run `npm run check:examples -- --live`. The sample check uses additional upstream requests and reports each network's hash, target-code, and pending evidence. Run it explicitly; it is not a CI or uptime guarantee.
