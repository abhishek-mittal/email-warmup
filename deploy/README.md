# EmailWarm — Staging Deployment

Self-contained Docker Compose stack on the ishosting VPS, behind the existing
system Caddy. Built and shipped by GitHub Actions from the `staging` Environment.
See the design spec: `docs/superpowers/specs/2026-10-04-staging-deployment-design.md`.

## Topology

- `stg-ew.webnco.xyz` → Caddy (:443) → frontend `127.0.0.1:3100`
- backend / postgres / redis: internal to the `emailwarm` compose network only
- Coexists with dmphub's `probe.emailtechno.com` — that config is never touched

Ports are pinned by the compose file (`environment:`): backend `4611`, frontend
`3100`. Do **not** add a `PORT` key to `staging.env` — the frontend and backend
share that file and would bind the same port.

## One-time operator setup

1. **DNS:** `A stg-ew.webnco.xyz → <VPS public IP>` (must resolve before first
   deploy, or Caddy's ACME cert issuance fails).
2. **OAuth redirect URIs:**
   - Google: `https://stg-ew.webnco.xyz/api/mailbox-oauth/callback/google`
   - Microsoft: `https://stg-ew.webnco.xyz/api/mailbox-oauth/callback/microsoft`
3. **Citadel (Zitadel):** app for stg-ew; capture `ZITADEL_CLIENT_ID` /
   `ZITADEL_CLIENT_SECRET`; issuer is `https://id.webnco.xyz`.
4. **GHCR token:** a PAT with `read:packages` → GitHub secret `GHCR_PULL_TOKEN`.
5. **SSH deploy key:** generate a CI-only keypair; add the public key to the
   box's `~/.ssh/authorized_keys`; store the private key as `EMAILWARM_DEPLOY_KEY`.
6. **GitHub `staging` Environment:** populate it with the sync script (below)
   rather than by hand. Fill `deploy/.env.staging` and run
   `bash deploy/sync-staging-env.sh`.
7. **Bootstrap the box:** copy `deploy/bootstrap-staging.sh` to the VPS and run
   `sudo bash bootstrap-staging.sh`.

## Syncing env to GitHub (`deploy/sync-staging-env.sh`)

The GitHub `staging` Environment is fed from a local file — edit it and re-run
the sync any time.

```bash
cp deploy/.env.staging.example deploy/.env.staging   # gitignored; never committed
# fill in real values; point EMAILWARM_DEPLOY_KEY_FILE at your CI SSH private key
bash deploy/sync-staging-env.sh --dry-run            # preview (no writes)
bash deploy/sync-staging-env.sh                      # apply
```

The script creates the `staging` Environment if needed, then pushes each key as
a **secret** or **variable** (classification fixed in the script, matching how
`deploy-staging.yml` reads `secrets.X` vs `vars.X`). Values are piped via stdin,
so secrets never appear in argv or shell history. Empty keys are skipped. The
multiline SSH deploy key is read from the path in `EMAILWARM_DEPLOY_KEY_FILE`.
Requires `gh` authenticated with `repo` + `workflow` scope.

Every app key must end up non-empty before the first deploy — the backend's env
validation crash-loops the container otherwise, even in demo mode.

## Deploy

Push to the `staging` branch (path-filtered) or run the **Deploy staging**
workflow manually. It builds both images → GHCR, renders
`/etc/emailwarm/staging.env`, ships the compose file, pulls + `up -d`, health-
checks the frontend, and reloads Caddy.

## Operations

```bash
# on the box:
cd /opt/emailwarm
docker compose -f docker-compose.staging.yml ps
docker compose -f docker-compose.staging.yml logs -f backend
docker compose -f docker-compose.staging.yml exec backend sh

# DB backup (manual; automate later):
docker compose -f docker-compose.staging.yml exec -T postgres \
  pg_dump -U emailwarm emailwarm | gzip > ~/emailwarm-$(date +%F).sql.gz
```

## Rollback

Re-run the workflow with an older commit SHA as the `image_tag` input
(workflow_dispatch), or on the box:
`IMAGE_TAG=<old-sha> docker compose -f docker-compose.staging.yml up -d`.
