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
  # PORT is intentionally NOT set here — the compose file pins each service's
  # port (backend 4611, frontend 3100). A PORT key in this shared env file
  # would make both services bind the same port. See deploy/.env.staging.example
  # for the authoritative key list.
  cat > /etc/emailwarm/staging.env <<'EOF'
# Placeholder — the deploy workflow overwrites this from the GitHub
# `staging` Environment. Documented in deploy/.env.staging.example.
# The backend refuses to start unless every REPLACE_BEFORE_ENABLING below
# (and the OAuth / platform-SMTP / Anthropic keys in the example) is set.
DATABASE_URL=postgresql://emailwarm:REPLACE_BEFORE_ENABLING@postgres:5432/emailwarm
REDIS_URL=redis://redis:6379/1
ENCRYPTION_KEY=REPLACE_BEFORE_ENABLING
BETTER_AUTH_SECRET=REPLACE_BEFORE_ENABLING
INTERNAL_SECRET=REPLACE_BEFORE_ENABLING
APP_URL=https://stg-ew.webnco.xyz
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
  if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    log "Caddyfile still valid after import wiring"
  else
    log "WARNING: Caddyfile failed validation — review manually before reload"
  fi
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
