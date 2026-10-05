# EmailWarm: market readiness assessment

**Audited:** 3 October 2026, Asia/Kolkata · **Source baseline:** `0ad4c44` · **Decision: NOT READY for a public paid launch.**

The repository contains a substantial MVP: a Next.js dashboard, Better Auth login, a NestJS API, PostgreSQL/Drizzle persistence, BullMQ jobs, inbox imports, warmup actions, health monitoring, placement testing, AI diagnostics and Stripe integration. These are real implementations, not just screen mockups. However, several complete-looking features fail at integration boundaries or lack safeguards. Historical task completion is not equivalent to market readiness.

The highest priority is the authentication boundary: `frontend/src/lib/api.ts` reads `NEXT_PUBLIC_BETTER_AUTH_SECRET` to sign tokens in the browser. If configured with the backend secret, it enables token forgery; if omitted, client API calls have no token. Actual deployed exposure was not inspected. OAuth linking independently trusts unsigned state. These must be fixed before onboarding external users.

## Read this pack

1. [Feature inventory](FEATURE-MATRIX.md): what exists, gaps in existing work, missing capabilities, and scope boundaries.
2. [Findings and fix specifications](TASKS.md): 24 uniquely numbered work packages with source evidence, implementation instructions, dependencies and acceptance checks.
3. [Release and verification plan](RELEASE-GATES.md): delivery order, test commands, staging scenarios and operational launch criteria.
4. [Evidence and limitations](EVIDENCE.md): inspected paths, attempted checks, documentation discrepancies and official technical references.
5. [Live task status](STATUS.md): claim a task here before starting; update it with verification evidence when finishing.

## Completion status

The capability matrix has **20 launch capability groups**. **15 have substantial but incomplete implementation, 1 is an implemented foundation awaiting fresh verification, and 4 are absent as usable workflows.** Thus **16/20 (80%) have some implementation coverage**. This is a count of capability groups, **not 80% market readiness, work completed, or effort remaining**. Groups differ greatly in complexity. No reliable effort-based percentage can be inferred from this repository.

**Release acceptance: 0/8 gates verified in this audit.** Multiple gates have confirmed source blockers; others require staging evidence. **24/24 remediation/build work packages remain open.** Audit documentation is complete; application remediation has not begun.

The current stage is an **internal prototype / incomplete MVP**. Broad screens and services are present, but safe authentication, dependable provider connectivity, bounded sending, trustworthy health measurements, billing integrity and repeatable deployment still need work. A private pilot is appropriate only after the P0 gates pass.

## Scope used for this assessment

Target the PRD's Phase 1 self-service product: Starter/Growth users connect inboxes, consent to participation, receive bounded warmup and actionable monitoring, run reliable placement tests, pay/manage subscriptions, recover access, and disconnect/delete their data. Existing private-pool and bulk-import workflows are included because they are already exposed and must be safe.

Agency workspaces, seats, white label, public API keys, outbound customer webhooks, enterprise SSO and branded PDFs belong to later releases. Their absence is documented, but they are not prerequisites for a clearly scoped Starter/Growth launch. Do not sell agency-specific capabilities merely because an `agency` price or plan enum exists.

## How agents should use this

Claim a single MR task in STATUS.md. Read its evidence and dependencies in TASKS.md. Reconfirm the finding against current code before changing anything. Write a focused implementation plan and failing behavior tests for that task, then implement, verify and attach evidence. Record schema/API changes and unresolved issues in the same task. Completion requires acceptance checks and the relevant release gate; passing mocked unit tests alone is insufficient.

This pack supersedes historical readiness claims for release decisions. Keep `__specs__/SPEC-STATUS.md` as implementation history; its duplicate T028 numbering and stale status notes must not be copied into new task IDs. Use `MR-01` through `MR-24` for this remediation cycle.
