# Public demo deployment

The local CLI, UI, and stdio MCP are the full product. The VPS runs a small public demo without owner credentials or Tenderly simulation. It accepts an explicit chain, uses public RPCs and anonymous Safe services, and reserves at most five inspection requests per UTC day by default. The durable global budget protects the anonymous quota across restarts; it is **not** a per-user entitlement. It counts requests rather than upstream subrequests, so lower the limit if provider usage is high. A corrupt quota file fails closed. Run exactly one app replica because the file gate is process-local.

The deployed demo does **not** expose MCP. Each external user runs the stdio MCP from their own checkout and supplies their own Safe or Tenderly credentials when needed. A hosted MCP would require separate authentication, identity-scoped quotas, and an upstream request budget before accepting other users.

## VPS prerequisites

- Linux VPS with Docker Engine and Compose plugin, inbound 80/443, DNS A/AAAA record for the domain, and a non-root deploy user able to run Docker.
- That user can read the private GHCR image with a **read-only** package token. Do not copy `SAFE_API_KEY`, `TENDERLY_ACCESS_KEY`, Etherscan keys, or paid RPC URLs to this VPS.
- Pin the VPS SSH host key in GitHub secret `DEPLOY_KNOWN_HOSTS`. Verify it out of band; do not trust a key fetched during the workflow run.

Set these GitHub repository variables: `DEPLOY_ENABLED=true`, `DEPLOY_DOMAIN`, `DEPLOY_HOST`, `DEPLOY_USER`. Set repository or production environment secrets: `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `GHCR_READ_TOKEN`. The token needs only package read access. Protect the `production` environment if you want a human deployment gate. Leave `DEPLOY_ENABLED` unset until the VPS and DNS exist.

On pull requests CI runs tests, a production dependency audit, and Compose validation. A successful push to `main` builds a container and publishes it to GHCR. Once enabled, the deployment job copies the two Compose files, logs into GHCR, and starts the **immutable image digest** behind Caddy's automatic HTTPS. The quota file lives in a Docker volume and survives image updates. No application API key is passed to the container.

Check the deployment with `curl -fsS https://YOUR_DOMAIN/healthz` and one normal inspection in the UI. If a new image is unhealthy, set `IMAGE` in `~/safe-tx-lens/.env` to the prior digest and run `docker compose --env-file .env -f compose.yaml up -d`. Keep the prior digest from the GitHub Actions run or GHCR package history.

The public demo is intentionally conservative: no simulation, no automatic cross-chain search for bare hashes or addresses, no polling control, no bulk target verification, and no combined pending/history query. It returns at most five transactions from one scope per request. It permits one active inspection at a time, caps JSON bodies at 256 KiB, and has a 15 second HTTP request timeout. The global daily budget is five requests by default, including failed upstream lookups; an Origin header is a browser safeguard, not authentication. Keep the public container free of owner credentials. The local version can use a private RPC, Safe key, Tenderly account, and its local watch control; those stay in the user's environment.
