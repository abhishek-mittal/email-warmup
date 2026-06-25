import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { PoolInboxActivityService } from './pool-inbox-activity.service';

/**
 * Pool inbox detail-panel API (T028). All endpoints are auth-guarded
 * and ownership-checked (`PoolInboxActivityService.assertPoolOwnership`
 * throws `NotFoundException` on not-found OR not-yours — never leaks
 * which case it is).
 *
 * Endpoints mirror the inbox detail-panel endpoints added in T027
 * (`/inboxes/:id/...`) but the perspective is the receiver side.
 */
@Controller('pool-inboxes')
@UseGuards(BetterAuthGuard)
export class PoolInboxActivityController {
  constructor(private readonly activity: PoolInboxActivityService) {}

  /**
   * Non-secret connection settings for the header strip:
   * `SMTP smtp.gmail.com:587 / IMAP imap.gmail.com:993`.
   */
  @Get(':id/connection-summary')
  async connectionSummary(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.activity.getConnectionSummary(id, req.userId);
  }

  /**
   * Receiver-side activity feed — `received/opened/starred/replied/
   * rescued/spam_landed/filed` events for warmup emails sent to this
   * pool inbox. Cursor-paginated, newest first.
   */
  @Get(':id/activity')
  async activity_(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.activity.getActivity(id, req.userId, cursor ?? null, parseInt(limit ?? '50', 10));
  }

  /**
   * Aggregate counts: received, opened, replied, rescued, spamCount +
   * openRate/replyRate/spamRate (0-100 or null when no receives yet).
   */
  @Get(':id/activity-stats')
  async activityStats(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.activity.getActivityStats(id, req.userId);
  }

  /**
   * Distinct sender inboxes paired with this pool inbox + send counts
   * + last send timestamp. The `activePairs` field on the response
   * is `pool_inboxes.active_pairs` — same number the existing panel
   * header already shows, kept here for the Pairings tab header.
   */
  @Get(':id/pairings')
  async pairings(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.activity.getPairings(id, req.userId);
  }

  /**
   * NDJSON log tail filtered by `poolInboxId` OR `receiverId`. Same
   * shape as `GET /inboxes/:id/logs` from T027 so the LogsTab UI is
   * drop-in.
   */
  @Get(':id/logs')
  async logs(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('level') level?: string,
    @Query('search') search?: string,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ) {
    const levelMin = levelToMin(level);
    return this.activity.getLogs(
      id,
      req.userId,
      levelMin,
      search ?? null,
      since ?? null,
      parseInt(limit ?? '200', 10),
    );
  }

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
}

const LEVEL_MIN: Record<string, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

function levelToMin(level?: string): number | null {
  if (!level || level === 'all') return null;
  return LEVEL_MIN[level] ?? null;
}
