import { UnauthorizedException } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

/**
 * Authorizes an operator/internal call by its `X-Internal-Secret` header.
 * Constant-time compare against INTERNAL_SECRET; fails closed when the
 * variable is unset, so no caller can succeed on a misconfigured server.
 */
export function assertInternalSecret(provided: string | undefined): void {
  const expected = process.env.INTERNAL_SECRET;
  if (!expected || !provided) throw new UnauthorizedException('Invalid internal secret');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new UnauthorizedException('Invalid internal secret');
  }
}
