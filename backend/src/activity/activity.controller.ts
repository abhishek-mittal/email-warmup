import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { BetterAuthGuard } from '../auth/better-auth.guard';
import {
  ActivityEvent,
  ActivityService,
  BlacklistCheckHistoryRow,
  DnsCheckHistoryRow,
  LogLine,
  PlacementHistoryRow,
  ScoreHistoryRow,
  WarmupSendListRow,
} from './activity.service';

interface ActivityResponse {
  events: ActivityEvent[];
  nextCursor: string | null;
}

interface SendsResponse {
  rows: WarmupSendListRow[];
  page: number;
  pageSize: number;
  total: number;
}

interface ScoreHistoryResponse {
  current: number | null;
  trend: 'up' | 'down' | 'stable';
  history: ScoreHistoryRow[];
}

interface LogsResponse {
  lines: LogLine[];
  totalMatched: number;
  fileFound: boolean;
}

/**
 * 9 endpoints for the inbox activity dashboard (T027):
 *  GET    /inboxes/:id/activity
 *  GET    /inboxes/:id/sends
 *  GET    /inboxes/:id/dns-history
 *  GET    /inboxes/:id/blacklist-history
 *  GET    /inboxes/:id/placement-history
 *  GET    /inboxes/:id/score-history
 *  GET    /inboxes/:id/logs
 *  POST   /inboxes/:id/checks/dns
 *  POST   /inboxes/:id/checks/blacklist
 *
 * Every endpoint runs the same ownership check via ActivityService.assertOwnership
 * — never distinguishes "not found" from "not yours" (mirrors
 * ScoringController/PlacementController's pattern) so we don't leak the
 * existence of other users' inboxes.
 */
@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Get(':id/activity')
  async getActivity(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<ActivityResponse> {
    const parsedLimit = parseLimit(limit, 50, 200);
    return this.activity.getActivity(id, req.userId, cursor ?? null, parsedLimit);
  }

  @Get(':id/sends')
  async getSends(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<SendsResponse> {
    const parsedPage = parseIntOr(page, 1, 1, 1_000_000);
    const parsedLimit = parseLimit(limit, 25, 100);
    return this.activity.getSends(
      id,
      req.userId,
      parsedPage,
      parsedLimit,
      (status ?? '').toLowerCase() || null,
      from ?? null,
      to ?? null,
    );
  }

  @Get(':id/dns-history')
  async getDnsHistory(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<DnsCheckHistoryRow[]> {
    return this.activity.getDnsHistory(id, req.userId, parseLimit(limit, 5, 50));
  }

  @Get(':id/blacklist-history')
  async getBlacklistHistory(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<BlacklistCheckHistoryRow[]> {
    return this.activity.getBlacklistHistory(id, req.userId, parseLimit(limit, 5, 50));
  }

  @Get(':id/placement-history')
  async getPlacementHistory(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
  ): Promise<PlacementHistoryRow[]> {
    return this.activity.getPlacementHistory(id, req.userId);
  }

  @Get(':id/score-history')
  async getScoreHistory(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('days') days?: string,
  ): Promise<ScoreHistoryResponse> {
    const parsedDays = parseIntOr(days, 30, 1, 365);
    return this.activity.getScoreHistory(id, req.userId, parsedDays);
  }

  @Get(':id/logs')
  async getLogs(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Query('level') level?: string,
    @Query('since') since?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ): Promise<LogsResponse> {
    const levelMin = levelToMin(level);
    return this.activity.getLogs(
      id,
      req.userId,
      levelMin,
      search?.trim() || null,
      since ?? null,
      parseLimit(limit, 200, 1000),
    );
  }

  @Post(':id/checks/dns')
  async runDnsCheck(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.activity.runDnsCheck(id, req.userId);
    return { ok: true };
  }

  @Post(':id/checks/blacklist')
  async runBlacklistCheck(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
  ): Promise<{ ok: true }> {
    await this.activity.runBlacklistCheck(id, req.userId);
    return { ok: true };
  }
}

/** Parse a positive integer with bounds. Throws 400 on garbage. */
function parseIntOr(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BadRequestException(`'${raw}' is not a valid integer`);
  }
  return Math.min(Math.max(n, min), max);
}

function parseLimit(raw: string | undefined, fallback: number, max: number): number {
  return parseIntOr(raw, fallback, 1, max);
}

/** Maps the textual level filter ("info"/"warn"/"error"/"debug"/"trace") to the
 *  minimum pino level number. `null` means "all levels" — no filter. */
function levelToMin(level: string | undefined): number | null {
  if (!level || level === 'all') return null;
  switch (level.toLowerCase()) {
    case 'trace':
      return 10;
    case 'debug':
      return 20;
    case 'info':
      return 30;
    case 'warn':
      return 40;
    case 'error':
      return 50;
    case 'fatal':
      return 60;
    default:
      throw new BadRequestException(`unknown log level: '${level}'`);
  }
}
