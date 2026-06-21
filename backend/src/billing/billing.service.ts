import { Injectable, ForbiddenException } from '@nestjs/common';
import { eq, count } from 'drizzle-orm';
import { db } from '../db';
import { users, inboxes } from '../db/schema';

export const PLAN_LIMITS: Record<
  string,
  { inboxes: number }
> = {
  trial: { inboxes: 3 },
  starter: { inboxes: 3 },
  growth: { inboxes: 20 },
  agency: { inboxes: 100 },
  enterprise: { inboxes: Infinity },
};

@Injectable()
export class BillingService {
  async assertPlan(userId: string, allowedPlans: string[]): Promise<void> {
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || !allowedPlans.includes(user.plan)) {
      throw new ForbiddenException(
        `This feature requires plan: ${allowedPlans.join(' or ')}`,
      );
    }
  }

  async assertInboxLimit(userId: string): Promise<void> {
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user) {
      throw new ForbiddenException('User not found');
    }
    const limit = PLAN_LIMITS[user.plan]?.inboxes ?? 0;
    const [result] = await db
      .select({ count: count() })
      .from(inboxes)
      .where(eq(inboxes.userId, userId));
    if (result.count >= limit) {
      throw new ForbiddenException(
        `Inbox limit reached for ${user.plan} plan (${limit} inboxes)`,
      );
    }
  }
}
