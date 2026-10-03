import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import { safetyStops } from '../db/schema';

/** Reasons the system pauses an inbox for that a user's Resume click must not override. */
export const SYSTEM_HOLD_REASONS = ['bounce_rate'];

export type StopScope = 'global' | 'provider' | 'user';

export interface StopTarget {
  userId: string;
  provider: string;
}

export interface ActiveStop {
  id: string;
  scope: string;
  key: string;
  reason: string;
}

const SCOPES: StopScope[] = ['global', 'provider', 'user'];
const PROVIDERS = ['gmail', 'outlook', 'custom'];

/**
 * Operator stop switches (MR-12): halt new warmup submissions everywhere,
 * for one mail provider, or for one account. Checked by the scheduler before
 * it reserves anything and by the workers immediately before each
 * submission, so a stop takes effect on the very next send — including ones
 * already queued. Mail a server has already accepted cannot be recalled.
 *
 * Stops live in the database (not in memory or env), so every replica sees
 * the same state, and rows are never deleted: the table is the audit trail.
 */
@Injectable()
export class SafetyStopService {
  private readonly logger = new Logger(SafetyStopService.name);

  /** The stop that applies to this sender right now, or null. */
  async activeStopFor(target: StopTarget): Promise<ActiveStop | null> {
    const rows = await db.select().from(safetyStops).where(isNull(safetyStops.clearedAt));
    const match = rows.find(
      (row) =>
        row.scope === 'global' ||
        (row.scope === 'provider' && row.key === target.provider) ||
        (row.scope === 'user' && row.key === target.userId),
    );
    return match
      ? { id: match.id, scope: match.scope, key: match.key, reason: match.reason }
      : null;
  }

  async list(includeCleared = false) {
    const query = db.select().from(safetyStops).orderBy(desc(safetyStops.createdAt));
    return includeCleared ? query : query.where(isNull(safetyStops.clearedAt));
  }

  /** Activates a stop. Idempotent: an identical active stop is returned rather than duplicated. */
  async activate(input: { scope: string; key?: string; reason: string; actor: string }) {
    const scope = input.scope as StopScope;
    if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
    const key = scope === 'global' ? '*' : (input.key ?? '').trim();
    if (scope === 'provider' && !PROVIDERS.includes(key)) {
      throw new Error(`provider must be one of ${PROVIDERS.join(', ')}`);
    }
    if (scope === 'user' && !key) throw new Error('key (user id) is required for a user stop');
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new Error('reason is required');

    const existing = await db
      .select()
      .from(safetyStops)
      .where(
        and(eq(safetyStops.scope, scope), eq(safetyStops.key, key), isNull(safetyStops.clearedAt)),
      )
      .limit(1);
    if (existing[0]) return existing[0];

    const [row] = await db
      .insert(safetyStops)
      .values({ scope, key, reason: reason.slice(0, 500), createdBy: input.actor.slice(0, 120) })
      .returning();
    this.logger.warn({ stopId: row.id, scope, key, actor: input.actor }, 'safety stop ACTIVATED');
    return row;
  }

  /** Clears a stop. Returns null when it does not exist or was already cleared. */
  async clear(id: string, actor: string) {
    const [row] = await db
      .update(safetyStops)
      .set({ clearedAt: new Date(), clearedBy: actor.slice(0, 120) })
      .where(and(eq(safetyStops.id, id), isNull(safetyStops.clearedAt)))
      .returning();
    if (row) {
      this.logger.warn(
        { stopId: id, scope: row.scope, key: row.key, actor },
        'safety stop cleared',
      );
    }
    return row ?? null;
  }
}
