# Deployment (staging)

Staging runs as a self-contained Docker Compose stack (frontend + backend/workers
+ Postgres + Redis) on the ishosting VPS, behind the existing system Caddy, at
`https://stg-ew.webnco.xyz`. It is built and deployed by
`.github/workflows/deploy-staging.yml` from the GitHub `staging` Environment, and
coexists with dmphub's `probe.emailtechno.com` on the same box (that config is
never touched).

This supersedes the GCP Cloud Run / Cloud SQL / Memorystore topology **for
staging**. Production hosting is still open.

- Design: `docs/superpowers/specs/2026-10-04-staging-deployment-design.md`
- Implementation plan: `docs/superpowers/plans/2026-10-04-staging-deployment.md`
- Operator runbook: `deploy/README.md`
- Env key list: `deploy/.env.staging.example`
