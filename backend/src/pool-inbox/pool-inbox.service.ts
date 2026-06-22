import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { poolInboxes } from '@/db/schema';
import { encrypt } from '@/common/crypto';
import { QueueService } from '@/queue/queue.service';
import { BatchInboxEntry, validateBatchEntry } from '@/inbox/inbox.service';

/**
 * `pool_inboxes.encrypted_credentials` JSONB shape — must match exactly
 * what T022's pairing engine expects to read. Only the named secret fields
 * are `encrypt()`-ed; everything else in the object is stored plaintext
 * (mirrors `inboxes.smtpUser`/`imapUser`/`smtpHost`/`imapHost` being
 * plaintext columns while `smtpPass`/`imapPass` are encrypted).
 */
export interface OAuthEncryptedCredentials {
  clientId: string;
  clientSecret: string; // encrypt()'d
  refreshToken: string; // encrypt()'d
}

export interface CustomEncryptedCredentials {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string; // encrypt()'d
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPassword: string; // encrypt()'d
}

export type EncryptedCredentials = OAuthEncryptedCredentials | CustomEncryptedCredentials;

/**
 * Columns safe to return to the frontend — excludes encryptedCredentials
 * (AES-256-GCM ciphertext blob; there's no reason to ship ciphertext to
 * the browser at all).
 */
const SAFE_POOL_INBOX_COLUMNS = {
  id: poolInboxes.id,
  userId: poolInboxes.userId,
  email: poolInboxes.email,
  provider: poolInboxes.provider,
  status: poolInboxes.status,
  displayName: poolInboxes.displayName,
  lastUsedAt: poolInboxes.lastUsedAt,
  activePairs: poolInboxes.activePairs,
  errorMessage: poolInboxes.errorMessage,
  createdAt: poolInboxes.createdAt,
  updatedAt: poolInboxes.updatedAt,
};

const POSTGRES_UNIQUE_VIOLATION = '23505';

function getPgErrorCode(err: any): string | undefined {
  return err?.code ?? err?.cause?.code;
}

function buildEncryptedCredentials(entry: BatchInboxEntry): EncryptedCredentials {
  if (entry.provider === 'gmail' || entry.provider === 'outlook') {
    return {
      clientId: entry.clientId!,
      clientSecret: encrypt(entry.clientSecret!),
      refreshToken: encrypt(entry.refreshToken!),
    };
  }

  return {
    smtpHost: entry.smtpHost!,
    smtpPort: Number(entry.smtpPort),
    smtpUser: entry.smtpUser!,
    smtpPassword: encrypt(entry.smtpPassword!),
    imapHost: entry.imapHost!,
    imapPort: Number(entry.imapPort),
    imapUser: entry.imapUser!,
    imapPassword: encrypt(entry.imapPassword!),
  };
}

@Injectable()
export class PoolInboxService {
  constructor(private readonly queue: QueueService) {}

  /**
   * Batch-uploads pool inboxes (T020). Mirrors InboxService.batchUpload —
   * same per-entry validation and partial-success semantics — but writes to
   * `pool_inboxes` with a single `encryptedCredentials` JSONB column
   * instead of flat columns, and relies on the DB-level UNIQUE index on
   * `pool_inboxes.email` (from T019) as the backstop for duplicates instead
   * of an application-level pre-check (a 23505 from a concurrent insert is
   * still possible and is caught the same way as the in-batch case).
   */
  async batchUpload(
    userId: string,
    entries: BatchInboxEntry[],
  ): Promise<{ created: number; failed: { email: string; reason: string }[] }> {
    const failed: { email: string; reason: string }[] = [];
    let created = 0;
    const seenInBatch = new Set<string>();

    for (const entry of entries) {
      const email = entry?.email ?? '(unknown)';
      try {
        const validationError = validateBatchEntry(entry);
        if (validationError) {
          failed.push({ email, reason: validationError });
          continue;
        }

        const normalizedEmail = entry.email.toLowerCase();
        if (seenInBatch.has(normalizedEmail)) {
          failed.push({ email, reason: 'duplicate email — already present in this batch' });
          continue;
        }

        const [row] = await db
          .insert(poolInboxes)
          .values({
            userId,
            email: entry.email,
            provider: entry.provider,
            status: 'pending',
            encryptedCredentials: buildEncryptedCredentials(entry),
          })
          .returning();

        seenInBatch.add(normalizedEmail);
        created += 1;

        await this.queue.add('inbox-analysis', { poolInboxId: row.id, userId });
      } catch (err: any) {
        if (getPgErrorCode(err) === POSTGRES_UNIQUE_VIOLATION) {
          failed.push({
            email,
            reason: 'duplicate email — a pool inbox with this email already exists',
          });
          continue;
        }
        failed.push({ email, reason: err?.message || 'failed to process row' });
      }
    }

    return { created, failed };
  }

  /**
   * Single pool-inbox add (`POST /pool-inboxes`). Same per-entry
   * validation as one batch row. Throws (rather than returning a
   * failed[]-style result) since there's only one entry — the controller
   * maps thrown errors to the appropriate HTTP status.
   */
  async create(userId: string, entry: BatchInboxEntry) {
    const validationError = validateBatchEntry(entry);
    if (validationError) {
      throw new BadRequestException(validationError);
    }

    try {
      const [row] = await db
        .insert(poolInboxes)
        .values({
          userId,
          email: entry.email,
          provider: entry.provider,
          status: 'pending',
          encryptedCredentials: buildEncryptedCredentials(entry),
        })
        .returning(SAFE_POOL_INBOX_COLUMNS);

      await this.queue.add('inbox-analysis', { poolInboxId: row.id, userId });
      return row;
    } catch (err: any) {
      if (getPgErrorCode(err) === POSTGRES_UNIQUE_VIOLATION) {
        throw new ConflictException(
          'duplicate email — a pool inbox with this email already exists',
        );
      }
      throw err;
    }
  }

  /** Plain rows for `GET /pool-inboxes` — no analysis join (deferred). */
  async findByUser(userId: string) {
    return db.select(SAFE_POOL_INBOX_COLUMNS).from(poolInboxes).where(eq(poolInboxes.userId, userId));
  }

  /**
   * Soft delete (`DELETE /pool-inboxes/:id`): ownership-checked, sets
   * status='removed'. Irreversible — no method on this service (or
   * anywhere else built in T020) ever sets a pool inbox's status back from
   * 'removed' to anything else.
   */
  async softDelete(userId: string, poolInboxId: string): Promise<void> {
    const rows = await db
      .select()
      .from(poolInboxes)
      .where(eq(poolInboxes.id, poolInboxId))
      .limit(1);
    const row = rows[0];
    if (!row || row.userId !== userId) {
      throw new NotFoundException();
    }

    await db.update(poolInboxes).set({ status: 'removed' }).where(eq(poolInboxes.id, poolInboxId));
  }
}
