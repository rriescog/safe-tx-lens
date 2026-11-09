# Contributing

Safe Tx Lens is an open-source security review aid. Bug reports, reproducible network examples, documentation corrections, and implementation proposals can be submitted through GitHub. Public PRs are proposals; only repository maintainers can merge them.

## Before opening a pull request

1. Open an issue for behavior changes or a new provider integration so its evidence and cost can be reviewed.
2. Work on a branch and submit a PR against `main`. Do not commit credentials, private transaction details, or copied proprietary source.
3. Explain what changed, why, how it was tested, and what evidence remains unavailable. For a network claim, include a public transaction or a bounded endpoint probe with the observation date.
4. Run `npm ci`, `npm test`, and `npm run test:fuzz`. Add a focused test when behavior changes. Do not use a passing test as proof that a live provider or every Safe transaction is supported.

The `quality` check runs tests, the dependency audit, and deployment-configuration validation on each PR. Production publish and deploy run only after a change reaches `main`. Maintainers review security-sensitive changes and may decline a PR even when CI passes. No contributor should push directly to `main` or bypass required checks.

For a vulnerability, use the private process in [SECURITY.md](SECURITY.md), not a public issue or PR.
