import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { inboxes } from '../db/schema';
import { Public } from '../auth/public.decorator';
import { SafetyStopService, SYSTEM_HOLD_REASONS } from './safety-stop.service';

/**
 * Operator-only safety controls (MR-12). Not reachable from the browser: the
 * frontend proxy refuses every `/internal/*` path, and each call must carry
 * the `X-Internal-Secret` shared secret. `X-Operator` names who acted and is
 * written to the audit columns.
 */
@Controller('internal/safety')
export class SafetyController {
  constructor(private readonly stops: SafetyStopService) {}

  @Public()
  @Get('stops')
  async list(@Headers('x-internal-secret') secret: string | undefined, @Query('all') all?: string) {
    this.authorize(secret);
    return this.stops.list(all === 'true');
  }

  /** Stop new warmup submissions: `{ scope: 'global' | 'provider' | 'user', key?, reason }`. */
  @Public()
  @Post('stops')
  @HttpCode(200)
  async activate(
    @Headers('x-internal-secret') secret: string | undefined,
    @Headers('x-operator') operator: string | undefined,
    @Body() body: { scope?: string; key?: string; reason?: string },
  ) {
    this.authorize(secret);
    try {
      return await this.stops.activate({
        scope: String(body?.scope ?? ''),
        key: body?.key,
        reason: String(body?.reason ?? ''),
        actor: operator?.trim() || 'operator',
      });
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  @Public()
  @Post('stops/:id/clear')
  @HttpCode(200)
  async clear(
    @Headers('x-internal-secret') secret: string | undefined,
    @Headers('x-operator') operator: string | undefined,
    @Param('id') id: string,
  ) {
    this.authorize(secret);
    const row = await this.stops.clear(id, operator?.trim() || 'operator');
    if (!row) throw new NotFoundException('No active stop with that id');
    return row;
  }

  /**
   * Releases a system hold on one inbox after an operator has looked at it.
   * The inbox stays paused; its owner can then resume it normally.
   */
  @Public()
  @Post('inboxes/:id/release')
  @HttpCode(200)
  async release(@Headers('x-internal-secret') secret: string | undefined, @Param('id') id: string) {
    this.authorize(secret);
    const rows = await db.select().from(inboxes).where(eq(inboxes.id, id)).limit(1);
    const inbox = rows[0];
    if (!inbox) throw new NotFoundException();
    if (!inbox.statusReason || !SYSTEM_HOLD_REASONS.includes(inbox.statusReason)) {
      throw new BadRequestException('This inbox is not under a system hold');
    }
    await db
      .update(inboxes)
      .set({ statusReason: 'released' })
      .where(and(eq(inboxes.id, id), eq(inboxes.status, 'paused')));
    return { id, status: 'paused', statusReason: 'released' };
  }

  /** Constant-time compare against INTERNAL_SECRET; fails closed when it is unset. */
  private authorize(provided: string | undefined): void {
    const expected = process.env.INTERNAL_SECRET;
    if (!expected || !provided) throw new UnauthorizedException('Invalid internal secret');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid internal secret');
    }
  }
}
