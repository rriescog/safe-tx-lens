# Community service deployment

The VPS serves the same read-only Safe lookup and decoding workflow as the local app. A visitor can enter a previously unseen queued Safe transaction hash, executed hash, Safe URL, Safe address, or JSON. Safe Transaction Service is the primary proposal source. Tenderly monitor storage is never queried by the hosted service. Network auto-detection checks supported chains; an address on multiple chains requires the visitor to choose one.

The web UI and hosted `/mcp` endpoint share one persistent daily/monthly unit budget and per-IP daily request count. Default reservations are 600 units/day, 10,000/month, and 20 requests/day/IP; an automatic cross-chain lookup costs more than a JSON decode. This is a conservative estimate of upstream work, **not** an exact Safe API counter. HTTP 429 returns `Retry-After` and a wait time. One request runs at a time. The IP is salted and held only in memory for that day; quota files contain aggregate counters. Restarting the app resets the per-IP counters. Run one app replica; multiple replicas would need a shared atomic quota store.

Optional Tenderly simulation is invoked only by the web user on one selected transaction. It needs a **separate community Tenderly project and key**, never a personal or corporate monitor project. If not configured, the public interface says simulation is unavailable. If configured, it gets one simulation/day/IP and 100/month globally by default, in addition to the shared request budget. A simulation sends calldata and signatures to Tenderly, and results describe one execution path at one chain state.

## Provision

1. Prepare a Linux VPS with Docker Engine and Compose, inbound 80/443, a DNS A/AAAA record, and a non-root deploy user with Docker permission.
2. Create a dedicated Safe Builder API key for this community service. Do not reuse the current personal or Polygon key. On the VPS, place its value in `~/safe-tx-lens/safe-api-key` with permissions `0600`; this file is mounted as a Docker secret and is never copied from the repository or put into GitHub Actions logs.
3. Set GitHub repository variables `DEPLOY_ENABLED=true`, `DEPLOY_DOMAIN`, `DEPLOY_HOST`, `DEPLOY_USER`; set secrets `DEPLOY_SSH_KEY`, `DEPLOY_KNOWN_HOSTS`, `GHCR_READ_TOKEN`. Leave `DEPLOY_ENABLED` unset until the VPS, DNS, and dedicated key exist.
4. To enable simulation, create a dedicated community Tenderly project and put its access key in `~/safe-tx-lens/tenderly-access-key` with permissions `0600`. Set repository variables `DEPLOY_TENDERLY_ENABLED=true`, `DEPLOY_TENDERLY_ACCOUNT`, and `DEPLOY_TENDERLY_PROJECT`. CI then includes `compose.tenderly.yaml` on each deployment. The default Compose file leaves Tenderly off.

CI runs tests, dependency audit and Compose validation. A successful `main` push publishes an immutable GHCR image. With deployment enabled, CI copies the Compose/Caddy configuration and starts that digest behind automatic HTTPS. It checks that the Safe key file already exists; the deployment never creates or overwrites it. Caddy overwrites `X-Client-IP` with the actual connecting IP, and the app container has no public port. `/mcp` permits only read-only lookup tools and uses the same quota gate as `/api/inspect`; it exposes no caller-supplied RPC URL or polling control.

After deployment, check `https://YOUR_DOMAIN/healthz`, a previously unseen queued Safe hash, a Safe queue, and one MCP `tools/list`. For rollback, set `IMAGE` in `~/safe-tx-lens/.env` to a previous digest and run `docker compose --env-file .env -f compose.yaml up -d`.

The app limits JSON bodies to 256 KiB and has a 15-second request timeout. The public interface has no 30-second watch control. The Safe API, RPC, Sourcify and optional Tenderly remain external trust boundaries; a matching hash proves consistency of fields, not benign contract behavior.
