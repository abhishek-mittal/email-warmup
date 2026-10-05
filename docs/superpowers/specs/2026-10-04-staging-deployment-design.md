# Staging deployment — self-contained Docker stack on the ishosting VPS

**Date:** 2026-10-04
**Status:** Approved (design) — pending implementation plan
**Author:** Abhishek Mittal (with Claude)
**Repo:** `abhishek-mittal/email-warmup` (submodule of shuhari)

---

## 1. Purpose & context

Stand up a **staging** environment for EmailWarm that is **fully self-contained**
(its own Docker Compose stack: app + Postgres + Redis), deployed to the **same
ishosting VPS** that already hosts the dmphub SMTP probe worker and provenance
dashboard. All configuration flows from a GitHub **`staging` Environment**;
nothing secret is committed.

This **supersedes** the GCP Cloud Run / Cloud SQL / Memorystore topology
described in `.claude/CLAUDE.md` *for staging only*. That document's infra table
describes the originally-intended production target; staging deliberately runs
self-hosted on the VPS to keep cost at zero and co-locate with the probe host.

### Key facts about the box (observed from `projects/dmphub/probe-host`)

- ishosting VPS, Ubuntu, reached as `root@<VPS_IP>` over SSH (key-based).
- **System Caddy** already owns `:443`, auto-provisions Let's Encrypt certs, and
  reverse-proxies `probe.emailtechno.com` to `127.0.0.1:3001` / `:8080`.
- Only ports **22** and **443** are open externally. Everything else binds to
  `127.0.0.1` and is reached only through Caddy.
- Ports **3001** (smtp-probe-worker) and **8080** (provenance-dashboard) are
  taken. **5432** and **6379** are free. **3100** chosen for the EmailWarm
  frontend host binding.
- Env files live under `/etc/<app>/*.env` (mode 600). Deploys run from GitHub
  Actions with **environment-scoped** secrets, an SSH deploy key, and
  `ssh-keyscan` of the host key.
- The probe host uses **systemd + Node directly** (no Docker). EmailWarm
  introduces Docker to the box; the two stacks coexist behind the one Caddy.
- Deliberately **not Terraform** (ishosting's community provider has no sane
  state/destroy semantics — see dmphub's `docs/ishosting-probe-host-setup.md`).

### Decisions locked during brainstorming

| Decision | Choice |
|---|---|
| Staging FQDN | `stg-ew.webnco.xyz` |
| Image delivery | Build in CI → push to GHCR → pull on box |
| Data stores | Postgres + Redis in-container, named volumes |
| Secrets delivery | CI renders `/etc/emailwarm/staging.env` from the `staging` Environment, ships via SSH |
| Auth | Citadel (Zitadel) at `https://id.webnco.xyz`, via better-auth (already wired) |
| Billing | Out of scope — `DEMO_MODE=true` |

---

## 2. Architecture & routing

```
Internet ──443──▶ system Caddy (existing)
                   ├── probe.emailtechno.com ─▶ 127.0.0.1:3001 / :8080   (dmphub — untouched)
                   └── stg-ew.webnco.xyz ─────▶ 127.0.0.1:3100           (emailwarm frontend)

Docker network "emailwarm" (bridge, isolated to the box):
   frontend  Next.js        host 127.0.0.1:3100  ──▶ http://backend:4611
   backend   NestJS API + ALL BullMQ workers (single process; workers are
             in-process @Processor handlers — confirmed in backend/src)
   postgres  postgres:16    volume pgdata        ◀── backend + frontend (better-auth)
   redis     redis:7-alpine volume redisdata     ◀── backend (BullMQ)
   migrate   one-shot: `node dist/src/db/migrate`, runs to completion before backend starts
```

### Why only the frontend is public

The browser talks exclusively to the Next.js app. Verified route ownership:

- Frontend (`frontend/src/app/api/…`): `/api/auth/[...all]` (better-auth/Citadel),
  `/api/mailbox-oauth/callback/[provider]` (Google/Microsoft OAuth return),
  `/api/backend/[...path]` (server-side proxy to the backend), `/api/founder/*`.
- Backend public-ish controllers: `/webhooks/stripe` (billing — **deferred**),
  `/internal/*` (cross-process from the frontend via `INTERNAL_SECRET`, network-
  internal only), `/health` (internal healthcheck), `/auth/*` (OAuth *start* —
  called by the frontend through the proxy, returns a redirect URL).

So the backend, Postgres, and Redis need **no host ports and no Caddy route**.
The frontend reaches the backend over the compose network as `http://backend:4611`
(`API_URL`); the browser's `NEXT_PUBLIC_API_URL` is `https://stg-ew.webnco.xyz`
(same origin, hits the Next proxy).

**Deferred:** when billing goes live, add a Caddy route for `/webhooks/stripe`
to the backend (or proxy it through Next) and bind a backend host port. Not in
this scope.

---

## 3. Components

### 3.1 Dockerfiles (new)

**`backend/Dockerfile`** — multi-stage:
1. `node:22-bookworm-slim` builder: `corepack enable`, `pnpm install
   --frozen-lockfile`, `pnpm build` (→ `dist/`).
2. Runtime: slim node, copy `dist/` + `node_modules` pruned to prod
   (`pnpm install --prod --frozen-lockfile` or `pnpm deploy`), non-root user,
   `CMD ["node","dist/src/main"]`. `drizzle` migrations compiled output lives at
   `dist/src/db/migrate` (from `db:migrate:prod` script).

**`frontend/Dockerfile`** — multi-stage, Next.js **standalone** output:
1. Builder: install, receive `NEXT_PUBLIC_*` as **build args** (baked at build
   time), `pnpm build`.
2. Runtime: copy `.next/standalone` + `.next/static` + `public`, non-root,
   `CMD ["node","server.js"]`, listen on `3100` (`PORT=3100`, `HOSTNAME=0.0.0.0`).

Requires `next.config` to set `output: 'standalone'` (verify/add during
implementation).

Each gets a `.dockerignore` (node_modules, .next, .git, test artifacts, env
files).

### 3.2 Compose file (new) — `deploy/docker-compose.staging.yml`

- `postgres:16`: `POSTGRES_DB/USER/PASSWORD` from env, volume `pgdata`,
  healthcheck `pg_isready -U emailwarm`.
- `redis:7-alpine`: `--appendonly yes`, volume `redisdata`, healthcheck
  `redis-cli ping`.
- `migrate`: backend image, `command: node dist/src/db/migrate`,
  `env_file: /etc/emailwarm/staging.env`, `depends_on: postgres (healthy)`,
  `restart: "no"`.
- `backend`: backend image, `env_file`, `depends_on: {migrate: completed_
  successfully, postgres: healthy, redis: healthy}`, healthcheck
  `GET http://127.0.0.1:4611/health`, `restart: unless-stopped`. No host port.
- `frontend`: frontend image, `env_file`, `ports: "127.0.0.1:3100:3100"`,
  `depends_on: backend (healthy)`, healthcheck `GET /`, `restart: unless-stopped`.
- Named volumes `pgdata`, `redisdata`. Explicit network `emailwarm`.

Image tags are `${IMAGE_TAG}` (interpolated from the deploy env, defaults to
`staging`).

### 3.3 Caddy site block (new, templated) — `deploy/caddy/stg-ew.caddy`

```
stg-ew.webnco.xyz {
	encode gzip
	reverse_proxy 127.0.0.1:3100
}
```

Public app — **no basic auth**. Shipped as a drop-in and validated with
`caddy validate` on the box **before** replacing the live fragment, then
`systemctl reload caddy` (same safety pattern as dmphub's `sync.sh`). The probe
host's existing Caddyfile is never touched; this is an additional site block
(either appended via an `import` directory, or a separate file the deploy places
and references). Implementation picks whichever matches the box's current Caddy
layout — confirm during bootstrap whether `/etc/caddy/Caddyfile` uses `import`.

### 3.4 Box bootstrap (new) — `deploy/bootstrap-staging.sh`

Run **once** by the operator as root. Idempotent. Mirrors dmphub's
`bootstrap.sh` tone:
- Install Docker Engine + `docker compose` plugin (official convenience repo).
- `mkdir -p /opt/emailwarm` (compose file location) and `/etc/emailwarm`
  (env file), mode-restrict `/etc/emailwarm`.
- Write a placeholder `/etc/emailwarm/staging.env` (mode 600) with
  `REPLACE_BEFORE_ENABLING` markers — CI overwrites it on first deploy, but the
  placeholder documents the full variable set.
- Print next-step runbook (DNS, OAuth redirect URIs, GHCR token, first deploy).

Does not install systemd units (compose manages lifecycle; optionally a tiny
`emailwarm.service` that runs `docker compose up -d` on boot — see §7 open item).

### 3.5 CI/CD (new) — `.github/workflows/deploy-staging.yml`

Single workflow, two jobs (`build` → `deploy`).

**Trigger:** `push` to `staging` branch with path filter
(`backend/**`, `frontend/**`, `deploy/**`, `.github/workflows/deploy-staging.yml`)
+ `workflow_dispatch`. `concurrency: group: emailwarm-staging-deploy,
cancel-in-progress: false`.

**`build` job:**
- Checkout, `pnpm/action-setup@v4` (v10), `setup-node@v4` (node 22, pnpm cache).
- `docker/login-action` to `ghcr.io` with `GITHUB_TOKEN` (write:packages).
- `docker/build-push-action` ×2 → tags `:${{ github.sha }}` and `:staging`.
  Frontend build passes `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_BETTER_AUTH_URL` as
  `build-args` from the `staging` Environment.
- Image names: `ghcr.io/abhishek-mittal/emailwarm-backend`,
  `ghcr.io/abhishek-mittal/emailwarm-frontend`.

**`deploy` job** (`needs: build`, `environment: staging`):
- `webfactory/ssh-agent` with `EMAILWARM_DEPLOY_KEY`.
- `ssh-keyscan -H "$EMAILWARM_HOST_IP" >> known_hosts`.
- Render `staging.env` from Environment secrets + variables (a heredoc / `envsubst`
  step), `scp` to `/etc/emailwarm/staging.env`, `ssh chmod 600`.
- `scp deploy/docker-compose.staging.yml` → `/opt/emailwarm/`.
- SSH to box: `docker login ghcr.io -u <user> -p $GHCR_PULL_TOKEN`,
  `IMAGE_TAG=${{ github.sha }} docker compose -f /opt/emailwarm/docker-compose.staging.yml pull`,
  `… up -d`, `docker image prune -f`.
- Health gate: `curl -fsS http://127.0.0.1:3100/` (retry loop) — fail the deploy
  if unhealthy.
- Caddy: `scp` rendered site block, `caddy validate`, install, `systemctl reload
  caddy` (skip gracefully if already present/unchanged).

---

## 4. Environment variables

Source of truth = GitHub **`staging` Environment**. **Secrets** (encrypted) vs
**Variables** (plain) split below. CI renders them into
`/etc/emailwarm/staging.env`; compose consumes via `env_file`.

### Backend

| Var | Value / source | Kind |
|---|---|---|
| `DATABASE_URL` | `postgresql://emailwarm:${PG_PASSWORD}@postgres:5432/emailwarm` | derived |
| `REDIS_URL` | `redis://redis:6379/1` | variable |
| `ENCRYPTION_KEY` | 32-byte hex | **secret** |
| `BETTER_AUTH_SECRET` | 32+ char | **secret** (shared with frontend) |
| `INTERNAL_SECRET` | 16+ char | **secret** (shared with frontend) |
| `ANTHROPIC_API_KEY` | key | **secret** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth app | id=var, secret=**secret** |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` | OAuth app | id=var, secret=**secret** |
| `PLATFORM_SMTP_HOST/PORT/USER` | platform mailer | variable |
| `PLATFORM_SMTP_PASS` | platform mailer | **secret** |
| `PLATFORM_FROM_EMAIL` | `EmailWarm <noreply@…>` | variable |
| `APP_URL` | `https://stg-ew.webnco.xyz` | variable |
| `PORT` | `4611` | variable |
| `CORS_ORIGINS` | `https://stg-ew.webnco.xyz` | variable |
| `LOG_LEVEL` | `info` | variable |
| `DEMO_MODE` | `true` | variable |
| `DEMO_INBOX_CREDITS` / `DEMO_PLACEMENT_CREDITS` | `10` / `5` | variable |

Stripe vars intentionally **omitted** (demo mode makes them optional).

### Frontend

| Var | Value / source | Kind |
|---|---|---|
| `DATABASE_URL` | same as backend | derived |
| `API_URL` | `http://backend:4611` (internal) | variable |
| `NEXT_PUBLIC_API_URL` | `https://stg-ew.webnco.xyz` | variable (**build arg**) |
| `APP_URL` / `BETTER_AUTH_URL` | `https://stg-ew.webnco.xyz` | variable |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://stg-ew.webnco.xyz` | variable (**build arg**) |
| `BETTER_AUTH_SECRET` | shared | **secret** |
| `INTERNAL_SECRET` | shared | **secret** |
| `ZITADEL_ISSUER` | `https://id.webnco.xyz` | variable |
| `ZITADEL_CLIENT_ID` | Citadel app for stg-ew | variable |
| `ZITADEL_CLIENT_SECRET` | Citadel app for stg-ew | **secret** |
| `FOUNDER_EMAILS` | comma list | variable |

### Infra-only (for compose / deploy, not app runtime)

`PG_PASSWORD` (**secret**; also feeds `POSTGRES_PASSWORD`), `EMAILWARM_HOST_IP`
(**secret**), `EMAILWARM_DEPLOY_KEY` (**secret**), `GHCR_PULL_TOKEN` (**secret**;
PAT with `read:packages` for the box login), `IMAGE_TAG` (set by CI to the SHA).

---

## 5. Operator prerequisites (outside code — runbook)

1. **DNS:** `A stg-ew.webnco.xyz → <VPS_IP>` (must resolve before first Caddy
   reload, or ACME fails).
2. **Google OAuth console:** add redirect URI
   `https://stg-ew.webnco.xyz/api/mailbox-oauth/callback/google`.
3. **Microsoft OAuth (Azure):** add redirect URI
   `https://stg-ew.webnco.xyz/api/mailbox-oauth/callback/microsoft`.
4. **Citadel (Zitadel):** create/confirm an app for stg-ew with redirect to
   `https://stg-ew.webnco.xyz/api/auth/...` (callback path per better-auth +
   zitadel provider config — confirm during implementation), capture client
   id/secret.
5. **GHCR:** PAT with `read:packages` → stored as `GHCR_PULL_TOKEN`.
6. **GitHub `staging` Environment:** populate all secrets + variables from §4.
   Add an SSH deploy key (`EMAILWARM_DEPLOY_KEY`) authorized on the box.
7. **Box:** run `deploy/bootstrap-staging.sh` once.
8. Create the `staging` branch; push triggers the deploy.

---

## 6. Testing & verification

- **Build:** `backend` image builds and `node dist/src/main` boots against a
  throwaway pg/redis; `frontend` image builds with standalone output.
- **Migrate:** `migrate` service applies all Drizzle migrations against a fresh
  volume; backend refuses to start until it completes (compose
  `depends_on: service_completed_successfully`).
- **Deploy dry-run:** `docker compose config` validates the compose file in CI
  before shipping. `caddy validate` gates the site block.
- **Smoke (post-deploy, automated in the workflow):** `curl` the frontend health
  path on `127.0.0.1:3100`; fail deploy if not 200.
- **Manual acceptance (first deploy):** visit `https://stg-ew.webnco.xyz`,
  complete a Citadel sign-in, connect a custom SMTP (Zoho) inbox, confirm it
  reaches the pool page. Confirm the probe host still answers on
  `probe.emailtechno.com` (coexistence).
- Existing backend (620) + frontend unit suites continue to run in `ci.yml`
  (separate from deploy; unchanged except where Dockerization needs a config
  tweak like `output: 'standalone'`).

---

## 7. Open items / non-goals

**Resolved defaults (no blocker):**
- Build + deploy = **one workflow, two jobs** (chosen for simplicity).
- Backend gets **no** host debug port (reach via `docker compose exec` /
  `docker logs`). Can add `127.0.0.1:4611` later if needed.

**Open (decide during implementation, low-risk):**
- Caddy layout: append an `import emailwarm.caddy` to the existing Caddyfile vs a
  single shared Caddyfile — depends on the box's current structure; inspect in
  bootstrap.
- Boot persistence: rely on `restart: unless-stopped` + Docker's own start-on-boot
  vs a thin `emailwarm.service` systemd unit that runs `docker compose up -d`.
  Lean: Docker restart policy is enough; revisit if the box reboots uncleanly.
- `next.config` may need `output: 'standalone'` added.

**Explicitly out of scope:** Stripe/billing webhook routing, a production
environment, worker/replica horizontal scaling, managed Postgres/Redis,
Terraform/IaC, automated off-box backups (document a `pg_dump` cron as a
follow-up, not built here).

---

## 8. File inventory (what implementation creates)

```
backend/Dockerfile
backend/.dockerignore
frontend/Dockerfile
frontend/.dockerignore
frontend/next.config.*               (edit: output: 'standalone' if missing)
deploy/docker-compose.staging.yml
deploy/caddy/stg-ew.caddy
deploy/bootstrap-staging.sh
deploy/README.md                     (runbook: §5 prerequisites + first deploy)
.github/workflows/deploy-staging.yml
.env.staging.example                 (documents the full §4 var set, no secrets)
```

`.claude/CLAUDE.md` / `docs` infra note updated to point staging at the VPS.
