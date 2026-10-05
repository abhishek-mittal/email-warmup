import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { sql } from 'drizzle-orm';
import { db } from '../db';
import { Public } from '../auth/public.decorator';
import { QueueService } from '../queue/queue.service';

const PROBE_TIMEOUT_MS = 3_000;

/** Set when the process hit an unrecoverable error and is about to exit. */
let shuttingDown = false;
export function markUnready(): void {
  shuttingDown = true;
}

function withTimeout<T>(work: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
}

@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly queueService: QueueService) {}

  /** Liveness: the process is up and serving HTTP. Says nothing about dependencies. */
  @Public()
  @Get()
  health() {
    return { status: 'ok', version: '0.1.0' };
  }

  /**
   * Readiness: the database and the queue both answer. 503 otherwise, so a
   * load balancer stops routing here and an operator can see which part failed.
   */
  @Public()
  @Get('ready')
  async ready() {
    const checks: Record<string, 'ok' | 'failed'> = { database: 'failed', queue: 'failed' };
    if (!shuttingDown) {
      await Promise.all([
        withTimeout(db.execute(sql`select 1`), 'database')
          .then(() => (checks.database = 'ok'))
          .catch(() => undefined),
        withTimeout(this.queueService.getJobCounts('warmup-send'), 'queue')
          .then(() => (checks.queue = 'ok'))
          .catch(() => undefined),
      ]);
    }
    const ok = !shuttingDown && Object.values(checks).every((value) => value === 'ok');
    if (!ok) {
      throw new ServiceUnavailableException({
        status: shuttingDown ? 'shutting_down' : 'unready',
        checks,
      });
    }
    return { status: 'ready', checks };
  }
}
