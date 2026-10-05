import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit key resolver. Authenticated requests are limited per user so a
 * single account cannot exhaust the quota from many IPs (and so users behind
 * one NAT are not lumped together); unauthenticated requests fall back to the
 * client IP. `userId` is attached to the request by BetterAuthGuard after
 * token verification.
 *
 * NOTE: the default in-memory storage counts per process. On multi-instance
 * deployments (Cloud Run) the effective limit is multiplied by the instance
 * count. A Redis-backed ThrottlerStorage is the follow-up for a hard global
 * cap (MR-11 / MR-19).
 */
@Injectable()
export class UserThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req.userId ?? req.ip ?? 'anonymous';
  }
}
