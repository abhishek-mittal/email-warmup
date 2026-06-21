import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';

@Injectable()
export class UserSyncService {
  async upsertUser(input: { id: string; email: string; plan?: string; trialEndsAt?: Date }) {
    const existing = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (existing.length > 0) {
      return db
        .update(users)
        .set({ email: input.email, plan: input.plan ?? existing[0].plan })
        .where(eq(users.id, input.id));
    }
    return db.insert(users).values({
      id: input.id,
      email: input.email,
      plan: input.plan ?? 'trial',
      trialEndsAt: input.trialEndsAt ?? this.defaultTrialEnd(),
    });
  }

  async updateEmail(id: string, email: string) {
    return db.update(users).set({ email }).where(eq(users.id, id));
  }

  async softDeleteUser(id: string) {
    return db.update(users).set({ plan: 'deleted' }).where(eq(users.id, id));
  }

  private defaultTrialEnd(): Date {
    return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  }
}
