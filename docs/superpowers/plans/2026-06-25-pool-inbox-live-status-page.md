# Pool Inbox Live Status + Full-Page Detail View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cramped `PoolInboxDetailPanel` drawer with a dedicated `/pool/[id]` full page, and add a "Live Status" panel backed by real BullMQ `warmup-receive` job state so users can see in-flight and upcoming open/star/reply/rescue activity, not just post-hoc history.

**Architecture:** A new `QueueService.getJobsForReceiver()` method reads BullMQ job state (active/delayed/waiting) for the `warmup-receive` queue, filtered by `data.receiverId`. A new `PoolInboxActivityService.getLiveStatus()` method (same module as the existing 5 T028 endpoints) wraps it, resolves sender emails, and returns `{ active, upcoming }`. The frontend gets a new `/pool/[id]` route mirroring the existing `/inboxes/[id]` page pattern, with a `LiveStatusPanel` (polling via the existing `usePolling` hook) above a 4-tab body (Activity default, Health, Pairings, Logs) built from the same tab components the drawer already uses.

**Tech Stack:** NestJS, Drizzle ORM, BullMQ, Next.js 15 App Router, React, Tailwind.

## Global Constraints

- Never store plaintext credentials — not touched by this plan, but the new `connection-summary`-adjacent code must continue returning only non-secret fields.
- Never open a new IMAP connection per action — not applicable here (this plan only reads BullMQ job metadata, no IMAP calls).
- All new/modified API routes need test coverage (project convention, `.claude/CLAUDE.md`).
- Ownership-checked 404 on all new endpoints — never distinguish "not found" from "not yours" (existing `assertPoolOwnership` pattern in `PoolInboxActivityService`).
- Run `npx tsc --noEmit` (backend and frontend) before considering any task done.
- No frontend test framework exists in this project — frontend changes are verified via typecheck + lint + build + live Playwright check against the running dev stack, not unit tests.

---

## File Structure

**Backend — new:**
- None (all changes land in existing files/modules)

**Backend — modified:**
- `backend/src/queue/queue.service.ts` — add `getJobsForReceiver(queueName, receiverId, states)`
- `backend/src/queue/queue.service.spec.ts` — tests for the above
- `backend/src/pool-inbox-activity/pool-inbox-activity.service.ts` — add `getLiveStatus(poolInboxId, userId)`, inject `QueueService`
- `backend/src/pool-inbox-activity/pool-inbox-activity.service.spec.ts` — tests for the above
- `backend/src/pool-inbox-activity/pool-inbox-activity.module.ts` — import `QueueModule`
- `backend/src/pool-inbox-activity/pool-inbox-activity.controller.ts` — add `GET /pool-inboxes/:id/live-status`
- `backend/src/pool-inbox/pool-inbox.service.ts` — add `findById(userId, id)`
- `backend/src/pool-inbox/pool-inbox.service.spec.ts` — tests for the above
- `backend/src/pool-inbox/pool-inbox.controller.ts` — add `GET /pool-inboxes/:id`
- `backend/src/pool-inbox/pool-inbox.controller.spec.ts` — tests for the above

**Frontend — new:**
- `frontend/src/lib/pool-activity-types.ts` — add `PoolLiveStatus`/`PoolLiveJob` types (file already exists, extend it)
- `frontend/src/app/(dashboard)/_lib/data.ts` — add `getPoolInbox(id)` (file already exists, extend it)
- `frontend/src/app/(dashboard)/pool/[id]/page.tsx` — new page
- `frontend/src/app/(dashboard)/pool/[id]/_components/PoolDetailTabs.tsx` — tab bar shell
- `frontend/src/app/(dashboard)/pool/[id]/_components/PoolHealthTab.tsx` — extracted from the old drawer's inline `HealthTab`
- `frontend/src/app/(dashboard)/pool/[id]/_components/LiveStatusPanel.tsx` — new

**Frontend — modified:**
- `frontend/src/app/(dashboard)/pool/_components/PoolInboxGrid.tsx` — row click navigates instead of opening drawer
- `frontend/src/app/(dashboard)/pool/_components/PoolActivityTab.tsx` — no change needed, just imported by the new tab shell
- `frontend/src/app/(dashboard)/pool/_components/PoolPairingsTab.tsx` — no change needed
- `frontend/src/app/(dashboard)/pool/_components/PoolLogsTab.tsx` — no change needed
- `frontend/src/app/(dashboard)/pool/_components/ConnectionSummaryStrip.tsx` — no change needed

**Frontend — removed:**
- `frontend/src/app/(dashboard)/pool/_components/PoolInboxDetailPanel.tsx` — deleted once its content is fully migrated (Task 8)

---

## Task 1: `QueueService.getJobsForReceiver`

**Files:**
- Modify: `backend/src/queue/queue.service.ts`
- Test: `backend/src/queue/queue.service.spec.ts`

**Interfaces:**
- Consumes: BullMQ `Queue.getJobs(states)` (already used by `removeJobsForReceiver`, same file).
- Produces: `getJobsForReceiver(queueName: QueueName, receiverId: string, states: JobState[]): Promise<Job[]>` — a plain array of raw BullMQ `Job` objects (callers read `.id`, `.data`, `.processedOn` directly). `JobState` is BullMQ's own exported type (`'active' | 'delayed' | 'waiting' | ...`).

- [ ] **Step 1: Write the failing test**

Add to `backend/src/queue/queue.service.spec.ts`, after the existing `removeJobsForReceiver` describe block (before the closing `});` of the outer `describe('QueueService', ...)`):

```ts
  describe('getJobsForReceiver', () => {
    it('returns only jobs whose data.receiverId matches, for the given states', async () => {
      const matching = { id: 'job-1', data: { receiverId: 'pool-1' } };
      const other = { id: 'job-2', data: { receiverId: 'pool-2' } };
      mockQueue.getJobs.mockResolvedValue([matching, other]);

      const result = await service.getJobsForReceiver('warmup-receive', 'pool-1', [
        'active',
        'delayed',
        'waiting',
      ]);

      expect(mockQueue.getJobs).toHaveBeenCalledWith(['active', 'delayed', 'waiting']);
      expect(result).toEqual([matching]);
    });

    it('returns an empty array when no jobs match', async () => {
      const other = { id: 'job-2', data: { receiverId: 'pool-2' } };
      mockQueue.getJobs.mockResolvedValue([other]);

      const result = await service.getJobsForReceiver('warmup-receive', 'pool-1', ['active']);

      expect(result).toEqual([]);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest queue.service.spec.ts -t "getJobsForReceiver"`
Expected: FAIL with `TypeError: service.getJobsForReceiver is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/queue/queue.service.ts`, add this method after `removeJobsForReceiver` (which ends around line 90):

```ts
  /**
   * Returns the raw BullMQ jobs from `queueName` in the given states whose
   * payload identifies `receiverId` as the receiver. Read-only — unlike
   * `removeJobsForReceiver`, this does not remove anything. Used by the
   * pool inbox "Live Status" panel to show in-flight/upcoming
   * warmup-receive activity (T028 follow-up: live status panel).
   */
  async getJobsForReceiver(
    queueName: QueueName,
    receiverId: string,
    states: Parameters<Queue['getJobs']>[0],
  ): Promise<ReturnType<Queue['getJobs']> extends Promise<infer T> ? T : never> {
    const queue = this.getQueue(queueName);
    const jobs = await queue.getJobs(states);
    return jobs.filter((job) => job.data.receiverId === receiverId) as any;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest queue.service.spec.ts`
Expected: PASS, all tests in the file green (existing + 2 new)

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/queue/queue.service.ts src/queue/queue.service.spec.ts
git commit -m "feat(queue): add getJobsForReceiver for read-only job state lookup"
```

---

## Task 2: `PoolInboxActivityService.getLiveStatus`

**Files:**
- Modify: `backend/src/pool-inbox-activity/pool-inbox-activity.service.ts`
- Modify: `backend/src/pool-inbox-activity/pool-inbox-activity.module.ts`
- Test: `backend/src/pool-inbox-activity/pool-inbox-activity.service.spec.ts`

**Interfaces:**
- Consumes: `QueueService.getJobsForReceiver('warmup-receive', poolInboxId, [...])` (Task 1). `this.assertPoolOwnership(poolInboxId, userId)` (existing method, same file). `db.select()` against `warmupSends` and `inboxes` tables (existing Drizzle imports, same file).
- Produces:
  ```ts
  export interface PoolLiveJob {
    jobId: string;
    actions: string[];
    senderEmail: string | null;
    executeAt: string;
    state: 'active' | 'delayed' | 'waiting';
  }
  export interface PoolLiveStatus {
    active: PoolLiveJob[];
    upcoming: PoolLiveJob[];
  }
  ```
  Method signature: `getLiveStatus(poolInboxId: string, userId: string | undefined): Promise<PoolLiveStatus>`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/pool-inbox-activity/pool-inbox-activity.service.spec.ts`. First, add a `QueueService` mock — modify the test file's setup. Find this block near the top of the file:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PoolInboxActivityService } from './pool-inbox-activity.service';
import { db } from '../db';
import { pinoLoggerStubsFor } from '../common/test-module';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));
```

Replace it with (adding the `QueueService` import and mock):

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PoolInboxActivityService } from './pool-inbox-activity.service';
import { QueueService } from '../queue/queue.service';
import { db } from '../db';
import { pinoLoggerStubsFor } from '../common/test-module';

jest.mock('../db', () => ({
  db: {
    select: jest.fn(),
  },
}));
```

Then find the `beforeEach` block:

```ts
  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(NotFoundException, PoolInboxActivityService),
        PoolInboxActivityService,
      ],
    }).compile();

    service = module.get<PoolInboxActivityService>(PoolInboxActivityService);
  });
```

Replace it with (adding a `queueService` mock and providing it):

```ts
  let queueService: { getJobsForReceiver: jest.Mock };

  beforeEach(async () => {
    jest.resetAllMocks();

    queueService = { getJobsForReceiver: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...pinoLoggerStubsFor(NotFoundException, PoolInboxActivityService),
        PoolInboxActivityService,
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<PoolInboxActivityService>(PoolInboxActivityService);
  });
```

Now add a new describe block at the end of the file, just before the final closing `});` of `describe('PoolInboxActivityService', ...)`:

```ts
  // -----------------------------------------------------------------
  //  getLiveStatus
  // -----------------------------------------------------------------
  describe('getLiveStatus', () => {
    it('throws NotFound when the pool inbox is missing or not owned', async () => {
      mockSelectChain([]);
      await expect(service.getLiveStatus(POOL_ID, USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns empty active/upcoming when no jobs are queued', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership
      queueService.getJobsForReceiver.mockResolvedValue([]);

      const result = await service.getLiveStatus(POOL_ID, USER_ID);

      expect(result).toEqual({ active: [], upcoming: [] });
      expect(queueService.getJobsForReceiver).toHaveBeenCalledWith('warmup-receive', POOL_ID, [
        'active',
        'delayed',
        'waiting',
      ]);
    });

    it('splits jobs into active vs upcoming by BullMQ state, resolves sender email, sorts upcoming by executeAt ascending, caps upcoming at 5', async () => {
      mockSelectChain([{ id: POOL_ID, userId: USER_ID }]); // ownership

      const now = Date.now();
      function makeJob(id: string, state: string, executeAt: string, messageId: string) {
        return {
          id,
          getState: jest.fn().mockResolvedValue(state),
          data: { actions: ['open', 'star'], executeAt, messageId },
        };
      }
      const activeJob = makeJob('job-active', 'active', new Date(now).toISOString(), '<m1>');
      const upcomingJobs = Array.from({ length: 6 }, (_, i) =>
        makeJob(
          `job-up-${i}`,
          'delayed',
          new Date(now + (6 - i) * 60_000).toISOString(),
          `<m-up-${i}>`,
        ),
      );
      queueService.getJobsForReceiver.mockResolvedValue([activeJob, ...upcomingJobs]);

      // Batched lookup: warmup_sends rows for all messageIds, then inboxes for senderInboxId -> email.
      mockSelectChain(
        [activeJob, ...upcomingJobs].map((j) => ({
          messageId: j.data.messageId,
          senderInboxId: `sender-${j.id}`,
        })),
      );
      mockSelectChain(
        [activeJob, ...upcomingJobs].map((j) => ({
          id: `sender-${j.id}`,
          email: `${j.id}@example.com`,
        })),
      );

      const result = await service.getLiveStatus(POOL_ID, USER_ID);

      expect(result.active).toHaveLength(1);
      expect(result.active[0]).toMatchObject({
        jobId: 'job-active',
        senderEmail: 'job-active@example.com',
        state: 'active',
      });

      // Capped at 5, sorted ascending by executeAt (soonest first = job-up-5
      // which has the smallest offset, 1 minute).
      expect(result.upcoming).toHaveLength(5);
      expect(result.upcoming[0].jobId).toBe('job-up-5');
      expect(result.upcoming[4].jobId).toBe('job-up-1');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest pool-inbox-activity.service.spec.ts -t "getLiveStatus"`
Expected: FAIL with `TypeError: service.getLiveStatus is not a function` (and the constructor/module compile may also fail until Step 3 wires `QueueService` into the real constructor — that's expected, fix in Step 3)

- [ ] **Step 3: Write minimal implementation**

In `backend/src/pool-inbox-activity/pool-inbox-activity.service.ts`:

Add the import near the top, alongside the existing imports:

```ts
import { QueueService } from '../queue/queue.service';
```

Add the two new exported interfaces near the other exported interfaces (after `PoolPairingRow`, before `PoolLogLine`):

```ts
export interface PoolLiveJob {
  jobId: string;
  actions: string[];
  senderEmail: string | null;
  executeAt: string;
  state: 'active' | 'delayed' | 'waiting';
}

export interface PoolLiveStatus {
  active: PoolLiveJob[];
  upcoming: PoolLiveJob[];
}
```

Update the constructor to inject `QueueService`:

```ts
  constructor(
    @InjectPinoLogger(PoolInboxActivityService.name)
    private readonly logger: PinoLogger,
    private readonly queueService: QueueService,
  ) {}
```

Add the new method at the end of the class, just before the closing `}` of `PoolInboxActivityService` (after `getLogs`):

```ts
  // -------------------------------------------------------------------
  //  /live-status — in-flight + upcoming warmup-receive jobs (BullMQ)
  // -------------------------------------------------------------------

  /**
   * Reads real BullMQ job state for the `warmup-receive` queue, filtered
   * to this pool inbox as the receiver. No DB writes, no IMAP calls —
   * this only reports what the queue already knows. `active` is jobs
   * currently being processed by a worker; `upcoming` is queued/delayed
   * jobs, soonest-first, capped at 5 (this is a glance-level indicator,
   * not a full job browser).
   */
  async getLiveStatus(
    poolInboxId: string,
    userId: string | undefined,
  ): Promise<PoolLiveStatus> {
    await this.assertPoolOwnership(poolInboxId, userId);

    const jobs = await this.queueService.getJobsForReceiver('warmup-receive', poolInboxId, [
      'active',
      'delayed',
      'waiting',
    ]);

    if (jobs.length === 0) {
      return { active: [], upcoming: [] };
    }

    const messageIds = jobs
      .map((j: any) => j.data?.messageId as string | undefined)
      .filter((v: unknown): v is string => Boolean(v));
    const senderEmailByMessageId = await this.resolveSenderEmailsByMessageId(messageIds);

    const withState: Array<PoolLiveJob & { _job: any }> = [];
    for (const job of jobs as any[]) {
      const state = (await job.getState()) as 'active' | 'delayed' | 'waiting';
      withState.push({
        jobId: String(job.id),
        actions: Array.isArray(job.data?.actions) ? job.data.actions : [],
        senderEmail: senderEmailByMessageId.get(job.data?.messageId) ?? null,
        executeAt: job.data?.executeAt ?? new Date().toISOString(),
        state,
        _job: job,
      });
    }

    const active = withState.filter((j) => j.state === 'active').map(stripJob);
    const upcoming = withState
      .filter((j) => j.state !== 'active')
      .sort((a, b) => (a.executeAt < b.executeAt ? -1 : a.executeAt > b.executeAt ? 1 : 0))
      .slice(0, 5)
      .map(stripJob);

    return { active, upcoming };
  }

  /** Batched messageId -> senderEmail resolve, used by getLiveStatus. */
  private async resolveSenderEmailsByMessageId(
    messageIds: string[],
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    if (messageIds.length === 0) return result;

    const sendRows = await db
      .select({ messageId: warmupSends.messageId, senderInboxId: warmupSends.senderInboxId })
      .from(warmupSends)
      .where(inArray(warmupSends.messageId, messageIds));

    const senderIds = Array.from(
      new Set(sendRows.map((r) => r.senderInboxId).filter((v): v is string => Boolean(v))),
    );
    if (senderIds.length === 0) return result;

    const inboxRows = await db
      .select({ id: inboxes.id, email: inboxes.email })
      .from(inboxes)
      .where(inArray(inboxes.id, senderIds));
    const emailById = new Map(inboxRows.map((r) => [r.id, r.email]));

    for (const row of sendRows) {
      if (!row.messageId || !row.senderInboxId) continue;
      const email = emailById.get(row.senderInboxId);
      if (email) result.set(row.messageId, email);
    }
    return result;
  }
```

Add a module-level helper function `stripJob` near the top of the file, after the `PINO_LEVEL_NAMES` constant:

```ts
function stripJob<T extends { _job: unknown }>(j: T): Omit<T, '_job'> {
  const { _job, ...rest } = j;
  return rest;
}
```

Finally, update `backend/src/pool-inbox-activity/pool-inbox-activity.module.ts` to import `QueueModule` so `QueueService` can be injected:

```ts
import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { PoolInboxActivityController } from './pool-inbox-activity.controller';
import { PoolInboxActivityService } from './pool-inbox-activity.service';

@Module({
  imports: [QueueModule],
  controllers: [PoolInboxActivityController],
  providers: [PoolInboxActivityService],
})
export class PoolInboxActivityModule {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest pool-inbox-activity.service.spec.ts`
Expected: PASS, all tests in the file green (existing 14 + 3 new)

Also run the full suite to confirm the constructor change (adding `QueueService`) didn't break anything that constructs `PoolInboxActivityService` elsewhere:

Run: `cd backend && npx jest`
Expected: PASS, all suites green

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/pool-inbox-activity/pool-inbox-activity.service.ts src/pool-inbox-activity/pool-inbox-activity.service.spec.ts src/pool-inbox-activity/pool-inbox-activity.module.ts
git commit -m "feat(pool-inbox-activity): add getLiveStatus reading real BullMQ job state"
```

---

## Task 3: `GET /pool-inboxes/:id/live-status` endpoint

**Files:**
- Modify: `backend/src/pool-inbox-activity/pool-inbox-activity.controller.ts`
- Test: new file `backend/src/pool-inbox-activity/pool-inbox-activity.controller.spec.ts`

**Interfaces:**
- Consumes: `PoolInboxActivityService.getLiveStatus(id, userId)` (Task 2).
- Produces: `GET /pool-inboxes/:id/live-status` → `PoolLiveStatus` JSON body, behind `BetterAuthGuard`.

- [ ] **Step 1: Write the failing test**

This module has no existing controller spec — create `backend/src/pool-inbox-activity/pool-inbox-activity.controller.spec.ts`:

```ts
import { Test, TestingModule } from '@nestjs/testing';
import { PoolInboxActivityController } from './pool-inbox-activity.controller';
import { PoolInboxActivityService } from './pool-inbox-activity.service';
import { pinoLoggerStubsFor } from '../common/test-module';

describe('PoolInboxActivityController', () => {
  let controller: PoolInboxActivityController;
  let service: Record<string, jest.Mock>;

  function makeReq(userId: string) {
    return { userId } as any;
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    service = {
      getConnectionSummary: jest.fn(),
      getActivity: jest.fn(),
      getActivityStats: jest.fn(),
      getPairings: jest.fn(),
      getLogs: jest.fn(),
      getLiveStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PoolInboxActivityController],
      providers: [
        ...pinoLoggerStubsFor(PoolInboxActivityController, PoolInboxActivityService),
        { provide: PoolInboxActivityService, useValue: service },
      ],
    }).compile();

    controller = module.get<PoolInboxActivityController>(PoolInboxActivityController);
  });

  describe('GET /pool-inboxes/:id/live-status', () => {
    it('delegates to PoolInboxActivityService.getLiveStatus and returns the result', async () => {
      const payload = { active: [], upcoming: [] };
      service.getLiveStatus.mockResolvedValue(payload);

      const result = await controller.liveStatus(makeReq('user-1'), 'pool-1');

      expect(service.getLiveStatus).toHaveBeenCalledWith('pool-1', 'user-1');
      expect(result).toEqual(payload);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest pool-inbox-activity.controller.spec.ts`
Expected: FAIL with `TypeError: controller.liveStatus is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/pool-inbox-activity/pool-inbox-activity.controller.ts`, add this method after `logs` (the last method in the class, before the closing `}` of `PoolInboxActivityController`):

```ts
  /**
   * Real-time-ish status — what's actively processing or queued right
   * now for this pool inbox's warmup-receive jobs, read directly from
   * BullMQ. Frontend polls this every few seconds while the detail page
   * is open (see `LiveStatusPanel.tsx`).
   */
  @Get(':id/live-status')
  async liveStatus(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.activity.getLiveStatus(id, req.userId);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest pool-inbox-activity.controller.spec.ts`
Expected: PASS

Run: `cd backend && npx jest`
Expected: PASS, all suites green

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/pool-inbox-activity/pool-inbox-activity.controller.ts src/pool-inbox-activity/pool-inbox-activity.controller.spec.ts
git commit -m "feat(pool-inbox-activity): add GET /pool-inboxes/:id/live-status endpoint"
```

---

## Task 4: `PoolInboxService.findById` + `GET /pool-inboxes/:id`

**Files:**
- Modify: `backend/src/pool-inbox/pool-inbox.service.ts`
- Modify: `backend/src/pool-inbox/pool-inbox.controller.ts`
- Test: `backend/src/pool-inbox/pool-inbox.service.spec.ts`
- Test: `backend/src/pool-inbox/pool-inbox.controller.spec.ts`

**Interfaces:**
- Consumes: `db.select(SAFE_POOL_INBOX_COLUMNS).from(poolInboxes)` (existing, same file). `getLatestAnalysisForPoolInbox(poolInboxId)` (existing, `@/analysis/analysis.service`).
- Produces: `PoolInboxService.findById(userId: string, id: string): Promise<SAFE_POOL_INBOX_COLUMNS row | null>` (null, not throw, on not-found/not-owned — controller maps to 404, same pattern as `InboxService.findById`). `GET /pool-inboxes/:id` → pool inbox row with `analysis` attached, or 404.

This page needs the same single-row "give me this pool inbox" lookup the
`/pool/[id]` page will call server-side — exactly mirroring how
`InboxService.findById` + `GET /inboxes/:id` work today.

- [ ] **Step 1: Write the failing test**

Add to `backend/src/pool-inbox/pool-inbox.service.spec.ts`, after the existing `findByUser` describe block:

```ts
  describe('findById', () => {
    it('returns null when the pool inbox does not exist', async () => {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      });

      const result = await service.findById('user-1', 'missing-id');
      expect(result).toBeNull();
    });

    it('returns null when the pool inbox belongs to another user', async () => {
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([{ id: 'pi-1', userId: 'other-user' }]),
      });

      const result = await service.findById('user-1', 'pi-1');
      expect(result).toBeNull();
    });

    it('returns the row when owned by the requesting user', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'pool@example.com' };
      (db.select as jest.Mock).mockReturnValue({
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([row]),
      });

      const result = await service.findById('user-1', 'pi-1');
      expect(result).toEqual(row);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx jest pool-inbox.service.spec.ts -t "findById"`
Expected: FAIL with `TypeError: service.findById is not a function`

- [ ] **Step 3: Write minimal implementation**

In `backend/src/pool-inbox/pool-inbox.service.ts`, add this method right after `findByUser`:

```ts
  /**
   * Ownership-checked single-row lookup for `GET /pool-inboxes/:id`.
   * Returns null (not throw) when not found/not owned — the controller
   * maps that to a 404. Mirrors `InboxService.findById`.
   */
  async findById(userId: string, id: string) {
    const rows = await db
      .select(SAFE_POOL_INBOX_COLUMNS)
      .from(poolInboxes)
      .where(eq(poolInboxes.id, id))
      .limit(1);
    const row = rows[0];
    if (!row || row.userId !== userId) return null;
    return row;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && npx jest pool-inbox.service.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd backend
git add src/pool-inbox/pool-inbox.service.ts src/pool-inbox/pool-inbox.service.spec.ts
git commit -m "feat(pool-inbox): add ownership-checked findById lookup"
```

- [ ] **Step 6: Write the failing controller test**

Add to `backend/src/pool-inbox/pool-inbox.controller.spec.ts`. First, find the `jest.mock('@/analysis/analysis.service', ...)` block near the top:

```ts
jest.mock('@/analysis/analysis.service', () => ({
  getLatestAnalysisForPoolInboxes: jest.fn(),
}));
```

Replace it with (adding the singular import the new endpoint needs):

```ts
jest.mock('@/analysis/analysis.service', () => ({
  getLatestAnalysisForPoolInboxes: jest.fn(),
  getLatestAnalysisForPoolInbox: jest.fn(),
}));
```

Update the top-of-file import line:

```ts
import { getLatestAnalysisForPoolInboxes } from '@/analysis/analysis.service';
```

to:

```ts
import {
  getLatestAnalysisForPoolInboxes,
  getLatestAnalysisForPoolInbox,
} from '@/analysis/analysis.service';
```

Add `findById: jest.fn(),` to the `service = { ... }` object in `beforeEach`, alongside the existing `findByUser: jest.fn(),`.

Then add a new describe block after the existing `describe('GET /pool-inboxes', ...)` block:

```ts
  describe('GET /pool-inboxes/:id', () => {
    it('returns the pool inbox row with its latest analysis attached when owned by the requesting user', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'a@domain.com' };
      const analysisRow = { id: 'analysis-1', poolInboxId: 'pi-1', healthScore: 90 };
      service.findById.mockResolvedValue(row);
      (getLatestAnalysisForPoolInbox as jest.Mock).mockResolvedValue(analysisRow);

      const result = await controller.findOne(makeReq('user-1'), 'pi-1');

      expect(service.findById).toHaveBeenCalledWith('user-1', 'pi-1');
      expect(getLatestAnalysisForPoolInbox).toHaveBeenCalledWith('pi-1');
      expect(result).toEqual({ ...row, analysis: analysisRow });
    });

    it('attaches analysis: null when no analysis row exists yet', async () => {
      const row = { id: 'pi-1', userId: 'user-1', email: 'a@domain.com' };
      service.findById.mockResolvedValue(row);
      (getLatestAnalysisForPoolInbox as jest.Mock).mockResolvedValue(null);

      const result = await controller.findOne(makeReq('user-1'), 'pi-1');

      expect(result).toEqual({ ...row, analysis: null });
    });

    it('throws NotFoundException when the pool inbox does not exist or is not owned by the user', async () => {
      service.findById.mockResolvedValue(null);

      await expect(controller.findOne(makeReq('user-1'), 'pi-404')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
```

Add the `NotFoundException` import at the top of the file if it isn't already there:

```ts
import { NotFoundException } from '@nestjs/common';
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd backend && npx jest pool-inbox.controller.spec.ts -t "GET /pool-inboxes/:id"`
Expected: FAIL with `TypeError: controller.findOne is not a function`

- [ ] **Step 8: Write minimal implementation**

In `backend/src/pool-inbox/pool-inbox.controller.ts`:

Add the import:

```ts
import { getLatestAnalysisForPoolInboxes, getLatestAnalysisForPoolInbox } from '@/analysis/analysis.service';
```

Add `NotFoundException` to the existing `@nestjs/common` import line:

```ts
import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
```

Add this method right after `findAll` (the `GET /pool-inboxes` handler):

```ts
  /**
   * Single pool-inbox lookup with its latest analysis attached.
   * Ownership-checked — 404 if not found or belongs to another user.
   * Mirrors `InboxController.findOne`.
   */
  @Get(':id')
  async findOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    const row = await this.poolInboxService.findById(req.userId!, id);
    if (!row) throw new NotFoundException();
    const analysis = await getLatestAnalysisForPoolInbox(id);
    return { ...row, analysis };
  }
```

**Important ordering note:** NestJS matches routes in declaration order for
the same HTTP verb. `@Get(':id')` must be declared **after** `@Get()`
(`findAll`) in the class body so `/pool-inboxes` (no id) doesn't get
swallowed by the `:id` param route. Confirm `findAll` still appears before
`findOne` in the file.

- [ ] **Step 9: Run test to verify it passes**

Run: `cd backend && npx jest pool-inbox.controller.spec.ts`
Expected: PASS

Run: `cd backend && npx jest`
Expected: PASS, all suites green

Run: `cd backend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 10: Commit**

```bash
cd backend
git add src/pool-inbox/pool-inbox.controller.ts src/pool-inbox/pool-inbox.controller.spec.ts
git commit -m "feat(pool-inbox): add GET /pool-inboxes/:id single-row endpoint"
```

---

## Task 5: Frontend types + data helper

**Files:**
- Modify: `frontend/src/lib/pool-activity-types.ts`
- Modify: `frontend/src/app/(dashboard)/_lib/data.ts`

**Interfaces:**
- Consumes: `serverApi<T>(path)` (existing, `@/lib/api-server`). `PoolInbox` type (existing, `@/lib/types`).
- Produces: `PoolLiveJob`, `PoolLiveStatus` types (frontend mirrors of the backend shapes from Task 2). `getPoolInbox(id: string): Promise<PoolInbox | null>`.

- [ ] **Step 1: Add the live-status types**

In `frontend/src/lib/pool-activity-types.ts`, add at the end of the file:

```ts
export interface PoolLiveJob {
  jobId: string;
  actions: string[];
  senderEmail: string | null;
  executeAt: string;
  state: 'active' | 'delayed' | 'waiting';
}

export interface PoolLiveStatus {
  active: PoolLiveJob[];
  upcoming: PoolLiveJob[];
}
```

This is a type-only change — there's no test to write/run here (these are
TypeScript interfaces, exercised by the components in Task 7 that import
them). Confirm the file still typechecks in isolation:

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (this file has no runtime logic to break)

- [ ] **Step 2: Add `getPoolInbox` to the data helper**

In `frontend/src/app/(dashboard)/_lib/data.ts`, add this function right after `getPoolInboxes`:

```ts
/** Single pool inbox by id, with its latest analysis attached, or null if not found/not owned. */
export async function getPoolInbox(id: string): Promise<PoolInbox | null> {
  try {
    return await serverApi<PoolInbox>(`/pool-inboxes/${id}`);
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
cd frontend
git add src/lib/pool-activity-types.ts src/app/\(dashboard\)/_lib/data.ts
git commit -m "feat(frontend): add live-status types and getPoolInbox data helper"
```

---

## Task 6: `LiveStatusPanel` component

**Files:**
- Create: `frontend/src/app/(dashboard)/pool/[id]/_components/LiveStatusPanel.tsx`

**Interfaces:**
- Consumes: `usePolling<PoolLiveStatus>` (existing hook, `@/lib/use-polling`). `useApi()` (existing, `@/lib/api`). `PulseDot` (existing, `@/components/PulseDot`). `PoolLiveStatus`/`PoolLiveJob` types (Task 5).
- Produces: `<LiveStatusPanel poolInboxId={string} />` — a self-contained client component with no props beyond `poolInboxId`.

This is a presentational component with no backend test surface — there's
no frontend test framework in this project (confirmed during T028
verification). It's verified by typecheck/lint/build (Step 3 below) and by
live Playwright verification once wired into the page (Task 9).

- [ ] **Step 1: Write the component**

Create `frontend/src/app/(dashboard)/pool/[id]/_components/LiveStatusPanel.tsx`:

```tsx
'use client';

import { useApi } from '@/lib/api';
import { usePolling } from '@/lib/use-polling';
import { PulseDot } from '@/components/PulseDot';
import type { PoolLiveStatus, PoolLiveJob } from '@/lib/pool-activity-types';

interface Props {
  poolInboxId: string;
}

const ACTION_LABEL: Record<string, string> = {
  open: 'open',
  star: 'star',
  reply: 'reply',
  rescue: 'rescue from spam',
};

function describeActions(actions: string[]): string {
  if (actions.length === 0) return 'process';
  return actions.map((a) => ACTION_LABEL[a] ?? a).join(' + ');
}

function formatRelativeFuture(iso: string): string {
  const diffMs = new Date(iso).getTime() - Date.now();
  if (diffMs <= 0) return 'any moment now';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'in under a minute';
  if (mins === 1) return 'in 1 min';
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'in 1 hour' : `in ${hours} hours`;
}

/**
 * Polls `GET /pool-inboxes/:id/live-status` every 3s and shows real
 * BullMQ job state for this pool inbox's warmup-receive queue — what's
 * processing right now, and what's queued/delayed next. Sourced from
 * the actual queue, not a simulation: jobs run on a 2-240 minute
 * jittered delay after each warmup send (see warmup-send.processor.ts),
 * so an empty panel most of the time is expected, not broken — the copy
 * below says so explicitly.
 */
export function LiveStatusPanel({ poolInboxId }: Props) {
  const api = useApi();

  const { state, data, error } = usePolling<PoolLiveStatus>({
    fetcher: () => api<PoolLiveStatus>(`/pool-inboxes/${poolInboxId}/live-status`),
    intervalMs: 3000,
    // Never "stop" — this is a continuous live indicator, not a
    // poll-until-done task. shouldStop always false plus a very high
    // maxAttempts keeps it polling indefinitely while the page is open.
    shouldStop: () => false,
    maxAttempts: Number.MAX_SAFE_INTEGER,
  });

  const active = data?.active ?? [];
  const upcoming = data?.upcoming ?? [];
  const pulseState = error ? 'error' : active.length > 0 ? 'live' : state === 'busy' ? 'busy' : 'idle';

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
      data-testid="live-status-panel"
    >
      <div className="flex items-center gap-2">
        <PulseDot state={pulseState} label="Live warmup-receive status" />
        <h2 className="text-sm font-semibold text-slate-900">Live status</h2>
      </div>

      {error ? (
        <p className="mt-2 text-xs text-rose-600">{error}</p>
      ) : active.length === 0 && upcoming.length === 0 ? (
        <p className="mt-2 text-xs text-slate-500">
          No warmup activity scheduled right now — jobs run on a jittered 2&ndash;240 minute
          delay after each send, so this is normal between sends.
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {active.map((job: PoolLiveJob) => (
            <p key={job.jobId} className="text-sm text-slate-800">
              <span className="font-medium text-emerald-700">Processing now</span> &mdash;{' '}
              {describeActions(job.actions)} email from{' '}
              <span className="font-mono text-xs">{job.senderEmail ?? 'unknown sender'}</span>
            </p>
          ))}
          {upcoming.map((job: PoolLiveJob) => (
            <p key={job.jobId} className="text-sm text-slate-600">
              Will {describeActions(job.actions)} email from{' '}
              <span className="font-mono text-xs">{job.senderEmail ?? 'unknown sender'}</span>{' '}
              {formatRelativeFuture(job.executeAt)}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Verify typecheck and lint**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

Run: `cd frontend && npm run lint`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd frontend
git add "src/app/(dashboard)/pool/[id]/_components/LiveStatusPanel.tsx"
git commit -m "feat(frontend): add LiveStatusPanel polling real BullMQ job state"
```

---

## Task 7: Extract `PoolHealthTab` from the drawer

**Files:**
- Create: `frontend/src/app/(dashboard)/pool/[id]/_components/PoolHealthTab.tsx`
- Reference (read-only, do not modify yet): `frontend/src/app/(dashboard)/pool/_components/PoolInboxDetailPanel.tsx`

**Interfaces:**
- Consumes: `DnsStatusCard` (`@/components/DnsStatusCard`), `HealthScoreGauge` (`../../_components/HealthScoreGauge` relative to the old drawer — new relative path is `@/app/(dashboard)/pool/_components/HealthScoreGauge`), `poolInboxReadiness`/`poolInboxReadinessStyle` (`@/lib/plan-config`), `formatDate` (`@/lib/format`), `PoolInbox` type (`@/lib/types`).
- Produces: `<PoolHealthTab poolInbox={PoolInbox} />` — same visual output as the old drawer's inline Health tab content, now a standalone component.

This is a pure extraction — the JSX and logic are copied verbatim from the
existing `PoolInboxDetailPanel.tsx` (the `DNS_HOW_TO_FIX`, `FIX_PRIORITY`,
`READINESS_SUMMARY` constants and the `HealthTab` function), with import
paths adjusted for the new file location. No behavior changes.

- [ ] **Step 1: Create the new file**

Create `frontend/src/app/(dashboard)/pool/[id]/_components/PoolHealthTab.tsx`:

```tsx
'use client';

import { DnsStatusCard } from '@/components/DnsStatusCard';
import { HealthScoreGauge } from '@/app/(dashboard)/pool/_components/HealthScoreGauge';
import { formatDate } from '@/lib/format';
import {
  poolInboxReadiness,
  poolInboxReadinessStyle,
  type PoolInboxReadiness,
} from '@/lib/plan-config';
import type { PoolInbox } from '@/lib/types';

/**
 * Plain-language copy for each DNS check, plus the "how to fix" hint
 * surfaced in the bottom-of-panel action card. Kept in one place so
 * a copy change is one edit, not five.
 */
const DNS_HOW_TO_FIX: Record<'spf' | 'dkim' | 'dmarc' | 'mx' | 'rdns', string> = {
  spf: "Add an SPF TXT record at your domain's DNS host. Start with `v=spf1 include:_spf.google.com ~all` (substitute your email provider) and gradually widen to your sending IPs.",
  dkim: "Generate a DKIM key pair in your email provider (Google Workspace / Microsoft 365 / SendGrid all do this) and publish the public key as a TXT record at `<selector>._domainkey.yourdomain.com`.",
  dmarc: "Add a DMARC TXT record at `_dmarc.yourdomain.com`. Start with `v=DMARC1; p=none; rua=mailto:dmarc@yourdomain.com` so you can monitor without rejecting mail yet.",
  mx: 'Make sure your domain has at least one MX record pointing to a working mail server. If you only send (no receive) you can use a placeholder like `mx.yourdomain.com` with priority 10.',
  rdns: 'Contact your server / VPS provider and ask them to set a PTR record for your sending IP that resolves back to a domain you control. rDNS is rarely blocking but improves inbox placement.',
};

/**
 * Minimum-impact order: fix the highest-leverage missing record first.
 * SPF and DKIM are the two that most affect deliverability; DMARC is
 * policy that aligns them; MX is required for the receiving side;
 * rDNS is the least impactful.
 */
const FIX_PRIORITY: Array<'dkim' | 'spf' | 'dmarc' | 'mx' | 'rdns'> = [
  'dkim',
  'spf',
  'dmarc',
  'mx',
  'rdns',
];

const READINESS_SUMMARY: Record<PoolInboxReadiness, { headline: string; body: string }> = {
  eligible: {
    headline: 'This inbox is ready to warm with.',
    body: 'All critical DNS records are in place. Warmup emails sent from this inbox should land in the Primary tab of the receiving Gmail / Outlook / Yahoo inboxes.',
  },
  'not-eligible': {
    headline: "This inbox isn't safe to warm with yet.",
    body: 'One or more critical DNS records are missing. Warmup emails will likely land in Spam or be rejected outright by the receiving inbox. See the fix below.',
  },
  analyzing: {
    headline: 'DNS analysis is running.',
    body: 'We just started checking this inbox — SPF, DKIM, DMARC, MX and rDNS. This usually takes a few seconds. The badge at the top will switch to "Ready" or "Needs attention" when it finishes.',
  },
  error: {
    headline: 'The analysis job failed.',
    body: 'Most commonly a DNS timeout. Click "Re-analyze" below to retry, or check the error message in the active-pairs panel.',
  },
};

interface Props {
  poolInbox: PoolInbox;
}

/** The DNS / readiness / score content that used to be inline in the old drawer's Health tab. */
export function PoolHealthTab({ poolInbox }: Props) {
  const analysis = poolInbox.analysis;
  const readiness = poolInboxReadiness(poolInbox.status, analysis);
  const readinessStyle = poolInboxReadinessStyle(readiness);
  const summary = READINESS_SUMMARY[readiness];

  const failing: Array<'spf' | 'dkim' | 'dmarc' | 'mx' | 'rdns'> = [];
  if (analysis) {
    if (analysis.spfValid === false) failing.push('spf');
    if (analysis.dkimValid === false) failing.push('dkim');
    if (analysis.dmarcValid === false) failing.push('dmarc');
    if (analysis.mxValid === false) failing.push('mx');
    if (analysis.rdnsValid === false) failing.push('rdns');
  }
  const topFix = FIX_PRIORITY.find((k) => failing.includes(k));

  return (
    <>
      <section
        className={`rounded-2xl border p-4 ${readinessStyle.bg} ${readinessStyle.text.replace('text-', 'border-')}`}
      >
        <p className="text-sm font-semibold">{readinessStyle.label}</p>
        <p className="mt-1 text-sm font-medium">{summary.headline}</p>
        <p className="mt-1 text-xs leading-relaxed opacity-90">{summary.body}</p>
      </section>

      <div className="mt-6 flex justify-center">
        <HealthScoreGauge score={analysis?.healthScore ?? null} />
      </div>

      <section className="mt-6">
        <h3 className="text-sm font-semibold text-slate-900">DNS records</h3>
        <p className="mt-1 text-xs text-slate-500">
          These are the records Gmail / Outlook / Yahoo check when deciding whether to deliver
          an email or file it as Spam.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-3">
          <DnsStatusCard type="spf" status={analysis?.spfValid ?? null} />
          <DnsStatusCard type="dkim" status={analysis?.dkimValid ?? null} />
          <DnsStatusCard type="dmarc" status={analysis?.dmarcValid ?? null} />
          <DnsStatusCard type="mx" status={analysis?.mxValid ?? null} />
          <DnsStatusCard type="rdns" status={analysis?.rdnsValid ?? null} />
        </div>
      </section>

      {failing.length > 0 && topFix ? (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">
            Fix this first: {topFix.toUpperCase()}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">
            {DNS_HOW_TO_FIX[topFix]}
          </p>
          {failing.length > 1 ? (
            <p className="mt-2 text-xs text-amber-700">
              {failing.length - 1} other{' '}
              {failing.length - 1 === 1 ? 'record is' : 'records are'} also failing — fix this
              one first, then re-analyze to see the next most-impactful gap.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="mt-6 grid grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Active pairs
          </p>
          <p className="mt-1 text-xl font-semibold text-slate-900">{poolInbox.activePairs}</p>
          <p className="mt-1 text-[10px] leading-snug text-slate-500">
            How many other inboxes this one is currently paired with for warmup traffic.
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Date added
          </p>
          <p className="mt-1 text-xl font-semibold text-slate-900">
            {formatDate(poolInbox.createdAt)}
          </p>
          <p className="mt-1 text-[10px] leading-snug text-slate-500">
            {poolInbox.lastUsedAt
              ? `Last used ${formatDate(poolInbox.lastUsedAt)}`
              : 'Never used yet.'}
          </p>
        </div>
      </section>

      {!analysis ? (
        <p className="mt-6 text-sm text-slate-500">
          {poolInbox.status === 'pending'
            ? 'Analysing… DNS health will appear here once the analysis job finishes.'
            : 'No analysis available yet. Click "Re-analyze" on the row to retry.'}
        </p>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: Verify typecheck and lint**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

Run: `cd frontend && npm run lint`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
cd frontend
git add "src/app/(dashboard)/pool/[id]/_components/PoolHealthTab.tsx"
git commit -m "feat(frontend): extract PoolHealthTab from the drawer for reuse on the new page"
```

---

## Task 8: `PoolDetailTabs` shell + `/pool/[id]` page

**Files:**
- Create: `frontend/src/app/(dashboard)/pool/[id]/_components/PoolDetailTabs.tsx`
- Create: `frontend/src/app/(dashboard)/pool/[id]/page.tsx`

**Interfaces:**
- Consumes: `PoolHealthTab` (Task 7), `LiveStatusPanel` (Task 6), `PoolActivityTab`/`PoolPairingsTab`/`PoolLogsTab`/`ConnectionSummaryStrip` (existing, `@/app/(dashboard)/pool/_components/...`), `ReadinessBadge` (existing), `ReanalyzeButton` (existing), `getPoolInbox` (Task 5), `currentUserId` (existing, `@/lib/api-server`).
- Produces: route `/pool/[id]` rendering the full detail page; `<PoolDetailTabs poolInbox={PoolInbox} />` tab shell with tabs Activity (default) / Health / Pairings / Logs.

- [ ] **Step 1: Write `PoolDetailTabs.tsx`**

Create `frontend/src/app/(dashboard)/pool/[id]/_components/PoolDetailTabs.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { PoolActivityTab } from '@/app/(dashboard)/pool/_components/PoolActivityTab';
import { PoolPairingsTab } from '@/app/(dashboard)/pool/_components/PoolPairingsTab';
import { PoolLogsTab } from '@/app/(dashboard)/pool/_components/PoolLogsTab';
import { PoolHealthTab } from './PoolHealthTab';
import type { PoolInbox } from '@/lib/types';

type TabId = 'activity' | 'health' | 'pairings' | 'logs';

const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: 'activity', label: 'Activity', hint: 'Received emails and actions taken, most recent first' },
  { id: 'health', label: 'Health', hint: 'DNS records, readiness, and score' },
  { id: 'pairings', label: 'Pairings', hint: 'Which inboxes this one is currently serving' },
  { id: 'logs', label: 'Logs', hint: 'Raw structured log stream for this pool inbox' },
];

interface Props {
  poolInbox: PoolInbox;
}

/**
 * Tab shell for the `/pool/[id]` page. Default tab is Activity (not
 * Health, which was the old drawer's default) — paired with
 * `LiveStatusPanel` above this component, the page now reads top-to-
 * bottom as "happening now -> just happened -> history" without a tab
 * switch.
 */
export function PoolDetailTabs({ poolInbox }: Props) {
  const [active, setActive] = useState<TabId>('activity');

  return (
    <div>
      <nav
        role="tablist"
        aria-label="Pool inbox detail tabs"
        className="mb-4 flex flex-wrap gap-1 rounded-full border border-slate-200 bg-white p-1 text-sm shadow-sm"
      >
        {TABS.map((tab) => {
          const isActive = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tabpanel-${tab.id}`}
              id={`tab-${tab.id}`}
              onClick={() => setActive(tab.id)}
              title={tab.hint}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                isActive ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      <div role="tabpanel" id={`tabpanel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'activity' ? <PoolActivityTab poolInboxId={poolInbox.id} /> : null}
        {active === 'health' ? <PoolHealthTab poolInbox={poolInbox} /> : null}
        {active === 'pairings' ? <PoolPairingsTab poolInboxId={poolInbox.id} /> : null}
        {active === 'logs' ? <PoolLogsTab poolInboxId={poolInbox.id} /> : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write `page.tsx`**

Create `frontend/src/app/(dashboard)/pool/[id]/page.tsx`:

```tsx
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { currentUserId } from '@/lib/api-server';
import { getPoolInbox } from '@/app/(dashboard)/_lib/data';
import { ReadinessBadge } from '@/app/(dashboard)/pool/_components/ReadinessBadge';
import { ConnectionSummaryStrip } from '@/app/(dashboard)/pool/_components/ConnectionSummaryStrip';
import { ReanalyzeButton } from '@/app/(dashboard)/pool/_components/ReanalyzeButton';
import { formatDate } from '@/lib/format';
import { LiveStatusPanel } from './_components/LiveStatusPanel';
import { PoolDetailTabs } from './_components/PoolDetailTabs';

export const dynamic = 'force-dynamic';

/**
 * Pool inbox detail page — full-page replacement for the old
 * `PoolInboxDetailPanel` drawer. Mirrors `/inboxes/[id]/page.tsx`'s
 * structure: server component fetches the row once, client components
 * below handle their own data (Live Status polls every 3s, each tab
 * fetches on demand).
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const userId = await currentUserId();
  if (!userId) redirect('/sign-in');
  const { id } = await params;

  const poolInbox = await getPoolInbox(id);
  if (!poolInbox) notFound();

  return (
    <div className="space-y-6">
      <Link href="/pool" className="text-sm text-indigo-600 hover:underline">
        &larr; Back to Warming Pool
      </Link>

      <header className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900">{poolInbox.email}</h1>
            <ReadinessBadge status={poolInbox.status} analysis={poolInbox.analysis} />
          </div>
          <p className="mt-1 text-sm capitalize text-slate-600">
            {poolInbox.provider} &middot; added {formatDate(poolInbox.createdAt)}
          </p>
        </div>
        <ReanalyzeButton poolInboxId={poolInbox.id} />
      </header>

      <ConnectionSummaryStrip poolInboxId={poolInbox.id} />

      <LiveStatusPanel poolInboxId={poolInbox.id} />

      <PoolDetailTabs poolInbox={poolInbox} />
    </div>
  );
}
```

- [ ] **Step 3: Verify typecheck, lint, and build**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors

Run: `cd frontend && npm run lint`
Expected: no errors

Run: `cd frontend && npm run build`
Expected: build succeeds, `/pool/[id]` appears in the route list output

- [ ] **Step 4: Commit**

```bash
cd frontend
git add "src/app/(dashboard)/pool/[id]/_components/PoolDetailTabs.tsx" "src/app/(dashboard)/pool/[id]/page.tsx"
git commit -m "feat(frontend): add /pool/[id] full-page detail view with Live Status panel"
```

---

## Task 9: Wire the grid to navigate, delete the drawer

**Files:**
- Modify: `frontend/src/app/(dashboard)/pool/_components/PoolInboxGrid.tsx`
- Delete: `frontend/src/app/(dashboard)/pool/_components/PoolInboxDetailPanel.tsx`

**Interfaces:**
- Consumes: `useRouter` from `next/navigation` (already imported in this file).
- Produces: clicking a pool inbox row navigates to `/pool/[id]` instead of opening the drawer.

- [ ] **Step 1: Update `PoolInboxGrid.tsx`**

In `frontend/src/app/(dashboard)/pool/_components/PoolInboxGrid.tsx`, remove the `PoolInboxDetailPanel` import and the `selected` state, and change the row click handler.

Find:

```tsx
import { PoolInboxDetailPanel } from './PoolInboxDetailPanel';
```

Delete this line entirely.

Find:

```tsx
export function PoolInboxGrid({ poolInboxes, pollState = 'idle' }: Props) {
  const [selected, setSelected] = useState<PoolInbox | null>(null);
  const router = useRouter();
```

Replace with:

```tsx
export function PoolInboxGrid({ poolInboxes, pollState = 'idle' }: Props) {
  const router = useRouter();
```

(The `useState` import becomes unused for this purpose — check if `useState`
is used elsewhere in the file before removing the import; if this was its
only use, remove `import { useState } from 'react';` too.)

Find:

```tsx
                <tr
                  key={p.id}
                  onClick={() => setSelected(p)}
                  className="cursor-pointer hover:bg-slate-50"
                >
```

Replace with:

```tsx
                <tr
                  key={p.id}
                  onClick={() => router.push(`/pool/${p.id}`)}
                  className="cursor-pointer hover:bg-slate-50"
                >
```

Find the drawer render at the bottom of the component:

```tsx
      {selected ? (
        <PoolInboxDetailPanel poolInbox={selected} onClose={() => setSelected(null)} />
      ) : null}
    </>
  );
}
```

Replace with:

```tsx
    </>
  );
}
```

- [ ] **Step 2: Delete the drawer file**

```bash
cd frontend
git rm "src/app/(dashboard)/pool/_components/PoolInboxDetailPanel.tsx"
```

- [ ] **Step 3: Verify typecheck, lint, and build**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors (confirms nothing else imports the deleted drawer)

Run: `cd frontend && npm run lint`
Expected: no errors (confirms no unused imports left behind in `PoolInboxGrid.tsx`)

Run: `cd frontend && npm run build`
Expected: build succeeds

- [ ] **Step 4: Commit**

```bash
cd frontend
git add "src/app/(dashboard)/pool/_components/PoolInboxGrid.tsx"
git commit -m "refactor(frontend): navigate to /pool/[id] instead of opening the drawer"
```

---

## Task 10: Live verification against the running dev stack

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Restart the dev backend + frontend**

```bash
cd /Users/abhishekmittal/Documents/Work/github/shuhari/projects/email-warmup
.bin/dev restart
cd backend && npm run db:migrate
```

Expected: both services come up clean, migration applies without error (no
new migration is introduced by this plan, so this should be a no-op
confirming the schema is already current).

- [ ] **Step 2: Run the full backend suite one more time**

Run: `cd backend && npx jest`
Expected: PASS, all suites green (existing count + 3 from Task 1 + 3 from Task 2 + 1 from Task 3 + 3+3 from Task 4)

- [ ] **Step 3: Drive the new page with Playwright**

Use the same sign-in + navigation pattern already proven during T028
verification (seed user `admin@emailwarm.dev` / `EmailWarm-Phase1-Test!` via
`node scripts/seed-test-users.mjs --email admin@emailwarm.dev` if not
already seeded). Write a script at
`/private/tmp/claude-501/-Users-abhishekmittal-Documents-Work-github-shuhari-projects-email-warmup/<session>/scratchpad/verify-pool-detail-page.mjs`
that:

1. Signs in.
2. Navigates to `/pool`.
3. Clicks the first pool inbox row.
4. Asserts the URL changed to `/pool/<id>` (not a drawer — confirms Task 9 worked).
5. Screenshots the page — confirm: back link, email + readiness badge header, `ReanalyzeButton`, `ConnectionSummaryStrip`, the new `LiveStatusPanel` section with either real active/upcoming jobs or the "No warmup activity scheduled right now" empty state, and the 4-tab bar defaulting to "Activity".
6. Clicks through Health, Pairings, Logs tabs — screenshot each, confirm no console errors (same `page.on('console', ...)` / `page.on('pageerror', ...)` listeners used in the T028 verification pass).

Expected: zero console errors across all four tabs; `LiveStatusPanel`
renders either real job data or the explicit empty-state copy (never a
blank/broken-looking panel).

- [ ] **Step 4: Confirm `/pool` (the list page) still works unchanged**

In the same script, after step 3 navigates away, also separately load
`/pool` directly and confirm the grid still renders rows and the
Refresh/CSV/wizard buttons are all present and unchanged (this plan didn't
touch `PoolPageClient.tsx`).

- [ ] **Step 5: Report results, no commit needed for this task**

This task produces no code changes — it's the final verification gate.
Summarize pass/fail for each check in Step 3 and Step 4.

---

## Self-Review Notes

- **Spec coverage:** §1 (full-page route, 4 tabs, Activity default) → Tasks 7–9. §2 (Live Status panel, BullMQ-backed, 3s poll, active/upcoming, empty-state copy with the 2–240 min explanation) → Tasks 1–3, 6. §3 (tab order: Live Status above tabs, Activity default) → Task 8. The spec's "no websockets" non-goal is respected throughout (Task 6 uses the existing `usePolling` hook, no new transport). The spec's `GET /pool-inboxes/:id` dependency (needed by the new page's server component, not explicitly itemized as its own endpoint in the original spec but required by §1's "server component fetches the inbox row") is covered by Task 4.
- **Placeholder scan:** no TBD/TODO markers; every code step has complete, runnable code; no "similar to Task N" cross-references — Task 7's extraction shows the full file rather than referring back to the old drawer's source.
- **Type consistency:** `PoolLiveStatus`/`PoolLiveJob` defined once in the backend service (Task 2) and mirrored exactly in the frontend types file (Task 5) — field names (`jobId`, `actions`, `senderEmail`, `executeAt`, `state`) match across both. `getJobsForReceiver`'s signature (Task 1) matches its single call site in `getLiveStatus` (Task 2). `findById` (Task 4) returns `null` on miss, matching the existing `InboxService.findById` convention the controller's `if (!row) throw new NotFoundException()` relies on.
- **Scope check:** single cohesive feature (one backend capability + one frontend page), appropriately sized for one plan — not decomposed further.
