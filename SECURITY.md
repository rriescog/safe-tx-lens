# Security policy

Security fixes target the latest code on `main`. Older commits and self-hosted deployments may need to update separately.

Please report exploitable vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/rriescog/safe-tx-lens/security/advisories/new) when available, or contact the repository owner through a private channel. Do not open a public issue or PR containing an exploit before maintainers can respond. Include the affected component, a minimal reproduction, impact, and any relevant version or commit. Do not include private keys, API tokens, or sensitive transaction data.

The web interface, hosted MCP endpoint, CLI, decoding and verification pipeline, and deployment configuration are in scope. A provider outage or an unverified call is not automatically a vulnerability; report a case where the tool incorrectly claims evidence passed or exposes a secret as a security issue.

This tool is read-only. Never enter a seed phrase or private key. Check critical transactions with an independent implementation and the signing device's display. A matching hash, verified source, or successful simulation is not a guarantee of safe behavior.
