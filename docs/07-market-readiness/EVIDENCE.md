# Audit evidence and confidence

**Date:** 2026-10-03 (Asia/Kolkata). **Git baseline:** `0ad4c44`. **Scope:** source/config/spec audit with targeted primary-documentation checks. This is not a penetration test, production infrastructure audit, live provider certification or a guarantee of exhaustive defect discovery.

## Repository facts and verification attempts

| Check | Observed result |
|---|---|
| `git rev-parse --show-toplevel` | This project directory is the git root, not a parent monorepo |
| Initial `git status --short` | Five pre-existing untracked architecture/dataflow HTML/PNG artifacts; left untouched |
| File inventory | Separate backend/frontend pnpm lockfiles, no backend package-lock; five application SQL migrations; 50 backend `*.spec.ts` files and two e2e spec files |
| Runtime/tooling | Node v22.22.3; root `pnpm --version` reports inherited yarn configuration; package-directory commands invoke pnpm successfully but try automatic dependency installation |
| Dependency availability | `backend/node_modules/.bin/jest` and `frontend/node_modules/.bin/next` absent before attempts |
| Backend attempt | `pnpm test -- --runInBand` in backend entered automatic dependency installation; registry requests failed `ENOTFOUND` / `ERR_PNPM_META_FETCH_FAIL`; stopped with SIGINT (130) after repeated retries; Jest never ran |
| Frontend attempt | `pnpm run build` in frontend entered automatic dependency installation; same registry failures; stopped with SIGINT (130); Next build never ran |
| Fresh runtime test/build result | **Unavailable**, not a source-code test failure and not a pass |
| Live services/provider/Stripe/cloud inspection | Not performed; no mail sent, payment created, production mutation or deployment attempted |
| Source modifications | Documentation only; package lockfiles/application code were not edited. Partial ignored dependency-cache artifacts may exist from package-manager attempts |

Because dependency resolution was blocked, no frontend screenshots, runtime exploit proof, build pass, coverage percentage or fresh test count is claimed. Historical 546/546-style results in the old tracker are historical only. Counting test declarations or files is not executing tests.

## Evidence navigation

Each task includes exact files and function names. Re-run these read-only searches to locate the most important findings after line numbers change:

```sh
rg -n 'NEXT_PUBLIC_BETTER_AUTH_SECRET|mintBearerToken' frontend/src
rg -n '@Public|anonymous|base64url|callback' backend/src/inbox/inbox.controller.ts
rg -n 'redirectUri|scope:' backend/src/inbox/oauth
rg -n 'token-refresh|@Processor' backend/src
rg -n 'sendReply|sendMail|repliedAt|messageMove' backend/src/warmup
rg -n 'scheduleInbox|warmupDay: warmupDay|Math.max\(0|MAX_SPACING' backend/src/warmup/warmup.service.ts
rg -n 'rawBody|bodyParser.raw|dispatch\(event\)|stripeEvents' backend/src/main.ts backend/src/billing
rg -n 'poolConsentAt|dkim: true|assertInboxLimit|batchUpload' backend/src/inbox/inbox.service.ts
rg -n 'status: .active.|softDelete' backend/src/analysis/analysis.service.ts backend/src/pool-inbox/pool-inbox.service.ts
rg -n 'secure:|port:|oauthAccessToken|imapHost' backend/src/inbox/smtp backend/src/inbox/imap
rg -n 'startsWith|isClean|const query' backend/src/monitor/blacklist.service.ts
rg -n 'catch|seedCount|normal|aggressive|score' 'frontend/src/app/(dashboard)/_lib/data.ts'
rg -n 'projects/email-warmup|CLERK|steps.auth|npm ci' .github/workflows backend/Dockerfile
```

## Confirmed source behavior versus inference

- **Directly present in source:** browser public-secret reference; unsigned callback state; no `to` in reply; no token-refresh processor; unconditional active transition after analysis; quota omission in warmed inbox batch path; status-only pool removal; repeated resume scheduling; rawBody field mismatch; deployment path/auth drift; eight RBL entries.
- **Consequences inferred from code/contracts, requiring runtime regression confirmation:** forgery if the public secret matches the backend; reply recipient failure; Gmail placement failure without mailbox selection; Outlook transport mismatch; duplicates after partial side effects; late analysis resurrection; RBL error causing false positive. TASKS.md states the tests required.
- **External state unknown:** whether a public secret was ever deployed, actual seed inventory, provider verification, live Stripe setup, cloud IAM/secret resources, traffic/load, backup status and customer consent evidence. No claim of compromise or actual production outage is made.
- **Missing-work searches:** no bounce workflow, maintenance scheduler, weekly placement scheduler, full account deletion/export/recovery delivery or self-service Slack settings found in the inspected source. Existing types/tables/templates are not end-to-end workflows.

## Existing documentation discrepancies

1. `__specs__/SPEC-STATUS.md` marks many tasks done while Phase 1 release gates remain unchecked; Wave 0 rows and status disagree. T028 is assigned to both pause/resume and pool activity work. This audit uses new MR IDs and preserves history.
2. PRD says explicit pool consent; `runPrecheck` assigns consent on health success. PRD's >3% bounce auto-pause and maintenance mode are not implemented.
3. PRD promises 100+ RBLs; eight zones are listed. The issue is also query correctness, not just list size.
4. Weekly placement promise conflicts with Starter's one monthly test. Graduation implementation threshold 70 differs from PRD's completion-score target 80; record the intended product rule rather than changing silently.
5. T029 proposes real Seen detection; current `openedAt` records the application's own Seen action. This is not evidence of a human read or independent placement improvement.
6. The tracker says resume drains then requeues; current source reschedules without draining and advances the day. Trust current implementation over prose.
7. Old tracker issue says null placement counts yield NaN. PostgreSQL/JS null multiplied by a number coerces to 0; undefined can produce NaN. The more precise defect is weak validation and misleading incomplete-data handling, not a proven NaN for database null alone.
8. `_lib/data.ts` has stale DNS/blacklist/placement helpers and seedCount math; no external callers for those three helpers were found in the final search. Treat them as latent contract debt, while list-score/type and swallowed-error issues affect active helpers. Do not report unused code as demonstrated current UI output.
9. Broad `https://mail.google.com/` access and authentication-deprecation assertions in the old PRD must be verified against current provider requirements; this audit does not repeat historical dates as fact.

## Technical references checked

These primary sources validate library/protocol guidance; they do not prove this application was deployed or provider-approved. Checked 2026-10-03; recheck against pinned versions when implementing.

- [Next.js environment variables](https://nextjs.org/docs/pages/guides/environment-variables): NEXT_PUBLIC references can be inlined into browser bundles. Supports MR-07's public-secret risk and MR-06 build configuration.
- [Nest raw body](https://docs.nestjs.com/faq/raw-body): supported rawBody capture for signature verification. Supports MR-04's bootstrap fix.
- [Stripe webhooks](https://docs.stripe.com/webhooks): original-body verification, duplicate delivery and event ordering considerations. Supports transactional dedupe/reconciliation rather than dispatch-before-dedupe.
- [Nodemailer SMTP](https://nodemailer.com/smtp): implicit TLS versus STARTTLS transport configuration. Supports MR-08 provider configuration.
- [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/): selected-mailbox operations, mailbox locks and UID-based calls. Supports MR-02/MR-05 protocol integration tests.
- [BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs): retry-safe work must preserve intended final state. Supports MR-02/MR-03/MR-19; it does not make SMTP exactly once.
- [Spamhaus query documentation](https://docs.spamhaus.com/datasets/docs/source/70-access-methods/data-query-service/040-dqs-queries.html): distinguishes query formats and operational return codes. Supports MR-13; error-code replies must not be treated as reputational listings.
- [Google Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes): restricted access scope requirements. Supports MR-23's verification work; no assertion that the intended product is approved.

## Documentation validation

A local Python consistency check verified all six audit Markdown files, 24 unique sequential MR task IDs, all local Markdown links, all task references, 12 P0/12 P1 accounting and the 20-row capability breakdown (15 partial, 1 foundation, 4 missing). The work board contains every task once. `git diff --check` was rerun after removing trailing whitespace from the updated index. This validates documentation structure, not application behavior.
