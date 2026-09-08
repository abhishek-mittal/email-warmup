import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Reflector } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Token format (v1):
 *   v1.<base64url(userId)>.<base64url(expMs)>.<base64url(hmac)>
 *
 * The HMAC is HMAC-SHA-256 of the first three parts (joined with '.') using
 * BETTER_AUTH_SECRET. The frontend mints this token from the better-auth
 * session (see frontend/src/lib/bearer-token.ts). No DB lookup needed on
 * the API side — verification is a single HMAC compare + expiry check.
 */
const TOKEN_VERSION = 'v1';

@Injectable()
export class BetterAuthGuard implements CanActivate {
  constructor(
    // The logger is injected by Nest's DI container at runtime when the
    // guard is resolved by the global guard mechanism. It's optional in
    // the constructor because main.ts constructs one explicit instance
    // for `app.useGlobalGuards(...)` outside the DI container (the DI
    // container's BetterAuthGuard instance is never actually invoked in
    // that path) — passing the Reflector is enough there.
    @InjectPinoLogger(BetterAuthGuard.name)
    private readonly logger: PinoLogger,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const path = request?.url as string | undefined;
    const method = request?.method as string | undefined;
    const token = this.extractBearerToken(request);

    if (!token) {
      this.logger.warn({ path, method, reason: 'missing' }, 'auth rejected: missing token');
      throw new UnauthorizedException('Missing auth token');
    }

    const verify = this.verifyTokenDetailed(token);
    if (!verify.ok) {
      this.logger.warn({ path, method, reason: verify.reason }, `auth rejected: ${verify.reason}`);
      throw new UnauthorizedException('Invalid or expired token');
    }
    request.userId = verify.userId;
    this.logger.debug({ userId: verify.userId, path, method }, 'auth verified');
    return true;
  }

  private extractBearerToken(req: any): string | null {
    const auth = req.headers?.authorization;
    return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  }

  /**
   * Same HMAC + expiry verification as before, but returns a structured
   * `{ ok: false, reason: 'expired' | 'invalid' | 'malformed' | 'misconfigured' }`
   * on failure so the caller can log a useful reason. The 401-vs-403
   * mapping (ForbiddenException vs UnauthorizedException) is preserved
   * for the misconfigured-secret path so a missing BETTER_AUTH_SECRET
   * still produces 403 — see the 403 acceptance criterion in T025.
   */
  private verifyTokenDetailed(
    token: string,
  ):
    | { ok: true; userId: string }
    | { ok: false; reason: 'misconfigured' | 'malformed' | 'invalid' | 'expired' } {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      return { ok: false, reason: 'misconfigured' };
    }

    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) {
      return { ok: false, reason: 'malformed' };
    }

    const [version, userPart, expPart, sigPart] = parts;
    const payload = `${version}.${userPart}.${expPart}`;

    // Recompute HMAC and compare in constant time.
    const expected = createHmac('sha256', secret).update(payload).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sigPart, 'base64url');
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (provided.length !== expected.length) return { ok: false, reason: 'malformed' };
    if (!timingSafeEqual(provided, expected)) return { ok: false, reason: 'invalid' };

    // Expiry check.
    let exp: number;
    try {
      exp = Number(Buffer.from(expPart, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (!Number.isFinite(exp) || exp < Date.now()) return { ok: false, reason: 'expired' };

    try {
      return { ok: true, userId: Buffer.from(userPart, 'base64url').toString('utf8') };
    } catch {
      return { ok: false, reason: 'malformed' };
    }
  }
}
