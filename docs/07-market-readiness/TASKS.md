# Market readiness: corrective and missing-work specifications

These are work-package specifications for agents, not a claim that fixes have been implemented. All paths are repository-relative. Status/owners live in STATUS.md. P0 blocks external use or collection of payment; P1 blocks a dependable public launch; P2 may follow a deliberately narrower launch. Each task must be split into a focused, test-first execution plan before coding. Preserve existing user work.

For every task: reproduce the described behavior; add a regression test at the actual boundary; implement; run the focused suite plus affected build/typecheck; add integration or staging evidence where specified. Record commands, results, commit, migration/rollback instructions and remaining limitations. A unit mock returning success is not proof of SMTP, IMAP, OAuth, Stripe or Cloud Run behavior.

## MR-01 — Secure and separate mailbox OAuth linking (P0, fix)

**Evidence/files:** `backend/src/inbox/inbox.controller.ts` (`AuthCallbackController`), `backend/src/inbox/oauth/{google,microsoft}-oauth.service.ts`, `frontend/src/app/(dashboard)/inboxes/connect/_components/ConnectInboxForm.tsx`, `frontend/src/app/api/auth/[...all]/route.ts`.

Start endpoints are public, so the global guard does not populate userId; state contains `anonymous` or an unsigned userId. Public callbacks decode/trust it. Provider redirect URIs are `/api/auth/callback/*` on APP_URL, while mailbox callbacks are `/auth/callback/*` on the backend. This collides with account-login ownership of the frontend auth routes.

- [ ] Require a validated session for the linking start. Generate 32 random bytes of state; store only its hash with userId, provider, purpose, redirect target and five-minute expiry. Bind it to the initiating session and consume it atomically once. Use PKCE where supported. Never accept userId from decoded client state.
- [ ] Give account login and mailbox linking distinct registered redirect URIs/config variables. Route linking callbacks to the linking service and redirect to an allowlisted absolute frontend result URL.
- [ ] Handle denied consent, missing/expired/replayed state, duplicate account and provider errors with typed safe messages. Verify mailbox identity with an API covered by granted scopes; check HTTP failures before parsing identity.
- [ ] Add callback HTTP tests and provider staging tests: valid link goes to correct user; edited/replayed/wrong-provider state is rejected before token exchange; logged-out initiation fails; account login continues working.

**Depends on:** MR-07 session boundary. **Done evidence:** two real provider link journeys with redacted request/redirect traces and adversarial state tests.

## MR-02 — Make mail side effects and replies correct (P0, fix)

**Evidence/files:** `backend/src/warmup/warmup-send.processor.ts`, `warmup-receive.processor.ts`, `backend/src/db/schema.ts`. `sendReply()` supplies no `to`; sends use new random message IDs on every attempt and insert records after SMTP. Receive actions write all timestamps only at the end, so partial failure repeats actions. Queue defaults do not specify retries.

- [ ] Load the original warmup send and its verified sender address; reply only to that recorded partner. Supply `to`, stable reply Message-ID, References, In-Reply-To and the warmup identification header. Do not trust arbitrary Reply-To from received content. Generate replies with bounded original context, not an empty body by default.
- [ ] Persist send intent before SMTP using a unique logical delivery ID. Track states `planned/submitting/accepted/uncertain/failed`; retain provider response metadata. Persist per-action progress and deterministic reply identity. Publish receive jobs through an outbox so a DB/queue failure cannot lose accepted sends.
- [ ] Treat “SMTP may have accepted but acknowledgement was lost” as uncertain. Reconcile through Sent/provider evidence when possible; otherwise stop and surface uncertainty. SMTP is not an exactly-once protocol: a stable Message-ID alone does not prevent duplicates.
- [ ] Serialize IMAP actions per mailbox across workers; use mailbox locks and stable UIDs with UIDVALIDITY. Persist each successful action, re-locate after moves, and always release locks. Rescue based on this message's observed spam placement, not the previous send.
- [ ] Test missing recipient regression with SMTP envelope capture; inject failures after SMTP acceptance, DB write, queue publish, reply and folder move. Assert no blind resend/reply and resumable action state. Test two jobs on the same mailbox without selecting/moving each other's messages.

**Depends on:** coordinate ledger migration with MR-15; provider tests need MR-08. **Done evidence:** local protocol harness plus controlled real two-mailbox exchange.

## MR-03 — Enforce daily volume and idempotent scheduling (P0, fix)

**Evidence/files:** `backend/src/warmup/warmup.service.ts`, `ramp.service.ts`, `pairing.service.ts`, `backend/src/inbox-control/inbox-control.service.ts`. Every resume schedules a full volume and increments warmupDay. Past slots become delay 0. Jitter accepts the last collision after five attempts. Every API instance runs the cron.

- [ ] Add unique `(inbox_id, schedule_date, policy_version)` schedule records and `(schedule_id, slot_index)` delivery intents. Claim a schedule transactionally; queue via outbox. Advance warmup day once per eligible calendar day under an explicit timezone rule, independent of resume requests.
- [ ] Compute remaining allowance from reservations + accepted + uncertain sends. Resume an already active inbox is a no-op. Late resume creates only future slots with enforced spacing; do not replay expired slots as a burst. Cap volume to window capacity or explicitly defer to next day.
- [ ] Reserve sender and recipient capacity atomically, including reply traffic; release reservations on terminal cancellation/failure. Batch partner scoring instead of one DB query per candidate per slot.
- [ ] Use one scheduling authority or distributed lease; retain DB uniqueness even with a lease. Isolate per-inbox scheduling errors so one bad account does not stop the day. Recheck status/consent/entitlement immediately before side effects.
- [ ] Test concurrent cron on two replicas, repeated resume, pause/resume races, restart mid-schedule, no partners, midnight/DST and late-day resume. Assert hard daily caps and spacing under deterministic extreme jitter.

**Depends on:** MR-09, MR-10, MR-15 contracts. **Done evidence:** concurrent integration test plus multi-day staging schedule ledger.

## MR-04 — Repair payment processing and subscription state (P0, fix)

**Evidence/files:** `backend/src/main.ts`, `backend/src/billing/{stripe-webhook.controller,billing.service,trial.service}.ts`, `frontend/src/app/(dashboard)/billing/*`. Controller requires `req.rawBody`; bootstrap registers `bodyParser.raw` but does not enable Nest rawBody or copy a raw buffer there. Event dispatch happens before insertion of the unique event ID; two requests can both apply effects. Subscription updates ignore payment status/order. Checkout success targets `/dashboard`, but the dashboard page route is `/`.

- [ ] Enable Nest's supported raw-body capture and verify the actual HTTP bytes; remove conflicting parsing. Add signed HTTP tests through the real bootstrap setup, not direct controller invocation.
- [ ] Atomically store/claim verified Stripe events with processing status; durable retry on failures. Apply subscription changes and notification outbox writes transactionally. Duplicate concurrent events must have one semantic effect. Do not mark failed work processed.
- [ ] Reconcile current subscription/payment status from Stripe, keyed to stored customer/subscription ownership; reject unknown prices and stale subscription mutations. Handle active, trialing, past_due, unpaid, canceled and incomplete states with a documented grace policy. A late update must not resurrect canceled access.
- [ ] Set subscription metadata explicitly as well as checkout metadata; add checkout idempotency and protection against duplicate subscriptions. Correct success/cancel URLs. Support self-service change/cancel, delinquency recovery and over-limit downgrade without deleting customer data.
- [ ] Test valid/invalid signatures, duplicate parallel events, reversed event order, retry after DB failure, failed payment/recovery, cancellation, trial expiry, upgrade and downgrade. Run Stripe test-mode checkout/portal against staging and record actual entitlement changes.

**Depends on:** MR-09 entitlements, MR-15 event/outbox schema. **Reference:** [Nest raw body](https://docs.nestjs.com/faq/raw-body), [Stripe webhooks](https://docs.stripe.com/webhooks).

## MR-05 — Make placement observations reliable (P0, fix)

**Evidence/files:** `backend/src/placement/{placement.service,placement-test.processor,placement-analyzer.service,seed-list.service}.ts`, `backend/src/db/schema.ts`. Gmail searches without selecting a mailbox. Label spellings differ from receive processor. Failed checks become missing delivery; overall timeout replaces even successful results. Deleted seed rows disappear from the denominator. `completedAt` defaults at insert while pending.

- [ ] Model tests with createdAt, startedAt, completedAt nullable and explicit queued/running/complete/partial/failed state; persist one result per originally selected seed and provider. Separate observed folder, delivery-not-found, auth error, timeout and disabled/missing seed.
- [ ] Select mailboxes explicitly before search, use provider-supported category observations, and validate real Gmail label fixtures. Preserve distinct Primary/Promotions/other inbox categories, Junk and not-observed; Outlook Inbox is not evidence of Gmail-style Primary placement.
- [ ] Preserve completed observations on timeout, close/abort outstanding connections and bound concurrency/retries. Calculate percentages using an explicit stable denominator and publish observation coverage/confidence. Operational seed failures must not count as proof of sender spam performance.
- [ ] Reserve quota and test intent atomically before sending; use idempotent per-seed delivery tracking and observe SMTP partial acceptance. Do not claim a BCC generic test perfectly predicts a user's campaign: label methodology and later support representative test content.
- [ ] Test selected mailbox requirements with a protocol harness, label variants, moved mail, missing/deleted seeds, partial provider outage, partial SMTP rejection, timeout after some successes and retry. UI must show partial/failed state instead of a conclusive zero score.

**Depends on:** MR-08, MR-14, MR-15. **Done evidence:** known-folder tests in controlled Gmail/Outlook/Yahoo seeds, with saved redacted provider observations.

## MR-06 — Make builds and deployment reproducible (P0, fix)

**Evidence/files:** `.github/workflows/{ci,deploy}.yml`, `backend/Dockerfile`, `frontend/Dockerfile`, `backend/src/config/env.validation.ts`, `frontend/next.config.ts`. Git root is this project, but workflows use `projects/email-warmup/*`. Backend `npm ci` has no package-lock. Deployment references Clerk; auth action has no `id: auth` or access-token output configuration despite using `steps.auth.outputs.access_token`. Both services are private with no shown public routing/authentication bridge. Frontend build has no configured public API URL.

- [ ] Pin one package-manager/runtime version; use committed pnpm locks consistently. Correct paths to `backend` and `frontend`. Build images in CI, use non-root runtime users and `.dockerignore` excluding env files, caches and local artifacts.
- [ ] Replace stale auth variables with a reviewed environment contract: DATABASE_URL, REDIS_URL, encryption, Better Auth, INTERNAL_SECRET, provider redirect/client credentials, Stripe prices/secrets, model key, SMTP delivery config and server API URL. Never put auth secrets under NEXT_PUBLIC. Validate URLs/key lengths and numeric ports.
- [ ] Repair workload identity and registry authentication with explicit action outputs; validate actual cloud identifiers, secret references and shell quoting. Do not assume existing cloud resources or permissions are correct.
- [ ] Define ingress: public frontend; browser requests use its authenticated server boundary; private API uses service identity where applicable; provider callbacks and Stripe webhook need reachable narrowly scoped routes. Configure API audience/invoker and frontend forwarding deliberately.
- [ ] Deploy migrations as a versioned job before compatible app rollout; include both app and auth schema migrations. Gate deploy on successful CI for the same commit, add smoke checks and rollback to previous image. Do not execute deploy in this documentation task.
- [ ] Accept only after clean-checkout install, both Docker builds, staging boot without local files, signup, API call and webhook reachability pass; record rollback rehearsal.

**Depends on:** MR-07 and MR-19 runtime architecture; may begin build repairs independently.

## MR-07 — Remove browser signing authority (P0, fix)

**Evidence/files:** `frontend/src/lib/{api,api-server,bearer-token,auth-server}.ts`, `frontend/src/middleware.ts`, `backend/src/auth/better-auth.guard.ts`. Client reads `NEXT_PUBLIC_BETTER_AUTH_SECRET` and mints arbitrary-user HMAC tokens. Backend trusts their signature and expiry without session lookup.

- [ ] Prefer a same-origin Next.js API boundary: validate the Better Auth session on the server on every forwarded request, derive userId there, and sign server-to-server credentials only on the server. Allowlist backend paths/methods, enforce CSRF/origin checks for cookie-authenticated mutations, propagate multipart safely, bound body size/timeouts, and never allow a caller-supplied userId or Authorization header to override identity.
- [ ] Keep signing code in a `server-only` module. Use short-lived, audience/purpose-bound internal credentials with key versioning, or verify a standard server-issued token. Validate finite expiry, max lifetime and malformed inputs; define logout/revocation behavior explicitly.
- [ ] Remove the public secret variable and all browser token minting. If any deployment used the shared value publicly, rotate server secrets, invalidate affected sessions/tokens and rebuild/redeploy browser assets; inspect build artifacts without printing secrets. This is a conditional remediation, not a finding that a deployment was compromised.
- [ ] Tests: anonymous/malformed/revoked session denied; forged userId ignored; tenant B cannot read or mutate tenant A; allowed uploads work; forbidden proxy target rejected. Build with a synthetic sentinel secret and scan client assets to prove it is absent.

**Depends on:** none; start here. **Reference:** [Next.js environment variables](https://nextjs.org/docs/pages/guides/environment-variables) explains public build-time inlining.

## MR-08 — Complete OAuth refresh and transport compatibility (P0, fix + missing worker)

**Evidence/files:** `backend/src/inbox/inbox.service.ts`, `smtp/smtp-client.service.ts`, `imap/imap-client.service.ts`, `oauth/*`, `backend/src/queue/queue.module.ts`. Eleven queues but only ten processor decorators; token-refresh has no consumer. Regular SMTP uses stored access token with no refresh. Gmail interactive insert omits IMAP host/port; regular IMAP rejects absent fields. Microsoft port 587 is passed with secure=true; private Microsoft SMTP uses port 465. Batch OAuth inserts refresh/client secrets but no access token.

- [ ] Create `backend/src/inbox/oauth/token-refresh.processor.ts` and a shared credential provider used by SMTP/IMAP and analysis. Refresh on demand before expiry with one lock per credential identity; persist expiry and any rotated refresh token encrypted. Distinguish revoked consent from temporary provider outage.
- [ ] Use provider configuration consistently: Gmail IMAP/SMTP settings and Microsoft IMAP plus SMTP submission STARTTLS; never assume secure=true on port 587. Enforce certificate verification and required transport encryption for custom connections.
- [ ] Reuse the same provider configuration for interactive, imported and private-pool inboxes. Reconnect cached IMAP connections after credential changes. Bound connection count, idle time, connect/auth/socket timeout and graceful shutdown cleanup.
- [ ] On revocation, pause safely, cancel eligibility and notify once; provide reconnect action via MR-21. Retrying transient refresh failures must not erase valid refresh credentials.
- [ ] Test expiry, concurrent refresh, rotated refresh token, invalid_grant, imported OAuth and token worker registration. Verify real controlled accounts work across access-token expiry and worker restart.

**Depends on:** MR-01 for interactive callback flow. **Reference:** [Nodemailer SMTP](https://nodemailer.com/smtp) distinguishes implicit TLS and STARTTLS.

## MR-09 — Enforce entitlements at every entry point (P0, fix)

**Evidence/files:** `backend/src/billing/billing.service.ts`, `backend/src/inbox/inbox.service.ts` batchUpload, `inbox-control/inbox-control.service.ts`, `placement/placement.service.ts`, frontend `lib/plan-config.ts`. Batch insertion has no assertInboxLimit. Resume only checks ownership. Unknown/free placement plans default to trial quota. Count-before-insert limits race.

- [ ] Introduce one entitlement service with explicit disabled/expired/trial/paid state and shared feature definitions. Check effective expiry immediately, not only in hourly cron. Enforce connect/import/resume/placement/diagnostics and worker dispatch.
- [ ] Reserve inbox slots and monthly placement units inside a per-user transaction/lock. Concurrent requests cannot exceed caps. Define whether removed/failed inboxes consume quota and make retries reuse reservations. Private pool imports need their own explicit plan/resource limits.
- [ ] Reject free/unknown plans by default. On downgrade, let users choose active inboxes up to allowance; pause excess deterministically pending choice. Paid activation must not automatically override user/security/bounce pauses.
- [ ] Test expired user resume, direct REST bypass of UI gates, over-limit JSON/CSV import, simultaneous connects/tests, forged plan and downgrade with too many active inboxes. Make frontend plan copy derive from the same contract.

**Depends on:** MR-15 reservation schema; coordinate MR-04.

## MR-10 — Enforce consent and pool eligibility (P0, fix + missing consent flow)

**Evidence/files:** `backend/src/inbox/inbox.service.ts` runPrecheck auto-sets poolConsentAt; `backend/src/analysis/analysis.service.ts` sets active after DNS analysis; `backend/src/pool-inbox/pool-inbox.service.ts` removal is status-only; `backend/src/warmup/pairing.service.ts` trusts pool_members flags; receive worker only checks row existence. Pausing does not deactivate pool membership.

- [ ] Add explicit consent UI and backend record containing scope, policy version and timestamp; never infer consent from passing DNS. Keep connection readiness, warmup status and shared-pool participation separate. Private-pool ownership attestation must be explicit too.
- [ ] Verify SMTP/IMAP capability before eligibility; imported DNS-only analysis cannot activate an unusable sender/receiver. Use conditional state transitions so stale analysis cannot resurrect removed or paused accounts.
- [ ] Shared pairing requires consent, active receiver, healthy credentials, not quarantined, and capacity. Recheck before send/reply; recheck private receiver ownership matches sender tenant. Revocation/removal atomically disables participation and cancels queued reservations/jobs.
- [ ] Define a clear mailbox filing promise. Current delayed engagement leaves incoming mail visible until processing and failures can leave it indefinitely; strict “never appears” requires provider-supported filtering at connection or revised product wording. Reconcile provider filters with placement observation before filing; verify with real provider accounts.
- [ ] Test no-consent enrollment, withdrawal during queued/running work, paused shared receivers, removed pool receiver, cross-tenant private reference and late analysis completion. Document bounded in-flight behavior: an already accepted SMTP message cannot be unsent.

**Depends on:** MR-03/MR-08 state and capacity contracts.

## MR-11 — Harden untrusted inputs, egress and secret handling (P0, missing controls)

**Evidence/files:** `backend/src/main.ts`, `inbox/dto/*`, `pool-inbox/*`, `common/csv-parser.ts`, `inbox/{smtp,imap}/*`, `notify/notify.processor.ts`, `app.module.ts`. SMTP/IMAP hosts/ports are user-controlled; no egress policy found. FileInterceptor has no file-size limit; batch arrays lack a consistent bounded validation layer. Logger redacts only a small set of top-level fields.

- [ ] Validate canonical DTOs at all JSON/CSV paths: email, provider enum, integer port range, bounded host/credential length, nested row structure, max rows and upload bytes. Recommended initial caps: 200 rows and 1 MiB CSV; make server values authoritative. Preserve documented alias handling.
- [ ] Enforce egress policy for SMTP/IMAP and notification webhooks: deny loopback, private, link-local, metadata and IPv6 equivalents; resolve all DNS answers and bind checked addresses to connection to prevent rebinding. Reject redirects to prohibited hosts; keep TLS SNI/certificate checks. Use an explicit operator allowlist for intentionally supported private infrastructure.
- [ ] Add per-user/IP expensive-operation quotas, timeouts and concurrency limits; set explicit CORS origins and security headers. Return safe structured errors rather than database/provider internals.
- [ ] Use allowlisted response DTOs for every create/get operation, including `.returning()` paths. Never return ciphertext or secret fields. Redact internal secret headers, cookies, OAuth codes/state/tokens, aliases and nested import credentials; disable protocol body logs in production.
- [ ] Test malicious host/IP forms and DNS rebinding using controlled resolvers only, oversize/malformed imports, concurrency limits, recursive secret fixtures and unauthorized reads. Add encryption key validation at boot and versioned ciphertext/key rotation with a tested recovery plan.

**Depends on:** MR-07; rollout must retain valid customer-provider connections.

## MR-12 — Build bounce protection and emergency stopping (P0, missing)

**Evidence:** no bounce event fields/consumer/rate calculation in `backend/src`; PRD hard constraint requires pause when bounce rate exceeds 3% in 24 hours.

**Create:** `backend/src/safety/` service/module/processors and specs; migrations through `db/schema.ts`. **Modify:** warmup send/receive, SMTP client, scheduler, controls, notifications and dashboard.

- [ ] Persist immutable delivery outcomes correlated to delivery/message ID: accepted, rejected, deferred, delivery failure and complaint where provider evidence is available. Parse trustworthy DSNs/provider callbacks idempotently; distinguish temporary errors, hard bounces and operational auth failures.
- [ ] Define the 24-hour denominator as actual attempted recipient deliveries, deduped by logical delivery, and count confirmed bounce outcomes once. Enforce the PRD's >3% threshold, including small samples; expose sample size to users. Separate provider outage circuit breakers from bounce classification.
- [ ] Atomically add a system pause reason, stop future reservations, recheck safety at dispatch and notify once. User resume must not override unresolved system safety pauses. Add operator global/provider/tenant kill switches and auditable recovery actions.
- [ ] Test 3% versus >3%, zero denominator, duplicate/late/out-of-order DSNs, rolling-window expiry, forged/unrelated DSNs, concurrent in-flight jobs and kill-switch propagation. Use controlled failure fixtures, not unsolicited mail.

**Depends on:** MR-02 delivery ledger, MR-03 scheduler, MR-18 notification dedupe.

## MR-13 — Make DNS/RBL diagnostics truthful (P1, fix)

**Evidence/files:** `backend/src/monitor/{dns.service,blacklist.service,rbl-list}.ts`, `backend/src/inbox/inbox.service.ts`, `backend/src/analysis/analysis.service.ts`. Precheck returns dkim:true. SPF checks only a prefix; DMARC can pass without valid version/policy. RBL code queries domain for every zone and treats any 127.* as listed. Unknown results yield isClean=true when no positive result exists. Only eight zones are configured, not 100+.

- [ ] Consolidate duplicate DNS evaluators. Model pass/fail/unknown/not-applicable with checkedAt, resolver/error evidence. Validate SPF multiplicity/syntax and lookup budget; distinguish record presence from authorizing the actual sending IP. Validate DKIM selector/key and DMARC version/policy/alignment facts; p=none is monitoring policy, not proof authentication is broken. Never invent DKIM success.
- [ ] Define zone registry entries with query kind (domain/IP), enabled state, accepted listing codes, error codes, licensing and health probes. Use actual egress sending IP for IP lists and reverse octets where required; never substitute domain A/MX IP without evidence. Unavailable sending IP is unknown.
- [ ] Preserve unknown coverage and prevent error codes triggering auto-pause. Use current supported zones and licensed commercial access; update the 100+ promise to verified coverage or procure/test expanded coverage.
- [ ] Tests: malformed/multiple records, DNS timeout/NXDOMAIN distinction, null MX, unknown selector/IP, domain/IP query fixtures and Spamhaus 127.255.255.* errors. Compare controlled DNS fixtures with independently captured records.

**Depends on:** MR-15 result schema, MR-16 score semantics. **Reference:** [Spamhaus query/return-code guidance](https://docs.spamhaus.com/datasets/docs/source/70-access-methods/data-query-service/040-dqs-queries.html).

## MR-14 — Provision and operate placement seeds (P1, missing operations)

**Evidence/files:** `backend/src/placement/seed-list.service.ts`, `placement.service.ts`, `backend/src/db/schema.ts` seedInboxes. Empty seed list correctly returns 503; no checked-in provisioning/health workflow proves real coverage. No weekly placement cron found.

- [ ] Create an operator-only seed registry/provisioning command and health worker. Store provider auth securely with MR-08 support; no credentials in source/CSV artifacts. Track provider/category coverage, credential health, capacity, last observation and quarantine reason.
- [ ] Decide and publish minimum coverage for quick/full tests (current targets 5/3/2 and 20/10/5 Gmail/Outlook/Yahoo). Reserve healthy seeds; reject insufficient coverage or explicitly label reduced sample before charging quota. Keep baseline placement seeds separate from automated rescue/engagement when evaluating actual placement.
- [ ] Add consented weekly scheduling with a per-user plan allowance and schedule uniqueness. Resolve PRD weekly promise versus Starter's one-test-per-month implementation: choose one customer contract and align plan config, scheduler and pricing copy.
- [ ] Add rotation, credential expiry, out-of-service replacement and ownership checks to the seed runbook. Establish coverage alarms and response owners.
- [ ] Accept after provider seeds are provisioned and live health verified, unavailable capacity produces clear UI, scheduled tests respect quotas, and a known-folder test demonstrates each supported category.

**Depends on:** MR-05, MR-08, MR-09. Account provisioning/provider permissions are external prerequisites, not code-complete evidence.

## MR-15 — Harden database contracts and durable workflows (P1, fix)

**Evidence/files:** `backend/src/db/schema.ts`, `db/migrations/*`, `frontend/src/lib/auth-server.ts`. Missing uniqueness for warmup logical delivery/message IDs and regular inbox identity; receiver XOR and analysis target XOR only comments; pool ownership lacks FK; state/plan strings unconstrained. Auth migrates at request startup and catches migration failures.

- [ ] Inventory existing data before tightening constraints. Normalize email identity and decide tenant/global uniqueness deliberately; retain provider identity where email aliases can change. Deduplicate with an audited data migration, not silent deletes.
- [ ] Add ownership FKs, exactly-one target checks, state/plan checks, schedule/delivery/action/event uniqueness and query indexes based on actual access patterns. Use unambiguous UTC instants and separate created/requested/completed timestamps.
- [ ] Add outbox + consumer dedupe tables for DB-to-queue boundaries and quota reservations; persist state transition version to reject stale jobs. Recovery scanner retries unpublished outbox records without duplicating effects.
- [ ] Move both Better Auth and app migrations to explicit deployment jobs; fail deployment on failure. Use separate least-privileged runtime and migration DB roles. Add bounded pool sizes and connection shutdown.
- [ ] Test fresh DB, baseline upgrade with representative duplicates, failed migration recovery, constraint violations, queue outage and outbox recovery. Check plans with EXPLAIN on realistic activity/history sizes. Use expand/migrate/contract rollouts, with restore rehearsal before destructive migration.

**Depends on:** shared schema contracts from MR-02/03/04/05; one agent owns migration sequencing at a time.

## MR-16 — Make scores, graduation and AI recommendations evidence-based (P1, fix)

**Evidence/files:** `backend/src/scoring/*`, `backend/src/warmup/warmup.service.ts` graduation, `backend/src/diagnostics/*`, placement processor. Missing blacklist awards 30, absent placement awards 20, missing placement passes graduation; pending test spamPct null becomes 0. Seven-day average can use one row. Spam >20% diagnostics trigger is absent.

- [ ] Keep score value separate from completeness, confidence, version and observation age. Only use completed valid observations; unknown data must not mean clean. Clamp finite component values, validate null/zero counts and represent insufficient data explicitly.
- [ ] Require a documented minimum observation window/sample/coverage and fresh valid placement before graduation. Match user-facing readiness wording to evidence; internal scores are not provider reputation metrics or guarantees of future deliverability.
- [ ] Wire high-spam placement to deduplicated diagnostics with the actual test ID/coverage. Keep deterministic issue codes primary; schema-validate AI JSON, enums and numeric bounds; include evidence timestamps and uncertainty. Add request cancellation, cost budgets and fallback behavior.
- [ ] Persist readiness report before its completion notification is eligible. Reconcile PRD score target (80) versus current graduation threshold (70) explicitly; choose a versioned rule and update copy/tests.
- [ ] Test all-unknown, pending, stale, zero-seed and partial data; boundary scores; seven distinct measured days; malformed AI response; timeouts; repeated triggers and report/notification race. Do not gate a release on a score artificially rising: validate measurement correctness first.

**Depends on:** MR-05, MR-13, MR-18.

## MR-17 — Build post-graduation maintenance (P1, missing)

**Create:** maintenance policy/service and tests under `backend/src/warmup/`; migration for mode/choice. **Modify:** warmup scheduler, controls, readiness report, inbox detail UI.

- [ ] Separate lifecycle stage from active/paused/safety state. Offer an explicit maintenance choice on graduation, with configured 5–10/day cap and normal consent/entitlement checks. Do not silently reactivate withdrawn pool consent.
- [ ] Reuse the same schedule ledger, reservations and safety checks. Define days with insufficient partners, manual stop, provider failures and regression to paused review state.
- [ ] Show maintenance mode and actual daily allowance clearly; readiness report explains how to stop and when measurements were last taken.
- [ ] Test repeated graduation, exact maintenance caps, no scheduling for declined/paused/free users, restart/retry and a fresh adverse health event.

**Depends on:** MR-03, MR-09, MR-10, MR-12, MR-16. May be deferred only if removed from launch scope and copy.

## MR-18 — Complete notifications and customer settings (P1, fix + missing UI)

**Evidence/files:** `backend/src/notify/*`, `backend/src/db/schema.ts` notifications/users, frontend dashboard routes. Templates and Slack POST exist; no complete settings CRUD found. Processor does not persist the notification table. Slack fan-out is coupled to email job completion.

- [ ] Create authenticated preferences/settings endpoints and page with verified destination ownership, masked secret display and test delivery. Restrict Slack destination URLs and redirects through MR-11 policy; enforce entitlement on every channel.
- [ ] Persist one notification intent per causal event/channel/recipient; deliver channels independently with timeout, bounded exponential backoff and terminal failure status. A failed Slack delivery must not resend already accepted email.
- [ ] Add user-visible delivery status and operator retry tooling; distinguish mandatory security/billing notices from optional summaries. Debounce repeated unchanged health alerts and send recovery notices.
- [ ] Test duplicate events, partial email/Slack failure, missing address/settings, downgrade, revoked destination and template escaping. Verify delivery in controlled mailbox/Slack test destination only when explicitly authorized.

**Depends on:** MR-09, MR-11, MR-15.

## MR-19 — Operate workers, cron and recovery in production (P1, missing operational completion)

**Evidence/files:** `backend/src/app.module.ts`, `main.ts`, `health/health.controller.ts`, `queue/*`, crons, deployment workflow. HTTP/cron/workers share a process. Health always returns ok; uncaught exceptions are logged and execution continues. No default retry attempts/backoff configured. UI logs depend on a local `.bin/.runtime/backend.ndjson` file.

- [ ] Separate API and background-worker bootstraps or explicitly provision always-running worker compute with appropriate CPU lifecycle. Use a single/distributed-safe scheduler and durable catch-up; an API min-instance setting alone is not sufficient evidence of worker uptime.
- [ ] Define liveness separately from readiness. Check DB/Redis, schema compatibility and worker heartbeat/queue age with bounded probes. On uncaught exceptions mark unready, drain safely and exit for supervised restart; retain local expected socket-error handling.
- [ ] Configure retries by error class only after MR-02 idempotency; bounded backoff, terminal failure visibility, alerting and audited replay. Replace queue-wide scans with bounded indexes where scale warrants it.
- [ ] Ship structured logs centrally; user-facing activity should be persisted tenant-scoped events, not raw process logs. Redact sensitive data and partner identity. Measure queue age, SMTP/IMAP error rate, schedule freshness, seed health, cost and notification failure.
- [ ] Write tested runbooks for DB/Redis outage, provider revocation, backlog, emergency stop, restore, key rotation and rollback. Proposed pilot targets: API p95 <1s at agreed load, first eligible send <5min, critical alert within 5min; baseline and ratify before promising an SLA.
- [ ] Test worker restart mid-job, two replicas, Redis/DB interruptions and restored backup in isolated staging. Record measured RPO/RTO; never assume a backup works without restore.

**Depends on:** MR-02/03/06/15; operational design can start early.

## MR-20 — Align frontend contracts and truthful states (P1, fix)

**Evidence/files:** `frontend/src/app/(dashboard)/_lib/data.ts`, `frontend/src/lib/{types,activity-types,pool-activity-types,plan-config}.ts`, dashboard/inbox/pool components. Data helper expects scores absent from list API; `normal/aggressive` differ from backend `medium/fast`; seedCount is sum of percentages. Broad catch blocks turn outages into empty lists. `openedAt` is set by worker adding Seen, not independent human-read evidence; T029 remains a separate proposal.

- [ ] Publish typed API response contracts and validate representative payloads at boundaries. Return latest score/placement explicitly if list UI needs them; do not infer DNS success from absence of issue codes. Replace stale helpers or remove unused ones after caller audit.
- [ ] Render loading/empty/no-permission/error/stale/partial states distinctly; show retry actions and request IDs. Preserve user form input on transient failure. Paginate bounded server lists and implement polling backoff/cancellation/visibility handling.
- [ ] Use backend enums and actual seed counts. Label automated actions as automated; if implementing T029 record `seenBeforeAction` separately and explain that a Seen flag is not proof a human read the message. Avoid presenting simulated engagement as deliverability evidence.
- [ ] Replace unsafe DNS guidance such as placeholder MX advice with verified provider-specific instructions. Cover pending/removed/graduated/maintenance states, disabled features and no-pool capacity.
- [ ] Add browser tests for signup/connect/import/detail/pause/billing, error/401/503/empty cases, keyboard/focus and narrow viewport. Exercise real API responses, not only UI snapshots. Check accessibility and console errors.

**Depends on:** MR-07 plus finalized MR-05/13/16 contracts.

## MR-21 — Build account recovery, disconnect and privacy lifecycle (P1, missing)

**Evidence/files:** `frontend/src/lib/auth-server.ts`, sign-in/up screens, inbox/pool controllers, `db/schema.ts`, `common/crypto.ts`. No full recovery/email delivery configuration, user/account export/delete, warmed-inbox disconnect or consent-withdrawal workflow found. Pool removal preserves credentials. No retention worker found; warmup subjects persist (bodies are not stored in warmup_sends).

- [ ] Add verified email/password recovery with one-use expiring tokens, anti-enumeration responses, rate limits and session revocation; test delivery through platform mail. Make user-sync durable: signup's fire-and-forget hook currently logs failures without retry, leaving missing backend users. Add idempotent reconciliation before paid/connection workflows.
- [ ] Create reconnect/disconnect/delete APIs and UI. Disconnect disables scheduling/participation, closes cached connections and revokes/erases credentials appropriately. Deletion handles historical references with an explicit anonymization policy; no orphan jobs may regain access.
- [ ] Implement export, account deletion and consent withdrawal with recent authentication, durable request status and documented completion period. Include queues, logs, auth tables, pool credentials, model payloads and backup expiry in the data inventory.
- [ ] Implement the PRD's seven-day content-retention contract for any persisted subject/body/content artifacts, including logs and caches, or formally revise the policy. Separate non-content operational aggregates with explicit retention. Add privacy/terms/support pages reviewed for actual business practices and launch geography.
- [ ] Test failed sync/retry, reset enumeration/expiry/replay, account deletion during jobs, secret absence after disconnect, retention clock boundaries and backup retention behavior. Publish customer instructions and an operator fulfillment runbook.

**Depends on:** MR-07/08/10/15. Legal wording requires business/legal review; this audit does not assert jurisdictional compliance.

## MR-22 — Establish security and release-quality automation (P1, missing verification)

**Evidence/files:** `.github/workflows/ci.yml`, `backend/test/*`, backend/frontend package scripts. Fifty backend unit spec files exist; e2e auth fixture overrides the auth guard and only checks health. No frontend automated test runner is configured. Existing workflows omit key lint/e2e/security checks.

- [ ] Run backend typecheck/build/unit tests and non-mutating lint; frontend typecheck/build/lint and browser tests. Pin tool versions and dependencies; scan dependency/container vulnerabilities and secrets; review findings against actual runtime exposure, not raw severity counts alone.
- [ ] Add disposable PostgreSQL/Redis/SMTP/IMAP integration fixtures, shared production-equivalent HTTP bootstrap, and migration fixtures. Keep provider/Stripe test-mode staging checks separate from deterministic PR CI.
- [ ] Add negative tenant-isolation tests across all controllers, public callbacks, jobs and exports; real signature/auth tests must not override guards. Add schema/API contract and concurrent quota/schedule tests.
- [ ] Gate merge/deploy on the same tested artifact/commit. Include artifact secret-sentinel scan and container boot checks. Record flaky tests and fix them; do not hide them by excluding critical paths.
- [ ] Accept after clean-checkout CI passes and every P0 has a regression test at the boundary where it previously failed.

**Depends on:** MR-06 scaffolding; build alongside each corrective task.

## MR-23 — Complete commercial launch prerequisites (P1, missing evidence/workflows)

**Evidence:** `docs/01-product/PRD.md`, `docs/04-gtm/GTM-BRIEF.md`, provider OAuth scope settings in code. Source cannot prove cloud configuration, provider app acceptance, production Stripe state, licensed RBL access or business policy suitability.

- [ ] Reconcile one launch offer: supported providers, warmup purpose/consent, seed coverage, weekly/monthly quota, retention, maintenance availability and plan features. Remove unsupported agency/enterprise guarantees. Add public product/pricing/help/status/contact entry points distinct from the protected dashboard.
- [ ] Verify provider developer policy fit and required OAuth scope/app verification with actual intended warmup behavior. The broad Gmail mail scope needs review; do not assume verification or acceptable-use approval. Capture approved scope/redirect/domain configuration and restrictions; provider refusal requires product redesign, not evasion.
- [ ] Verify transactional sender authentication, provider accounts, licensed monitoring access, Stripe live catalog/portal, customer cancellation/refund/support procedures and production secrets without copying secrets into documentation.
- [ ] Complete privacy/terms/subprocessor/security disclosures with accountable business review. Record consent and abuse-report handling; do not promise guaranteed inbox placement or a quantified lift without evidence.
- [ ] Accept after each external dependency has an owner, dated evidence and support escalation route. An application build cannot satisfy this gate.

**Depends on:** product decisions from MR-14/16/17/21. **Reference:** [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

## MR-24 — Run controlled pilot and release acceptance (P1, missing verification)

**Files:** create sanitized evidence under `docs/07-market-readiness/verification/`; update RELEASE-GATES.md and STATUS.md.

- [ ] Use only controlled/consenting inboxes across supported providers and at least two tenants. Start after all P0 checks pass. Record signup-to-first-eligible-send, scheduling cap adherence, refresh survival, receipt/reply/filing outcomes and seed observation accuracy.
- [ ] Run at least a seven-day reliability soak covering worker restarts, nightly crons, trial expiry, payment transitions and provider failures; run a longer controlled four-week outcome cohort before claiming the PRD's week-four placement improvement. Separate product reliability from deliverability efficacy.
- [ ] Test paid upgrade, downgrade, cancellation, recovery, support, export/deletion and emergency stop. Include realistic volume/load and compare actual monthly infrastructure/seed/model/monitoring/payment costs with each plan's price.
- [ ] Publish sample sizes, baseline methodology, missing observations and uncertainty. Simulated opens, self-computed scores and a single successful email are not independent efficacy measures.
- [ ] Sign off the eight release gates, list accepted residual risks and freeze the tested artifact. Roll out gradually with named operational owner, alerts, rollback threshold and ability to stop sending immediately.

**Depends on:** all P0 and launch-scope P1 tasks. **Done evidence:** completed gate table with links to redacted logs/test reports and business sign-off.
