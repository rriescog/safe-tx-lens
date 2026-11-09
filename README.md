# Safe Tx Lens

[![Tests and audit](https://github.com/rriescog/safe-tx-lens/actions/workflows/quality.yml/badge.svg?branch=main)](https://github.com/rriescog/safe-tx-lens/actions/workflows/quality.yml) [![Build and deploy](https://github.com/rriescog/safe-tx-lens/actions/workflows/ci-cd.yml/badge.svg?branch=main)](https://github.com/rriescog/safe-tx-lens/actions/workflows/ci-cd.yml) [![MIT License](https://img.shields.io/github/license/rriescog/safe-tx-lens)](LICENSE) [![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-43853d)](package.json)

**Independent, read-only review of Safe transactions before signing, while queued, and after execution.**

Safe Tx Lens reconstructs a transaction's fields, checks its Safe hash, decodes nested calls, and shows which contract-code and simulation checks actually ran. Use the [community interface](https://safetxlens.org/) or run the open-source UI, CLI, and MCP server on infrastructure you control. It never asks for a wallet connection, private key, or signature.

## Why this exists

A signing interface can display a benign description while presenting different transaction fields for approval. A reliable review starts with the exact hash shown on the signing device, then examines the fields, nested calls, target code, and any measured effects. Safe Tx Lens makes that work easier and exposes missing evidence. **It cannot certify that a transaction is safe.**

## Start a review

| Input | What the tool can do | What it still needs |
| --- | --- | --- |
| Safe transaction hash | Search available sources, reconstruct fields, and recalculate the hash | A reachable proposal or execution source; the hash contains neither chain ID nor Safe address |
| Onchain execution hash | Reconstruct an executed Safe transaction | An RPC serving that transaction and relevant historical state |
| Safe address or Safe URL | List queued proposals or executed history, then inspect a selection | Safe list endpoints for that network |
| Transaction JSON or Builder export | Decode supplied fields and compare hashes when complete | Independent provenance; a Builder plan alone has no Safe nonce or transaction hash |

Network discovery and provider access are best-effort. An unavailable queue is marked **unavailable**, never empty. Supplied JSON can still be inspected when offchain lookup fails. The [dated network coverage](docs/NETWORK-COVERAGE.md) reports actual endpoint checks, and the [ABI source matrix](docs/ABI-SOURCES.md) describes contract lookup routes.

### Read the result

1. Check the source of the transaction fields. Compare the calculated Safe hash with your signing device.
2. Read the decoded call tree, including nested calls. The interactive graph is an additional view of the same tree.
3. Check whether target code was verified at the inspected block, verified only against current state, decoded from an unmatched ABI, or left unknown.
4. If simulation is configured, request it for the selected transaction and inspect only the effects returned. Cross-check critical conclusions with a separately trusted source.

The 0–10 **evidence confidence** number measures how much of the report could be checked; it is not a safety score. Review priority describes possible impact, not malicious intent. A decoded selector or ABI describes calldata format, not contract behavior. See the [review model](docs/REVIEW-MODEL.md).

## Run it yourself

Requires Node.js 20 or newer:

```sh
git clone https://github.com/rriescog/safe-tx-lens.git
cd safe-tx-lens
npm ci
npm start
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The local UI binds to loopback. Chrome can install it as an app on localhost or HTTPS; the service worker does not cache transaction inputs or reports.

The CLI uses the same analysis:

```sh
node bin/safe-tx-lens.mjs inspect 0xSAFE_TRANSACTION_HASH --network auto
node bin/safe-tx-lens.mjs inspect 0xEXECUTION_HASH --network eth --json
node bin/safe-tx-lens.mjs inspect 0xSAFE_ADDRESS --network eth --scope both
node bin/safe-tx-lens.mjs inspect @transaction.json --network eth
node bin/safe-tx-lens.mjs help
```

The local `watch` command polls one Safe and emits JSON events; it is not a hosted monitoring control. See [MCP usage](docs/MCP.md) for local and hosted clients and the [deployment guide](deploy/README.md) for a community service.

### Credentials

**No key is required** to decode supplied JSON or try an executed transaction through a working public RPC. Pending offchain proposals need a proposal source; an EVM RPC alone cannot recover their calldata from a Safe hash. Authenticated Safe access improves lookup reliability, and dedicated RPCs improve onchain and historical checks.

Copy [`.env.example`](.env.example) to `.env` and set only the providers you use. Keep keys and keyed RPC URLs out of Git, browser inputs, and MCP arguments. Tenderly simulation is optional and disabled when its credentials and project are absent. The hosted service uses its own server-side credentials and quotas, never a visitor's local environment. See [configuration](docs/CONFIGURATION.md) for the settings and hosted-mode limits.

## Evidence and limits

The tool hashes transaction fields locally with EIP-712 and, when possible, asks the Safe contract for its hash through an RPC. Nested calldata is decoded with built-in ABIs, verified contract metadata, explorer ABIs, or clearly labeled candidate signatures. Runtime bytecode is compared with verified source when both the source and an appropriate RPC block are available. Recognized proxy implementation paths are inspected separately.

Simulation is an **explicit** Tenderly request. It can show storage and asset changes for one chain state and execution path; missing values stay missing. A conditional preview that changes Safe state inside the simulation is labeled and does not establish approval or faithful execution. For an executed transaction, the report distinguishes Safe success, Safe failure, and an unknown outcome.

Each report states which checks passed, were unavailable, or remain inferred. Safe services, RPCs, source registries, browsers, and signing devices are separate trust boundaries. Self-hosting gives you control over code, keys, RPCs, and logs; it does not eliminate external dependencies. See the [review model](docs/REVIEW-MODEL.md) for the exact boundaries.

## Tests and project policy

```sh
npm test
npm run test:fuzz
npm run test:coverage
```

The **Tests and audit** badge reports the pull request and `main` verification workflow. The **Build and deploy** badge reports the separate production workflow; it can fail even when tests pass. Neither badge claims 100% coverage or universal provider availability. Automated tests use controlled providers; live endpoint observations are documented separately.

All changes to `main` go through a pull request and CI. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the process and [SECURITY.md](SECURITY.md) to report a vulnerability privately. The project is [MIT licensed](LICENSE). Third-party chain logos remain the property of their owners; see [asset licenses](web/assets/chains/LICENSE).
