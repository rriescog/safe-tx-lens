# Network coverage

Safe Tx Lens supports EVM networks through three separate capabilities: onchain RPC reads, Safe proposal and history lookup, and verified-source discovery. Availability differs by network and provider. A supported network does not imply that every Safe, transaction, historical block, or contract source can be retrieved.

The application publishes its [network catalog](../web/network-coverage.json) and [example catalog](../web/network-examples.json). Each catalog includes a check date. Treat those records as observations at that time, not as a live service guarantee. The UI reports unavailable evidence when a provider does not answer; it must not present an unavailable queue as empty.

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
