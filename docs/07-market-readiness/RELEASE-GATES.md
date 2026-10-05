# Delivery sequence and release acceptance

Baseline date: 2026-10-03. No gate is verified by this audit. Proposed targets below must be measured in staging; they are not existing service guarantees.

## Delivery order

| Stage | Work | Exit condition |
|---|---|---|
| 0: Contain and define contracts | MR-07 first; MR-01, MR-11; establish MR-15 schema ownership, MR-06 build repair and MR-22 test scaffolding | Browser has no signing authority; linking is bound to session; egress/imports are bounded; reliable local test harness |
| 1: Safe connected mail | MR-08, MR-09, MR-10, MR-02, MR-03, MR-12; corresponding MR-15 migrations | Provider refresh survives expiry; bounded consented sending; duplicate delivery controlled; bounce and kill switches work |
| 2: Honest measurements and payments | MR-04, MR-05, MR-13, MR-14, MR-16, MR-18 | Payments/entitlements reconcile; placement and health represent observed data and uncertainty |
| 3: Complete customer lifecycle | MR-17, MR-20, MR-21; finish MR-06, MR-19, MR-22 | Customer can onboard, use, pay, recover, disconnect and leave; repeatable deploy and recovery |
| 4: Market validation | MR-23 external approvals/product offer, then MR-24 pilot | All eight gates verified against the released artifact |

Start external prerequisite work in MR-23 early; provider review/seed provisioning can take longer than coding. These are dependency stages, not calendar estimates. Agents may work independently only after shared schema/API contracts are agreed. Assign one migration owner and one owner per shared file set; do not let separate agents each redefine inbox state or entitlements.

## Eight launch gates

| Gate | Required evidence | Current assessment |
|---|---|---|
| G1 Identity, isolation and security | No secrets in browser artifacts; real auth negative tests; replay-safe linking; tenant isolation; bounded inputs/egress; reviewed security findings | **Blocked**: MR-01/07/11 |
| G2 Provider connection and lifecycle | Gmail/Outlook/custom connect, import, refresh, reconnect, disconnect, consent and removal tested with controlled accounts | **Blocked**: MR-08/10/21 |
| G3 Safe and dependable warmup | Hard daily caps under concurrent scheduling; no blind SMTP retry; valid reply recipient; bounce pause; emergency stop; filing behavior accurately documented | **Blocked**: MR-02/03/12 |
| G4 Trustworthy health and readiness | Real seed coverage, correct category observations, RBL query types/errors, unknown/stale states, valid graduation/readiness rules | **Blocked**: MR-05/13/14/16 |
| G5 Payment and customer lifecycle | Signed webhook HTTP test + Stripe staging checkout/portal; no quota bypass; expired plan blocked; downgrade/cancel/recovery/export/delete work | **Blocked**: MR-04/09/21 |
| G6 Reproducible deployment and operations | CI for exact artifact, fresh/upgrade migrations, worker heartbeat, dependency readiness, centralized events, tested restore and rollback | **Blocked**: MR-06/15/19/22 |
| G7 Complete customer experience | Browser journeys pass; errors distinct from empty; correct API types/copy; accessible controls; notifications/settings/help/support available | **Blocked/unverified**: MR-18/20/21/23 |
| G8 Commercial and pilot acceptance | Provider/app/policy evidence, seed and monitoring provisioning, privacy/terms, supported offer, reliability soak, cost model and outcome-methodology evidence | **Unverified**: MR-23/24; no live account review performed |

**Verified completion: 0/8.** Do not replace “unverified” with “failed in production”; production was not inspected. Public launch requires all eight. A limited pilot still requires every P0 accepted plus test credentials, consent, controls and an operator response plan.

## Verification commands

Run from the repository root, using the pinned package manager established by MR-06. Current audit machine has Node 22.22.3; dependencies were absent and package fetching failed. These commands are the rerun procedure, not recorded successes. Use dedicated local/staging DB, Redis and test secrets. Never load production credentials for CI fixtures.

```sh
pnpm --dir backend install --frozen-lockfile
pnpm --dir frontend install --frozen-lockfile
pnpm --dir backend run typecheck
pnpm --dir backend exec jest --runInBand
pnpm --dir backend run build
pnpm --dir backend exec eslint 'src/**/*.ts' 'test/**/*.ts'
pnpm --dir frontend exec tsc --noEmit
pnpm --dir frontend run lint
pnpm --dir frontend run build
```

Backend `lint` currently uses `--fix`; the command above avoids mutating unrelated files during verification. Unit tests do not replace migration/protocol tests. In an isolated integration environment with validated test config and services:

```sh
pnpm --dir backend run db:migrate
pnpm --dir backend run test:e2e
```

Existing e2e coverage is insufficient (auth guard is overridden). MR-22 must extend the harness and configure frontend browser tests before this command family can count toward gates. After MR-06 Dockerfile repairs:

```sh
docker build -t emailwarm-api:audit ./backend
docker build -t emailwarm-web:audit ./frontend
```

Run resulting images with a staging environment contract, not embedded secrets. Verify startup, schema compatibility, API readiness, worker progress and frontend-to-API routing. Cloud deployment/real provider/Stripe checks are separate explicit staging operations.

## Required behavior scenarios

| Area | Scenario and expected result |
|---|---|
| Identity | User B supplies user A's inbox ID across each endpoint: 404/403 without data leak or mutation; guessed cookie does not create a session |
| OAuth | Tampered, stale, replayed and wrong-provider state all reject; canceled linking leaves no active account |
| Provider refresh | Access token expires while job queued: credential provider refreshes once, rotates token if returned, then sends; revoked consent pauses and requests reconnect |
| Imports | Two concurrent imports at cap: total accepted rows stay within plan and errors identify rejected rows; oversized file rejected before parse |
| Scheduler | Two replicas + repeated resume + late-day request: one schedule, unchanged day count, no burst and no overshoot |
| Delivery | Worker dies after SMTP acceptance: uncertainty is reconciled, not automatically resent; failed reply does not prevent safe recovery of filing |
| Consent | Pause/removal/withdrawal while delayed work exists: stale jobs cannot reactivate inbox or perform new unauthorized engagement |
| Safety | 3% confirmed bounce rate does not trigger >3% condition; 4% does; duplicate bounce does not double count; global stop halts new submissions |
| Monitoring | Resolver failure is unknown; RBL operational error is not listed; malformed DMARC is not pass; unsupported sending-IP measurement is clearly unknown |
| Placement | Known Primary/Promotions/Junk messages correctly classified; unreachable seed is observation error, not sender spam; successful observations survive timeout |
| Scores | Missing/pending/stale placement cannot graduate; one score row cannot stand in for a full observation window |
| Billing | Same event concurrently delivered 10 times: one state transition/notification; old event after cancellation cannot restore access |
| UI | 503 is shown as service failure; empty account shown only after successful empty response; automated opens are labeled accurately |
| Recovery | Auth user created while API down is eventually synchronized once; password reset token expires and cannot replay |
| Data lifecycle | Removed account's secrets erased/revoked per policy; queued jobs denied; retention sweeps remove eligible content and do not delete retained aggregate evidence |
| Operations | Kill worker/lose Redis/lose DB: health and alerts reflect failure; recovery respects dedupe/caps; restore and rollback are rehearsed |

## Evidence format and task completion

For each task create `verification/MR-NN.md` when work starts, with: owner; base and tested commit; environment; test accounts described without credentials; reproduction; change summary; exact commands; exit codes; test counts; relevant redacted outputs; live provider observations; migration and rollback; remaining limitations; reviewer and date. Attach screenshots only for UI evidence and redact addresses/tokens as appropriate. Do not commit secrets, raw mailbox content or provider refresh tokens.

Statuses: `open → in_progress → review → verified`; `blocked` requires a specific dependency and next action. `verified` means every task acceptance check has evidence; it does not automatically verify a whole release gate. On completion, update STATUS.md, the affected matrix row, historical tracker cross-reference and gate evidence. Never infer readiness from elapsed time or the number of checked boxes.

## Decisions already identified

Proposed defaults are instructions for implementation planning; business-contract changes need a recorded decision before publishing them.

- Browser API boundary: same-origin server proxy; backend credentials never available to browsers.
- Scope: Starter/Growth Phase 1 first; no team/white-label promises until implemented.
- Unknown measurements: unknown, with coverage and freshness; never fabricated success.
- SMTP ambiguity: explicit uncertain state, reconciliation and bounded manual handling; no exactly-once claim.
- Customer-controlled pause/consent: preserved on payment activation and analysis completion.
- Product decisions to resolve: weekly tests versus monthly quota; 70/80 graduation threshold; strict invisible-mail promise versus delayed filing; maintenance inclusion; actual RBL coverage; approved provider scope/use; retention by data category. Each is owned by its MR task, not silently decided by a coding agent.
