# Staging Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a fully self-contained Docker Compose staging stack (Next.js frontend + NestJS backend/workers + Postgres + Redis) for EmailWarm onto the existing ishosting VPS behind its system Caddy, built and deployed by GitHub Actions from a `staging` Environment.

**Architecture:** CI builds two images (backend, frontend) and pushes to GHCR. A deploy job renders `/etc/emailwarm/staging.env` from the GitHub `staging` Environment, ships it + the compose file over SSH, pulls images on the box, and runs `docker compose up -d`. Only the frontend is published (host `127.0.0.1:3100`), fronted by a new Caddy site block for `stg-ew.webnco.xyz`. Backend, Postgres, and Redis stay internal to the compose network. A one-shot `migrate` service applies Drizzle migrations before the backend starts.

**Tech Stack:** Docker + Docker Compose, GitHub Actions, GHCR, Caddy (existing), pnpm 10, Node 22, NestJS, Next.js 15 (standalone output), Postgres 16, Redis 7, Drizzle ORM.

**Spec:** `docs/superpowers/specs/2026-10-04-staging-deployment-design.md`

## Global Constraints

- Staging FQDN: `stg-ew.webnco.xyz` (verbatim; used for `APP_URL`, `BETTER_AUTH_URL`, `NEXT_PUBLIC_*`, OAuth redirect base).
- Node 22, pnpm 10 (via `corepack`) in all image builds and CI.
- Backend runtime entry: `node dist/src/main`. Migration entry: `node dist/src/db/migrate`.
- Migration SQL files live at `backend/src/db/migrations` and MUST be present at `dist/src/db/migrations` in the backend image (`nest build` does not copy `.sql`).
- Frontend already sets `output: "standalone"` in `next.config.ts` — do not remove.
- Host ports used on the box: frontend `127.0.0.1:3100` only. `3001`/`8080` belong to dmphub and must not be touched. Postgres/Redis/backend get NO host ports.
- Only ports 22 + 443 open externally; everything else via Caddy. The existing `probe.emailtechno.com` Caddy config must remain untouched.
- Secrets never committed. Source of truth = GitHub `staging` Environment. CI renders `/etc/emailwarm/staging.env` (mode 600).
- GHCR image names: `ghcr.io/abhishek-mittal/emailwarm-backend`, `ghcr.io/abhishek-mittal/emailwarm-frontend`.
- Billing out of scope: `DEMO_MODE=true`, Stripe vars omitted.
- Not Terraform. No changes to the dmphub probe-host stack.

## Review Focus

- **Backend image missing migration SQL** → `migrate` service runs but applies nothing / errors "no migrations folder"; schema never created, backend crashes on first query. Pinned in Task 1 (verify `dist/src/db/migrations/*.sql` present in image).
- **Frontend `NEXT_PUBLIC_*` baked wrong at build time** → browser calls `localhost` or the wrong origin, every API/auth call fails only in the deployed app. Pinned in Task 2 (assert the built standalone bundle contains the staging origin, not localhost).
- **Compose starts backend before migrations finish** → race: backend queries a schema that isn't there yet. Pinned in Task 3 (`depends_on: migrate: service_completed_successfully`, asserted via `docker compose config`).
- **Caddy deploy clobbers the probe host site** → `probe.emailtechno.com` goes down. Pinned in Task 4 (additive fragment + `caddy validate`; Task 7 never overwrites the base Caddyfile, only adds/updates the emailwarm fragment).
- **Env file world-readable or missing a required var** → secret leak, or container boot-loop with an opaque error. Pinned in Task 6 (`.env.staging.example` lists every required key) and Task 7 (`chmod 600`, and a pre-up check that no `REPLACE_` markers remain).

---

### Task 1: Backend image (Dockerfile + .dockerignore, with migrations)

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

**Interfaces:**
- Produces: image runnable as `node dist/src/main` (API + in-process BullMQ workers) and `node dist/src/db/migrate` (one-shot migrator). Listens on `$PORT` (default 4611). Migration SQL at `dist/src/db/migrations`.

- [ ] **Step 1: Write `backend/.dockerignore`**

```
node_modules
dist
.git
.env
.env.*
*.log
coverage
test
**/*.spec.ts
```

- [ ] **Step 2: Write `backend/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- deps + build ---
FROM base AS build
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# nest build does not copy .sql — migrator resolves ./migrations next to the
# compiled file (dist/src/db/migrate.js), so place the SQL there explicitly.
RUN cp -r src/db/migrations dist/src/db/migrations

# --- production deps only ---
FROM base AS proddeps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# --- runtime ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 --create-home appuser
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER appuser
EXPOSE 4611
CMD ["node", "dist/src/main"]
```

- [ ] **Step 3: Build the image**

Run: `cd backend && docker build -t emailwarm-backend:test .`
Expected: build succeeds, no errors.

- [ ] **Step 4: Verify migrations shipped and entrypoints resolve**

Run:
```bash
docker run --rm emailwarm-backend:test sh -c "ls dist/src/db/migrations/*.sql | head && ls dist/src/main.js dist/src/db/migrate.js"
```
Expected: lists at least one `.sql` file and both JS entrypoints. (The migrate run itself needs a DB — exercised in Task 3.)

- [ ] **Step 5: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore
git commit -m "chore(deploy): add backend Dockerfile with migrations baked in"
```

---

### Task 2: Frontend image (Dockerfile + .dockerignore, standalone)

**Files:**
- Create: `frontend/Dockerfile`
- Create: `frontend/.dockerignore`
- Verify (no edit): `frontend/next.config.ts` already has `output: "standalone"`.

**Interfaces:**
- Produces: image runnable as `node server.js`, listening on `3100` (`PORT=3100`, `HOSTNAME=0.0.0.0`). `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_BETTER_AUTH_URL` are baked at build from `--build-arg`.
- Consumes: at runtime reaches backend via `API_URL=http://backend:4611` (server-side).

- [ ] **Step 1: Write `frontend/.dockerignore`**

```
node_modules
.next
.git
.env
.env.*
*.log
coverage
```

- [ ] **Step 2: Write `frontend/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- deps ---
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# --- build (NEXT_PUBLIC_* must be present at build time) ---
FROM base AS build
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_BETTER_AUTH_URL=$NEXT_PUBLIC_BETTER_AUTH_URL
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# --- runtime (standalone) ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1001 --create-home appuser
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
USER appuser
EXPOSE 3100
CMD ["node", "server.js"]
```

- [ ] **Step 3: Build with the staging origin baked in**

Run:
```bash
cd frontend && docker build \
  --build-arg NEXT_PUBLIC_API_URL=https://stg-ew.webnco.xyz \
  --build-arg NEXT_PUBLIC_BETTER_AUTH_URL=https://stg-ew.webnco.xyz \
  -t emailwarm-frontend:test .
```
Expected: build succeeds.

- [ ] **Step 4: Verify the staging origin is baked into the bundle (not localhost)**

Run:
```bash
docker run --rm emailwarm-frontend:test sh -c "grep -rl 'stg-ew.webnco.xyz' .next/static >/dev/null && echo FOUND_STAGING_ORIGIN"
```
Expected: prints `FOUND_STAGING_ORIGIN`. (Confirms `NEXT_PUBLIC_*` baked correctly; if a build arg were missing, the staging origin would be absent.)

- [ ] **Step 5: Commit**

```bash
git add frontend/Dockerfile frontend/.dockerignore
git commit -m "chore(deploy): add frontend Dockerfile (standalone, staging build args)"
```

---

### Task 3: Compose stack (`deploy/docker-compose.staging.yml`)

**Files:**
- Create: `deploy/docker-compose.staging.yml`

**Interfaces:**
- Consumes: images `ghcr.io/abhishek-mittal/emailwarm-{backend,frontend}:${IMAGE_TAG}`, env file `/etc/emailwarm/staging.env`, and `POSTGRES_PASSWORD` + `IMAGE_TAG` from the shell/.env.
- Produces: running services; frontend published at `127.0.0.1:3100`. Service DNS names `postgres`, `redis`, `backend` on network `emailwarm`.

- [ ] **Step 1: Write `deploy/docker-compose.staging.yml`**

```yaml
name: emailwarm

services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: emailwarm
      POSTGRES_USER: emailwarm
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U emailwarm -d emailwarm"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [emailwarm]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [emailwarm]

  migrate:
    image: ghcr.io/abhishek-mittal/emailwarm-backend:${IMAGE_TAG:-staging}
    command: ["node", "dist/src/db/migrate"]
    env_file: /etc/emailwarm/staging.env
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"
    networks: [emailwarm]

  backend:
    image: ghcr.io/abhishek-mittal/emailwarm-backend:${IMAGE_TAG:-staging}
    restart: unless-stopped
    env_file: /etc/emailwarm/staging.env
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:4611/health"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    networks: [emailwarm]

  frontend:
    image: ghcr.io/abhishek-mittal/emailwarm-frontend:${IMAGE_TAG:-staging}
    restart: unless-stopped
    env_file: /etc/emailwarm/staging.env
    ports:
      - "127.0.0.1:3100:3100"
    depends_on:
      backend:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://127.0.0.1:3100/"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    networks: [emailwarm]

volumes:
  pgdata:
  redisdata:

networks:
  emailwarm:
    name: emailwarm
```

- [ ] **Step 2: Validate compose structure and the migrate ordering**

Run:
```bash
POSTGRES_PASSWORD=x IMAGE_TAG=staging docker compose \
  -f deploy/docker-compose.staging.yml config >/tmp/ew-compose.yml \
  && grep -A3 'depends_on' /tmp/ew-compose.yml | grep -q 'service_completed_successfully' \
  && echo OK_MIGRATE_GATE
```
Expected: prints `OK_MIGRATE_GATE` (validates YAML and that backend waits on migrate completion). The `env_file` path not existing locally is fine — `config` does not require it to exist on this machine with recent Compose; if it errors on the missing file, create an empty `/tmp/staging.env` and add `--env-file`-style override is not needed, instead temporarily point `env_file` to `./deploy/.env.example` only for this check, then revert. Prefer the first form.

- [ ] **Step 3: Full local smoke (migrations apply, backend boots)**

Run (uses the Task 1/2 local images, retagged to the compose names):
```bash
docker tag emailwarm-backend:test ghcr.io/abhishek-mittal/emailwarm-backend:staging
docker tag emailwarm-frontend:test ghcr.io/abhishek-mittal/emailwarm-frontend:staging
sudo mkdir -p /etc/emailwarm 2>/dev/null || mkdir -p ./deploy/local-etc
# Minimal env for a local smoke (no real secrets needed to prove boot+migrate):
cat > ./deploy/local-smoke.env <<'EOF'
DATABASE_URL=postgresql://emailwarm:localsmoke@postgres:5432/emailwarm
REDIS_URL=redis://redis:6379/1
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000
BETTER_AUTH_SECRET=local-smoke-secret-at-least-32-chars-long
INTERNAL_SECRET=local-smoke-internal-16+
APP_URL=http://localhost:3100
PORT=4611
DEMO_MODE=true
LOG_LEVEL=info
API_URL=http://backend:4611
EOF
POSTGRES_PASSWORD=localsmoke IMAGE_TAG=staging \
  docker compose -f deploy/docker-compose.staging.yml \
  --env-file /dev/null up -d postgres redis
# wait for pg healthy, then run migrate against the local env file:
sleep 8
POSTGRES_PASSWORD=localsmoke IMAGE_TAG=staging \
  docker compose -f deploy/docker-compose.staging.yml run --rm \
  -v "$PWD/deploy/local-smoke.env:/etc/emailwarm/staging.env:ro" migrate
```
Expected: migrate container prints `migrations applied` and exits 0.
Teardown:
```bash
docker compose -f deploy/docker-compose.staging.yml down -v
rm -f deploy/local-smoke.env
```

> Note: this step needs Docker locally. If the implementer has no local Docker, mark Step 3 as deferred-to-CI and rely on Task 7's post-deploy health gate — but Step 2 (config validation) is mandatory regardless.

- [ ] **Step 4: Commit**

```bash
git add deploy/docker-compose.staging.yml
git commit -m "chore(deploy): add self-contained staging compose stack"
```

---

### Task 4: Caddy site block (`deploy/caddy/stg-ew.caddy`)

**Files:**
- Create: `deploy/caddy/stg-ew.caddy`

**Interfaces:**
- Produces: an additive Caddy site block for `stg-ew.webnco.xyz` → `127.0.0.1:3100`. Installed as a standalone fragment the deploy imports into the box's Caddyfile; never replaces the probe host config.

- [ ] **Step 1: Write `deploy/caddy/stg-ew.caddy`**

```
# EmailWarm staging — additive Caddy site block. Fronted by the same
# system Caddy that serves probe.emailtechno.com; this file is installed
# at /etc/caddy/sites/stg-ew.caddy and pulled in by an `import sites/*`
# line in /etc/caddy/Caddyfile (added once during bootstrap). Public app,
# no basic auth. TLS auto-provisioned by Caddy once the A record resolves.
stg-ew.webnco.xyz {
	encode gzip
	reverse_proxy 127.0.0.1:3100
}
```

- [ ] **Step 2: Validate the fragment with Caddy**

Run (uses the Caddy image so no local install needed):
```bash
docker run --rm -v "$PWD/deploy/caddy/stg-ew.caddy:/f.caddy:ro" caddy:2 \
  caddy validate --adapter caddyfile --config /f.caddy
```
Expected: `Valid configuration`.

- [ ] **Step 3: Commit**

```bash
git add deploy/caddy/stg-ew.caddy
git commit -m "chore(deploy): add Caddy site block for stg-ew.webnco.xyz"
```

---

### Task 5: Box bootstrap script (`deploy/bootstrap-staging.sh`)

**Files:**
- Create: `deploy/bootstrap-staging.sh`

**Interfaces:**
- Produces: a one-time, idempotent box setup (Docker Engine + compose plugin, `/opt/emailwarm`, `/etc/emailwarm/staging.env` placeholder, `import sites/*` wired into the Caddyfile). Run by the operator as root.

- [ ] **Step 1: Write `deploy/bootstrap-staging.sh`**

```bash
#!/usr/bin/env bash
# One-time, idempotent setup for the EmailWarm staging stack on the
# ishosting VPS. Run ONCE as root. Safe to re-run after a failure.
#
#   sudo bash bootstrap-staging.sh
#
# Leaves the box with:
#   - Docker Engine + compose plugin
#   - /opt/emailwarm            (compose file lands here on deploy)
#   - /etc/emailwarm/staging.env (mode 600 placeholder; CI overwrites it)
#   - /etc/caddy/sites/          and an `import sites/*` line in the Caddyfile
#     (so the EmailWarm site block loads WITHOUT touching the probe config)
set -euo pipefail
log() { printf '[bootstrap-staging] %s\n' "$*" >&2; }

if [ "$(id -u)" -ne 0 ]; then log "must run as root"; exit 1; fi

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker + compose already present: $(docker --version)"; return 0
  fi
  log "installing Docker Engine + compose plugin"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
}

make_dirs() {
  log "creating /opt/emailwarm and /etc/emailwarm"
  mkdir -p /opt/emailwarm /etc/emailwarm
  chmod 700 /etc/emailwarm
}

seed_env() {
  if [ -f /etc/emailwarm/staging.env ]; then
    log "/etc/emailwarm/staging.env already exists — leaving it"; return 0
  fi
  log "writing placeholder /etc/emailwarm/staging.env (CI overwrites on deploy)"
  cat > /etc/emailwarm/staging.env <<'EOF'
# Placeholder — the deploy workflow overwrites this from the GitHub
# `staging` Environment. Documented in deploy/.env.staging.example.
DATABASE_URL=postgresql://emailwarm:REPLACE_BEFORE_ENABLING@postgres:5432/emailwarm
REDIS_URL=redis://redis:6379/1
ENCRYPTION_KEY=REPLACE_BEFORE_ENABLING
BETTER_AUTH_SECRET=REPLACE_BEFORE_ENABLING
INTERNAL_SECRET=REPLACE_BEFORE_ENABLING
APP_URL=https://stg-ew.webnco.xyz
PORT=4611
DEMO_MODE=true
LOG_LEVEL=info
API_URL=http://backend:4611
POSTGRES_PASSWORD=REPLACE_BEFORE_ENABLING
EOF
  chmod 600 /etc/emailwarm/staging.env
}

wire_caddy_import() {
  if [ ! -f /etc/caddy/Caddyfile ]; then
    log "WARNING: /etc/caddy/Caddyfile not found — is Caddy installed? Skipping import wiring."
    return 0
  fi
  mkdir -p /etc/caddy/sites
  if grep -qE '^\s*import\s+sites/\*' /etc/caddy/Caddyfile; then
    log "Caddyfile already imports sites/* — leaving it"
  else
    log "adding 'import sites/*' to the top of /etc/caddy/Caddyfile"
    printf 'import sites/*\n\n%s' "$(cat /etc/caddy/Caddyfile)" > /etc/caddy/Caddyfile.new
    mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile
  fi
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 \
    && log "Caddyfile still valid after import wiring" \
    || log "WARNING: Caddyfile failed validation — review manually before reload"
}

main() {
  install_docker
  make_dirs
  seed_env
  wire_caddy_import
  log "bootstrap complete. Next:"
  log "  1. Point DNS: A stg-ew.webnco.xyz -> this VPS public IP."
  log "  2. Populate the GitHub 'staging' Environment (see deploy/.env.staging.example)."
  log "  3. Add the SSH deploy key to this box; set EMAILWARM_* secrets in GitHub."
  log "  4. Push to the 'staging' branch (or run the workflow manually) to deploy."
}
main "$@"
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n deploy/bootstrap-staging.sh && echo OK_SYNTAX`
Expected: prints `OK_SYNTAX`.

- [ ] **Step 3: Lint if shellcheck is available (non-blocking)**

Run: `command -v shellcheck >/dev/null && shellcheck deploy/bootstrap-staging.sh || echo "shellcheck not installed, skipping"`
Expected: no errors, or the skip message.

- [ ] **Step 4: Commit**

```bash
chmod +x deploy/bootstrap-staging.sh
git add deploy/bootstrap-staging.sh
git commit -m "chore(deploy): add idempotent box bootstrap for staging"
```

---

### Task 6: Env example + deploy runbook (`deploy/.env.staging.example`, `deploy/README.md`)

**Files:**
- Create: `deploy/.env.staging.example`
- Create: `deploy/README.md`

**Interfaces:**
- Produces: the authoritative list of every env key (for the GitHub Environment and the rendered box file) and the operator runbook. No secrets.

- [ ] **Step 1: Write `deploy/.env.staging.example`**

```bash
# EmailWarm staging environment — authoritative key list.
# Real values live in the GitHub `staging` Environment and are rendered
# by the deploy workflow into /etc/emailwarm/staging.env on the box.
# NEVER commit real secrets. Service hostnames (postgres/redis/backend)
# are the compose network DNS names — do not change them.

# --- infra / compose ---
POSTGRES_PASSWORD=                 # secret; also used to build DATABASE_URL
IMAGE_TAG=staging                  # set by CI to the commit SHA

# --- backend ---
DATABASE_URL=postgresql://emailwarm:${POSTGRES_PASSWORD}@postgres:5432/emailwarm
REDIS_URL=redis://redis:6379/1
ENCRYPTION_KEY=                    # secret; 32-byte hex
BETTER_AUTH_SECRET=               # secret; 32+ chars (shared with frontend)
INTERNAL_SECRET=                  # secret; 16+ chars (shared with frontend)
ANTHROPIC_API_KEY=               # secret
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=            # secret
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=         # secret
PLATFORM_SMTP_HOST=
PLATFORM_SMTP_PORT=587
PLATFORM_SMTP_USER=
PLATFORM_SMTP_PASS=              # secret
PLATFORM_FROM_EMAIL=EmailWarm <noreply@emailwarm.io>
APP_URL=https://stg-ew.webnco.xyz
PORT=4611
CORS_ORIGINS=https://stg-ew.webnco.xyz
LOG_LEVEL=info
DEMO_MODE=true
DEMO_INBOX_CREDITS=10
DEMO_PLACEMENT_CREDITS=5

# --- frontend ---
API_URL=http://backend:4611
NEXT_PUBLIC_API_URL=https://stg-ew.webnco.xyz
BETTER_AUTH_URL=https://stg-ew.webnco.xyz
NEXT_PUBLIC_BETTER_AUTH_URL=https://stg-ew.webnco.xyz
ZITADEL_ISSUER=https://id.webnco.xyz
ZITADEL_CLIENT_ID=
ZITADEL_CLIENT_SECRET=           # secret
FOUNDER_EMAILS=
```

- [ ] **Step 2: Write `deploy/README.md`**

````markdown
# EmailWarm — Staging Deployment

Self-contained Docker Compose stack on the ishosting VPS, behind the existing
system Caddy. Built and shipped by GitHub Actions from the `staging` Environment.
See the design spec: `docs/superpowers/specs/2026-10-04-staging-deployment-design.md`.

## Topology

- `stg-ew.webnco.xyz` → Caddy (:443) → frontend `127.0.0.1:3100`
- backend / postgres / redis: internal to the `emailwarm` compose network only
- Coexists with dmphub's `probe.emailtechno.com` — that config is never touched

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
6. **GitHub `staging` Environment:** add every key from `.env.staging.example`
   (secrets vs variables per the spec), plus `EMAILWARM_HOST_IP`,
   `EMAILWARM_DEPLOY_KEY`, `GHCR_PULL_TOKEN`, `POSTGRES_PASSWORD`.
7. **Bootstrap the box:** copy `deploy/bootstrap-staging.sh` to the VPS and run
   `sudo bash bootstrap-staging.sh`.

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

Re-run the workflow with an older commit SHA as `IMAGE_TAG` (workflow_dispatch
input), or on the box: `IMAGE_TAG=<old-sha> docker compose -f
docker-compose.staging.yml up -d`.
````

- [ ] **Step 3: Verify the example lists every var the app reads**

Run:
```bash
# Every process.env key referenced in frontend/src must appear in the example
# (minus NEXT_PUBLIC build-only duplicates, which are present too):
comm -23 \
  <(grep -rhoE "process\.env\.[A-Z0-9_]+" frontend/src backend/src | sed 's/process\.env\.//' | sort -u) \
  <(grep -oE '^[A-Z0-9_]+' deploy/.env.staging.example | sort -u) \
  | grep -vE '^(NODE_ENV|MIGRATION_DATABASE_URL|MIGRATIONS_DIR|MAIL_ALLOW_INSECURE_TRANSPORT|MAIL_EGRESS_ALLOWLIST|SPAMHAUS_DQS_KEY|STRIPE_|HOSTNAME)' \
  > /tmp/ew-missing-env.txt || true
test ! -s /tmp/ew-missing-env.txt && echo "OK_ALL_ENV_DOCUMENTED" || (echo "MISSING:"; cat /tmp/ew-missing-env.txt)
```
Expected: prints `OK_ALL_ENV_DOCUMENTED`. If it lists keys, add each to `.env.staging.example` (or extend the allowlist above only for genuinely optional/out-of-scope vars like Stripe/demo-only toggles), then re-run.

- [ ] **Step 4: Commit**

```bash
git add deploy/.env.staging.example deploy/README.md
git commit -m "docs(deploy): add staging env example and runbook"
```

---

### Task 7: Deploy workflow (`.github/workflows/deploy-staging.yml`)

**Files:**
- Create: `.github/workflows/deploy-staging.yml`

**Interfaces:**
- Consumes: the `staging` Environment's secrets + variables; the Dockerfiles (Task 1/2), compose (Task 3), Caddy fragment (Task 4).
- Produces: images on GHCR tagged `:<sha>` and `:staging`; a running stack on the box; the Caddy fragment installed + reloaded.

- [ ] **Step 1: Write `.github/workflows/deploy-staging.yml`**

```yaml
name: Deploy staging

on:
  push:
    branches: [staging]
    paths:
      - "backend/**"
      - "frontend/**"
      - "deploy/**"
      - ".github/workflows/deploy-staging.yml"
  workflow_dispatch:
    inputs:
      image_tag:
        description: "Image tag to deploy (defaults to this run's commit SHA)"
        required: false

concurrency:
  group: emailwarm-staging-deploy
  cancel-in-progress: false

env:
  REGISTRY: ghcr.io
  BACKEND_IMAGE: ghcr.io/abhishek-mittal/emailwarm-backend
  FRONTEND_IMAGE: ghcr.io/abhishek-mittal/emailwarm-frontend

jobs:
  build:
    name: Build and push images
    runs-on: ubuntu-latest
    environment: staging
    permissions:
      contents: read
      packages: write
    outputs:
      image_tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4

      - id: meta
        run: echo "tag=${{ github.event.inputs.image_tag || github.sha }}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build + push backend
        uses: docker/build-push-action@v6
        with:
          context: ./backend
          push: true
          tags: |
            ${{ env.BACKEND_IMAGE }}:${{ steps.meta.outputs.tag }}
            ${{ env.BACKEND_IMAGE }}:staging
          cache-from: type=gha
          cache-to: type=gha,mode=max

      - name: Build + push frontend
        uses: docker/build-push-action@v6
        with:
          context: ./frontend
          push: true
          build-args: |
            NEXT_PUBLIC_API_URL=${{ vars.NEXT_PUBLIC_API_URL }}
            NEXT_PUBLIC_BETTER_AUTH_URL=${{ vars.NEXT_PUBLIC_BETTER_AUTH_URL }}
          tags: |
            ${{ env.FRONTEND_IMAGE }}:${{ steps.meta.outputs.tag }}
            ${{ env.FRONTEND_IMAGE }}:staging
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    name: Deploy to VPS
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4

      - name: Load deploy key
        uses: webfactory/ssh-agent@v0.9.0
        with:
          ssh-private-key: ${{ secrets.EMAILWARM_DEPLOY_KEY }}

      - name: Trust the VPS host key
        run: ssh-keyscan -H "${{ secrets.EMAILWARM_HOST_IP }}" >> ~/.ssh/known_hosts

      - name: Render staging.env
        run: |
          umask 077
          cat > staging.env <<EOF
          POSTGRES_PASSWORD=${{ secrets.POSTGRES_PASSWORD }}
          DATABASE_URL=postgresql://emailwarm:${{ secrets.POSTGRES_PASSWORD }}@postgres:5432/emailwarm
          REDIS_URL=redis://redis:6379/1
          ENCRYPTION_KEY=${{ secrets.ENCRYPTION_KEY }}
          BETTER_AUTH_SECRET=${{ secrets.BETTER_AUTH_SECRET }}
          INTERNAL_SECRET=${{ secrets.INTERNAL_SECRET }}
          ANTHROPIC_API_KEY=${{ secrets.ANTHROPIC_API_KEY }}
          GOOGLE_CLIENT_ID=${{ vars.GOOGLE_CLIENT_ID }}
          GOOGLE_CLIENT_SECRET=${{ secrets.GOOGLE_CLIENT_SECRET }}
          MICROSOFT_CLIENT_ID=${{ vars.MICROSOFT_CLIENT_ID }}
          MICROSOFT_CLIENT_SECRET=${{ secrets.MICROSOFT_CLIENT_SECRET }}
          PLATFORM_SMTP_HOST=${{ vars.PLATFORM_SMTP_HOST }}
          PLATFORM_SMTP_PORT=${{ vars.PLATFORM_SMTP_PORT }}
          PLATFORM_SMTP_USER=${{ vars.PLATFORM_SMTP_USER }}
          PLATFORM_SMTP_PASS=${{ secrets.PLATFORM_SMTP_PASS }}
          PLATFORM_FROM_EMAIL=${{ vars.PLATFORM_FROM_EMAIL }}
          APP_URL=https://stg-ew.webnco.xyz
          PORT=4611
          CORS_ORIGINS=https://stg-ew.webnco.xyz
          LOG_LEVEL=info
          DEMO_MODE=true
          DEMO_INBOX_CREDITS=${{ vars.DEMO_INBOX_CREDITS }}
          DEMO_PLACEMENT_CREDITS=${{ vars.DEMO_PLACEMENT_CREDITS }}
          API_URL=http://backend:4611
          NEXT_PUBLIC_API_URL=https://stg-ew.webnco.xyz
          BETTER_AUTH_URL=https://stg-ew.webnco.xyz
          NEXT_PUBLIC_BETTER_AUTH_URL=https://stg-ew.webnco.xyz
          ZITADEL_ISSUER=https://id.webnco.xyz
          ZITADEL_CLIENT_ID=${{ vars.ZITADEL_CLIENT_ID }}
          ZITADEL_CLIENT_SECRET=${{ secrets.ZITADEL_CLIENT_SECRET }}
          FOUNDER_EMAILS=${{ vars.FOUNDER_EMAILS }}
          EOF
          if grep -q 'REPLACE_BEFORE_ENABLING' staging.env; then
            echo "staging.env still has placeholders — aborting"; exit 1
          fi

      - name: Ship env + compose to the box
        env:
          HOST: root@${{ secrets.EMAILWARM_HOST_IP }}
        run: |
          ssh "$HOST" "mkdir -p /opt/emailwarm /etc/emailwarm /etc/caddy/sites"
          scp staging.env "$HOST:/etc/emailwarm/staging.env"
          ssh "$HOST" "chmod 600 /etc/emailwarm/staging.env"
          scp deploy/docker-compose.staging.yml "$HOST:/opt/emailwarm/docker-compose.staging.yml"
          scp deploy/caddy/stg-ew.caddy "$HOST:/etc/caddy/sites/stg-ew.caddy"
          rm -f staging.env

      - name: Pull + up + health check
        env:
          HOST: root@${{ secrets.EMAILWARM_HOST_IP }}
          IMAGE_TAG: ${{ needs.build.outputs.image_tag }}
          GHCR_PULL_TOKEN: ${{ secrets.GHCR_PULL_TOKEN }}
        run: |
          ssh "$HOST" bash -s <<REMOTE
          set -euo pipefail
          echo "${GHCR_PULL_TOKEN}" | docker login ghcr.io -u abhishek-mittal --password-stdin
          cd /opt/emailwarm
          export POSTGRES_PASSWORD="\$(grep '^POSTGRES_PASSWORD=' /etc/emailwarm/staging.env | cut -d= -f2-)"
          export IMAGE_TAG="${IMAGE_TAG}"
          docker compose -f docker-compose.staging.yml pull
          docker compose -f docker-compose.staging.yml up -d
          docker image prune -f
          echo "--- waiting for frontend health ---"
          for i in \$(seq 1 30); do
            if curl -fsS http://127.0.0.1:3100/ >/dev/null 2>&1; then echo "frontend healthy"; break; fi
            if [ "\$i" = "30" ]; then echo "frontend did not become healthy" >&2; \
              docker compose -f docker-compose.staging.yml logs --tail=50 frontend backend >&2; exit 1; fi
            sleep 2
          done
          REMOTE

      - name: Reload Caddy with the staging site block
        env:
          HOST: root@${{ secrets.EMAILWARM_HOST_IP }}
        run: |
          ssh "$HOST" bash -s <<'REMOTE'
          set -euo pipefail
          # Fragment already shipped to /etc/caddy/sites/. bootstrap wired the
          # `import sites/*` line. Validate the WHOLE config (never break probe),
          # then reload.
          if caddy validate --config /etc/caddy/Caddyfile; then
            systemctl reload caddy
            echo "Caddy reloaded with stg-ew site block"
          else
            echo "Caddyfile failed validation — NOT reloading" >&2
            exit 1
          fi
          REMOTE
```

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/deploy-staging.yml')); print('OK_YAML')"
```
Expected: prints `OK_YAML`.

- [ ] **Step 3: Lint with actionlint if available (non-blocking)**

Run: `command -v actionlint >/dev/null && actionlint .github/workflows/deploy-staging.yml || echo "actionlint not installed, skipping"`
Expected: no errors, or the skip message.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-staging.yml
git commit -m "ci(deploy): add build+deploy workflow for staging VPS"
```

---

### Task 8: Point project docs at the VPS staging target

**Files:**
- Modify: `docs/07-market-readiness/STATUS.md` (append a deployment note) — or create `docs/07-market-readiness/DEPLOYMENT.md` if STATUS is not the right home.

**Interfaces:**
- Produces: a short, truthful record that staging runs on the ishosting VPS via Docker (superseding the Cloud Run note for staging), pointing to the spec + runbook.

- [ ] **Step 1: Append a deployment note**

Add to `docs/07-market-readiness/STATUS.md` (new row/section):

```markdown
### Deployment (staging)

Staging runs as a self-contained Docker Compose stack (frontend + backend/workers
+ Postgres + Redis) on the ishosting VPS, behind the existing system Caddy, at
`https://stg-ew.webnco.xyz`. Built + deployed by `.github/workflows/deploy-staging.yml`
from the GitHub `staging` Environment. This supersedes the GCP Cloud Run topology
for staging. Design: `docs/superpowers/specs/2026-10-04-staging-deployment-design.md`.
Runbook: `deploy/README.md`.
```

- [ ] **Step 2: Verify the link targets exist**

Run:
```bash
test -f docs/superpowers/specs/2026-10-04-staging-deployment-design.md \
  && test -f deploy/README.md && echo OK_LINKS
```
Expected: prints `OK_LINKS`.

- [ ] **Step 3: Commit**

```bash
git add docs/07-market-readiness/STATUS.md
git commit -m "docs: record VPS staging deployment target"
```

---

## Notes for the executor

- **Branch:** work on the current feature branch (`feat/mr-warmup-core`) unless told otherwise. The workflow itself only *triggers* on the `staging` branch — creating/pushing that branch is an operator step, not part of these tasks.
- **Local Docker optional:** Tasks 1–4 have local build/validate steps. If no local Docker/Caddy, the YAML/compose/shell *static* checks (config, `bash -n`, `yaml.safe_load`, image-based `caddy validate`) are still mandatory; the live build/run steps may defer to CI, noted per task.
- **No secrets in git:** only `.env.staging.example` (placeholders) is committed. Never commit a real `staging.env`.
- **Do not touch** the dmphub probe-host files or the base `/etc/caddy/Caddyfile` site blocks — EmailWarm is strictly additive.
