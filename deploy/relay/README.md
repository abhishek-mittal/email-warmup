# citadel-mailer (vendored)

SMTP → Microsoft Graph relay. The EmailWarm backend sends system/notification
email (blacklist/DNS/bounce alerts, graduation notices) to this service over
plain internal SMTP; it forwards each message via the Microsoft Graph `sendMail`
API, sending **as the message's From address** (must be permitted by the Graph
app's Application Access Policy — currently `am@webnco.xyz`).

**Vendored verbatim from `projects/webnco-id/relay/`** (the Citadel mailer).
Keep the two copies in sync; if you change one, mirror it. Built in CI and
published as `ghcr.io/abhishek-mittal/emailwarm-mailer`, run as the
`citadel-mailer` service in `deploy/docker-compose.staging.yml`.

Config (from the compose `env_file` / environment):
- `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` — the shared Graph app.
- `PORT` — defaults to 2525.

Internal only: no SMTP AUTH, no STARTTLS. Never publish its port.
