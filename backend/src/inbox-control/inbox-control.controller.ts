import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { BetterAuthGuard } from '../auth/better-auth.guard';
import { InboxControlService } from './inbox-control.service';

/**
 * 4 endpoints (T027 follow-up) for stopping and resuming warmup traffic
 * on user-owned inboxes. Single-inbox routes use the path parameter; the
 * bulk variants accept `{ inboxIds: string[] }` and never abort the whole
 * request on a single bad id (they return per-row results instead).
 *
 * The bulk routes share the `/inboxes` path prefix with the single
 * variants and the existing T020 batch-upload routes. Nest's router
 * disambiguates by method + path so `POST /inboxes/pause` and
 * `POST /inboxes/:id/pause` don't collide.
 *
 * All four endpoints require a valid bearer token (BetterAuthGuard) and
 * assert ownership per row — a 404 is returned for any id that doesn't
 * belong to the caller, never for the whole request.
 */
@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class InboxControlController {
  constructor(private readonly control: InboxControlService) {}

  /**
   * Bounce figures for the last 24 hours with the sample size behind them,
   * and whether the inbox is currently held for exceeding the limit.
   */
  @Get(':id/bounce-stats')
  async bounceStats(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.control.bounceStats(req.userId!, id);
  }

  @Post(':id/pause')
  async pauseOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.control.pauseOne(req.userId!, id);
  }

  @Post(':id/resume')
  async resumeOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.control.resumeOne(req.userId!, id);
  }

  @Post(':id/start')
  async startOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.control.startOne(req.userId!, id);
  }

  @Post('start')
  async startMany(
    @Req() req: Request & { userId?: string },
    @Body() body: { inboxIds?: string[] },
  ) {
    const ids = this.extractIds(body);
    return this.control.startMany(req.userId!, ids);
  }

  @Post('pause')
  async pauseMany(
    @Req() req: Request & { userId?: string },
    @Body() body: { inboxIds?: string[] },
  ) {
    const ids = this.extractIds(body);
    return this.control.pauseMany(req.userId!, ids);
  }

  @Post('resume')
  async resumeMany(
    @Req() req: Request & { userId?: string },
    @Body() body: { inboxIds?: string[] },
  ) {
    const ids = this.extractIds(body);
    return this.control.resumeMany(req.userId!, ids);
  }

  private extractIds(body: { inboxIds?: string[] } | undefined): string[] {
    const raw = body?.inboxIds;
    if (!Array.isArray(raw)) {
      throw new BadRequestException('Body must include an `inboxIds: string[]`');
    }
    if (raw.length === 0) {
      throw new BadRequestException('`inboxIds` must contain at least one id');
    }
    // Hard cap so a buggy / malicious client can't queue thousands of
    // ownership checks in one request. 200 inboxes is well above any
    // reasonable plan's inbox limit (growth=20, agency=100, enterprise
    // =unlimited but real users have far fewer than 200).
    if (raw.length > 200) {
      throw new BadRequestException('`inboxIds` is capped at 200 ids per request');
    }
    return raw;
  }
}
