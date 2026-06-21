# Domain Spec: Infrastructure

**Tasks covered:** T001 (scaffold + infra config)  
**GCP project:** sunny-ship-236913  
**Region:** asia-south1

---

## Repository structure

```
projects/email-warmup/
├── backend/                    ← NestJS API
│   ├── src/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   └── .env.example
├── frontend/                   ← Next.js 15 App Router
│   ├── app/
│   ├── Dockerfile
│   ├── package.json
│   └── .env.example
├── __specs__/                  ← this directory
├── docs/                       ← product, tech, experience, GTM, skills
├── .claude/                    ← coding agent context
├── .github/
│   ├── copilot-instructions.md
│   └── workflows/
│       ├── ci.yml              ← test + build on PR
│       └── deploy.yml          ← deploy to Cloud Run on main merge
└── docker-compose.yml          ← local dev: postgres + redis
```

---

## GCP services (all in asia-south1)

### Cloud Run

| Service | Container | Port | Min instances |
|---|---|---|---|
| emailwarm-api | backend/Dockerfile | 3001 | 1 |
| emailwarm-web | frontend/Dockerfile | 3000 | 1 |

Both services use `--no-allow-unauthenticated` at the network level; auth handled by better-auth at app level.

### Cloud SQL (existing dmphub instance)
- Instance: `dmphub-pg` (already running)
- New database: `emailwarm` (CREATE DATABASE emailwarm;)
- Connection: via Cloud SQL Auth Proxy (mounted as sidecar in Cloud Run)
- `DATABASE_URL=postgresql://emailwarm_user:...@/emailwarm?host=/cloudsql/sunny-ship-236913:asia-south1:dmphub-pg`

### Memorystore Redis (existing dmphub instance)
- Instance: `dmphub-redis` (already running)
- New DB index: index 1 (dmphub uses index 0)
- `REDIS_URL=redis://<private-ip>:6379/1`

### Secret Manager
Secrets to create:
```
emailwarm/encryption-key          ← 32-byte hex AES key
emailwarm/better-auth-secret      ← 32+ char random string; shared with frontend
emailwarm/stripe-secret-key
emailwarm/stripe-webhook-secret
emailwarm/anthropic-api-key
emailwarm/google-client-secret
emailwarm/microsoft-client-secret
```
Access pattern: mount as env vars in Cloud Run using `--set-secrets` flag.

---

## Docker setup

### Backend Dockerfile
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3001
CMD ["node", "dist/main.js"]
```

### Local dev (docker-compose.yml)
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_DB: emailwarm
      POSTGRES_USER: emailwarm
      POSTGRES_PASSWORD: localdev
    ports: ["5432:5432"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
```

---

## CI/CD (GitHub Actions)

### ci.yml — runs on every PR
1. `npm ci` in backend/
2. `npx tsc --noEmit`
3. `npm run test`
4. `npm ci` in frontend/
5. `next build`

### deploy.yml — runs on merge to main
1. `docker build` both images
2. `docker push` to GCR (`gcr.io/sunny-ship-236913/emailwarm-api`)
3. `gcloud run deploy emailwarm-api --image ...`
4. `gcloud run deploy emailwarm-web --image ...`
5. Run DB migration: `gcloud run jobs execute emailwarm-migrate`

---

## Acceptance criteria (T001)

- [ ] `GET /health` returns `{ status: 'ok', version: '0.1.0' }` on local and Cloud Run
- [ ] `docker-compose up` starts postgres + redis locally without error
- [ ] `npm run start:dev` in backend/ connects to local postgres and redis without error
- [ ] Cloud Run service `emailwarm-api` is created in asia-south1 with min 1 instance
- [ ] Secret Manager secrets are created and accessible by the Cloud Run service account
- [ ] GitHub Actions CI passes on an empty NestJS scaffold PR
- [ ] `emailwarm` database exists in Cloud SQL dmphub instance
