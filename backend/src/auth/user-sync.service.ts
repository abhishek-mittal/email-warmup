import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema';
import { isDemoMode } from '../billing/billing.service';

export interface UpsertUserResult {
  /** True when a new row was inserted, false when an existing row was updated. */
  created: boolean;
}

@Injectable()
export class UserSyncService {
  /**
   * Idempotent upsert against the backend's `users` table. Called by the
   * frontend's better-auth `databaseHooks.user.create.after` callback
   * (via `InternalController.syncUser`) so the backend's plan/trial
   * columns are populated for every fresh sign-in.
   *
   * Always returns `{ created: boolean }`. The `created` flag is the
   * reliable signal the controller uses to report back to the frontend
   * (Drizzle's `RETURNING` shape varies across drivers).
   */
  async upsertUser(input: {
    id: string;
    email: string;
    plan?: string;
    trialEndsAt?: Date;
  }): Promise<UpsertUserResult> {
    const existing = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (existing.length > 0) {
      await db
        .update(users)
        .set({ email: input.email, plan: input.plan ?? existing[0].plan })
        .where(eq(users.id, input.id));
      return { created: false };
    }
    // In demo mode every new account gets the demo plan's test credits and
    // no trial clock; otherwise the normal 7-day trial.
    const demo = isDemoMode() && !input.plan;
    await db.insert(users).values({
      id: input.id,
      email: input.email,
      plan: demo ? 'demo' : (input.plan ?? 'trial'),
      trialEndsAt: demo ? null : (input.trialEndsAt ?? this.defaultTrialEnd()),
    });
    return { created: true };
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
