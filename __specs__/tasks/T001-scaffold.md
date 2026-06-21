# T001 — Project Scaffold + Infra Config

**Wave:** 0  
**Depends on:** nothing  
**Skills to load:** docs/05-agent-skills/01-skill-database.md  
**Service spec:** __specs__/domains/infra.md

---

## What to build

Create the complete project directory structure for the email-warmup standalone sub-project. This is the empty-repo-to-running-server task.

### Backend (NestJS)

Scaffold `backend/` with:
- NestJS CLI scaffold (`nest new .` or manual)
- AppModule with ConfigModule (Joi validation of all required env vars)
- HealthModule: `GET /health` → `{ status: 'ok', version: '0.1.0' }`
- Dockerfile (multi-stage, node:20-alpine)
- `package.json` with all Phase 1 dependencies:
  - `@nestjs/core`, `@nestjs/common`, `@nestjs/config`, `@nestjs/platform-express`
  - `drizzle-orm`, `drizzle-kit`, `pg`
  - `bullmq`, `ioredis`
  - `better-auth` (self-hosted auth — see `docs/05-agent-skills/02-skill-auth.md`)
  - `stripe`
  - `@anthropic-ai/sdk`
  - `nodemailer`, `imapflow`
  - `zod`, `joi`
- `.env.example` with all required env var names (no values)
- `tsconfig.json` (strict mode, target ES2022)
- `npm run db:migrate` script wired to `drizzle-kit migrate`

### Frontend (Next.js)

Scaffold `frontend/` with:
- `npx create-next-app@latest . --typescript --app --tailwind --eslint --src-dir=false`
- Install: `better-auth`, `pg`, `swr`, `recharts`
- Root layout with `<AuthProvider>` from `src/components/AuthProvider.tsx` (better-auth session wrapper)
- Middleware protecting all non-public routes via `getSessionCookie()` from `better-auth/cookies`
- `.env.example` with required env vars

### Docker + CI

- `docker-compose.yml` at project root (postgres:16 + redis:7)
- `.github/workflows/ci.yml` — typecheck + test + build
- `.github/workflows/deploy.yml` — build + push + Cloud Run deploy (placeholder — actual deploy keys added separately)

---

## Acceptance criteria

- [ ] `GET /health` returns `{ status: 'ok', version: '0.1.0' }` with HTTP 200
- [ ] `npm run start:dev` in `backend/` starts without errors
- [ ] `npm run dev` in `frontend/` starts without errors
- [ ] `docker-compose up` starts postgres and redis without errors
- [ ] `npm run typecheck` in both backend and frontend passes with 0 errors
- [ ] ConfigModule throws on startup if any required env var is missing
- [ ] `.env.example` lists all required env var names with placeholder comments

## Mark done in SPEC-STATUS.md when all criteria above are verified
