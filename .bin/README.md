# `.bin/` — local development scripts

Tiny shell orchestrator for running the stack on a laptop. No global install
beyond `docker`, `pnpm`, and `lsof` (already required for the project).

## Commands

| Command | What it does |
|---|---|
| `.bin/dev up` | Start Postgres + Redis containers, then NestJS backend (`:3001`) + Next.js frontend (`:3000`). Waits for both ports to bind before returning. |
| `.bin/dev start` | Alias for `up`. |
| `.bin/dev stop` | Stop backend + frontend processes. Leaves infra containers running. |
| `.bin/dev down` | Stop backend + frontend **and** the docker-compose stack. |
| `.bin/dev restart` | `stop` then `up`. |
| `.bin/dev status` | Print what's running, on which port, with its PID. |
| `.bin/dev logs backend` | Tail the backend log (`-n 80 -f`). |
| `.bin/dev logs frontend` | Tail the frontend log. |
| `.bin/dev logs infra` | Tail docker-compose logs. |

## How it works

PIDs are tracked in `.bin/.runtime/` (gitignored), so `stop` and `status` are
reliable across shells. SIGTERM is sent first (so `nest --watch` and
`next dev` can flush), then SIGKILL after 5 s if a process is still alive.

Infra lives in `docker-compose.yml` at the repo root.

## First-time setup (one-off)

```bash
cd backend  && pnpm install
cd ../frontend && pnpm install
cd ..
.bin/dev up
```

Then open <http://localhost:3000>. Backend health: <http://localhost:3001/health>.