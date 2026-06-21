import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
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
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing auth token');
    }

    const userId = this.verifyToken(token);
    if (!userId) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    request.userId = userId;
    return true;
  }

  private extractBearerToken(req: any): string | null {
    const auth = req.headers?.authorization;
    return auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  }

  private verifyToken(token: string): string | null {
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) {
      // No secret configured — fail closed rather than silently accepting.
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;

    const [version, userPart, expPart, sigPart] = parts;
    const payload = `${version}.${userPart}.${expPart}`;

    // Recompute HMAC and compare in constant time.
    const expected = createHmac('sha256', secret).update(payload).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(sigPart, 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;

    // Expiry check.
    let exp: number;
    try {
      exp = Number(Buffer.from(expPart, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!Number.isFinite(exp) || exp < Date.now()) return null;

    try {
      return Buffer.from(userPart, 'base64url').toString('utf8');
    } catch {
      return null;
    }
  }
}
