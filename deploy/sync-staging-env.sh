#!/usr/bin/env bash
# sync-staging-env.sh — push a local env file into the GitHub `staging`
# Environment as secrets + variables. The local file is the source of truth;
# edit it and re-run any time.
#
#   bash deploy/sync-staging-env.sh [--dry-run] [--file PATH]
#
# Defaults to deploy/.env.staging (gitignored). Copy deploy/.env.staging.example
# to that path, fill it in, then run this. Values are piped to `gh` via stdin,
# so secret values never appear in argv (/proc, shell history).
#
# Classification below MUST match how .github/workflows/deploy-staging.yml reads
# each key (secrets.X vs vars.X). A value set in the wrong bucket reads empty at
# deploy time. Add a new key here AND in the workflow together.
#
# Requires: gh (authenticated with repo + workflow scope).
set -euo pipefail

log() { printf '%s\n' "$*" >&2; }

ENV_FILE="deploy/.env.staging"
DRY_RUN=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --file) ENV_FILE="${2:?--file needs a path}"; shift 2 ;;
    *) log "unknown arg: $1"; exit 64 ;;
  esac
done

command -v gh >/dev/null || { log "gh not found"; exit 1; }
[[ -f "$ENV_FILE" ]] || { log "env file not found: $ENV_FILE (copy deploy/.env.staging.example to it)"; exit 1; }

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
ENVIRONMENT="staging"

# Keys pushed as SECRETS (encrypted). EMAILWARM_DEPLOY_KEY is loaded from the
# path in EMAILWARM_DEPLOY_KEY_FILE, not from an inline value.
SECRETS=(
  POSTGRES_PASSWORD EMAILWARM_HOST_IP GHCR_PULL_TOKEN EMAILWARM_DEPLOY_KEY
  ENCRYPTION_KEY BETTER_AUTH_SECRET INTERNAL_SECRET ANTHROPIC_API_KEY
  GOOGLE_CLIENT_SECRET MICROSOFT_CLIENT_SECRET PLATFORM_SMTP_PASS ZITADEL_CLIENT_SECRET
)
# Keys pushed as VARIABLES (plain).
VARIABLES=(
  GOOGLE_CLIENT_ID MICROSOFT_CLIENT_ID PLATFORM_SMTP_HOST PLATFORM_SMTP_PORT
  PLATFORM_SMTP_USER PLATFORM_FROM_EMAIL DEMO_INBOX_CREDITS DEMO_PLACEMENT_CREDITS
  ZITADEL_CLIENT_ID FOUNDER_EMAILS NEXT_PUBLIC_API_URL NEXT_PUBLIC_BETTER_AUTH_URL
)

# Parse KEY=VALUE lines into an associative array WITHOUT sourcing the file
# (never execute its contents). First '=' splits; surrounding quotes stripped.
declare -A VALS=()
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"; key="${key//[[:space:]]/}"
  [[ "$key" =~ ^[A-Z0-9_]+$ ]] || continue
  val="${line#*=}"
  # strip one layer of matching surrounding quotes
  if [[ "$val" == \"*\" ]]; then val="${val%\"}"; val="${val#\"}"; fi
  if [[ "$val" == \'*\' ]]; then val="${val%\'}"; val="${val#\'}"; fi
  VALS["$key"]="$val"
done < "$ENV_FILE"

log "repo:        $REPO"
log "environment: $ENVIRONMENT"
log "source:      $ENV_FILE"
log "dry run:     $DRY_RUN"
log ""

# Ensure the environment exists (idempotent) before writing into it.
if ! $DRY_RUN; then
  gh api -X PUT "repos/$REPO/environments/$ENVIRONMENT" >/dev/null
fi

ok=0; skipped=0; failed=0

set_secret() { # name value
  local name="$1" value="$2"
  if $DRY_RUN; then printf '  %-26s secret   would set (%s chars)\n' "$name" "${#value}" >&2; ok=$((ok+1)); return; fi
  if err=$(printf '%s' "$value" | gh secret set "$name" --repo "$REPO" --env "$ENVIRONMENT" 2>&1); then
    printf '  %-26s secret   set (%s chars)\n' "$name" "${#value}" >&2; ok=$((ok+1))
  else
    printf '  %-26s secret   FAILED: %s\n' "$name" "$(echo "$err" | head -1)" >&2; failed=$((failed+1))
  fi
}

set_variable() { # name value
  local name="$1" value="$2"
  if $DRY_RUN; then printf '  %-26s variable would set (%s chars)\n' "$name" "${#value}" >&2; ok=$((ok+1)); return; fi
  if err=$(gh variable set "$name" --repo "$REPO" --env "$ENVIRONMENT" --body "$value" 2>&1); then
    printf '  %-26s variable set (%s chars)\n' "$name" "${#value}" >&2; ok=$((ok+1))
  else
    printf '  %-26s variable FAILED: %s\n' "$name" "$(echo "$err" | head -1)" >&2; failed=$((failed+1))
  fi
}

for name in "${SECRETS[@]}"; do
  if [[ "$name" == "EMAILWARM_DEPLOY_KEY" ]]; then
    # Loaded from a file path, so the multiline key never sits in the dotenv.
    keyfile="${VALS[EMAILWARM_DEPLOY_KEY_FILE]:-}"
    keyfile="${keyfile/#\~/$HOME}"
    if [[ -z "$keyfile" ]]; then
      printf '  %-26s secret   SKIP (EMAILWARM_DEPLOY_KEY_FILE not set)\n' "$name" >&2; skipped=$((skipped+1)); continue
    fi
    if [[ ! -f "$keyfile" ]]; then
      printf '  %-26s secret   SKIP (file not found: %s)\n' "$name" "$keyfile" >&2; skipped=$((skipped+1)); continue
    fi
    value="$(cat "$keyfile")"
  else
    value="${VALS[$name]:-}"
  fi
  if [[ -z "$value" ]]; then
    printf '  %-26s secret   SKIP (empty)\n' "$name" >&2; skipped=$((skipped+1)); continue
  fi
  set_secret "$name" "$value"
  unset value
done

for name in "${VARIABLES[@]}"; do
  value="${VALS[$name]:-}"
  if [[ -z "$value" ]]; then
    printf '  %-26s variable SKIP (empty)\n' "$name" >&2; skipped=$((skipped+1)); continue
  fi
  set_variable "$name" "$value"
done

log ""
log "set=$ok skipped=$skipped failed=$failed"
[[ $failed -eq 0 ]] || exit 1
