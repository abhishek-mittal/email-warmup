import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'crypto';
import { Public } from './public.decorator';
import { UserSyncService } from './user-sync.service';

/**
 * Internal HTTP endpoint called by the frontend's better-auth
 * `databaseHooks.user.create.after` callback.
 *
 * better-auth manages the user lifecycle in its own `user` table; the
 * backend needs the same row in its `users` table (which carries the
 * plan/trial fields Stripe writes to) so that
 * `BillingService.assertPlan` / `assertInboxLimit` (and the rest of the
 * backend that does `WHERE user_id = ?` against `users`) can find the
 * row.
 *
 * Guarded by a shared `X-Internal-Secret` header rather than a bearer
 * token (the hook has no user session — it fires *because* the user was
 * just created). The secret must match the value of
 * `INTERNAL_SECRET` configured on both processes.
 *
 * `@Public()` because the global BetterAuthGuard would otherwise reject
 * this call for lacking a bearer token. The secret-header check is the
 * sole authentication.
 */
@Controller('internal')
export class InternalController {
  private readonly logger = new Logger(InternalController.name);

  constructor(private readonly userSync: UserSyncService) {}

  @Public()
  @Post('user-sync')
  @HttpCode(200)
  async syncUser(
    @Body() body: { id?: string; email?: string },
    @Headers('x-internal-secret') providedSecret: string | undefined,
  ): Promise<{ ok: true; created: boolean }> {
    if (!this.checkSecret(providedSecret)) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    if (!body?.id || typeof body.id !== 'string') {
      throw new BadRequestException('id is required');
    }
    if (!body.email || typeof body.email !== 'string') {
      throw new BadRequestException('email is required');
    }

    const result = await this.userSync.upsertUser({
      id: body.id,
      email: body.email,
    });
    // Drizzle's insert/update returns a result object with `rowCount` not
    // standardized across drivers — the simplest reliable signal is
    // `created` from the service: true when the row didn't exist, false
    // when the UPDATE branch ran.
    return { ok: true, created: result.created };
  }

  /**
   * Constant-time compare against `INTERNAL_SECRET`. Fails closed when
   * the env var is unset — no caller can ever succeed in that case,
   * which is the safe default for an internal-only endpoint.
   */
  private checkSecret(provided: string | undefined): boolean {
    const expected = process.env.INTERNAL_SECRET;
    if (!expected) return false;
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    try {
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
}
