import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { BatchInboxEntry } from '@/inbox/inbox.service';
import { parseInboxBatchCsv, isMalformedCsvRow } from '@/common/csv-parser';
import { MAX_IMPORT_BYTES, assertImportSize } from '@/common/import-limits';
import {
  getLatestAnalysisForPoolInboxes,
  getLatestAnalysisForPoolInbox,
  getLatestAnalysisForInboxes,
} from '@/analysis/analysis.service';
import { PoolInboxService } from './pool-inbox.service';
import { BatchInboxEntryDto } from './dto/batch-inbox-entry.dto';

@Controller('pool-inboxes')
@UseGuards(BetterAuthGuard)
export class PoolInboxController {
  constructor(private readonly poolInboxService: PoolInboxService) {}

  /**
   * Batch upload (T020). Same shape/semantics as `POST /inboxes/batch` —
   * see InboxController.batchUpload for the shared rationale. Writes to
   * `pool_inboxes` instead of `inboxes`.
   */
  // Loosely typed so the global strict ValidationPipe is skipped and the T020
  // partial-success contract holds — see InboxController.batchUpload.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('batch')
  async batchUpload(
    @Req() req: Request & { userId?: string },
    @Body() body: { inboxes?: unknown[] },
  ) {
    const entries = (body?.inboxes ?? []) as BatchInboxEntry[];
    assertImportSize(entries.length);
    return this.poolInboxService.batchUpload(req.userId!, entries);
  }

  /** CSV variant of `POST /pool-inboxes/batch` — see InboxController.batchUploadCsv. */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('batch/csv')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES, files: 1 } }))
  async batchUploadCsv(
    @Req() req: Request & { userId?: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('CSV file is required (multipart field "file")');
    }

    const parsedRows = parseInboxBatchCsv(file.buffer.toString('utf8'));
    assertImportSize(parsedRows.length);

    const failed: { email: string; reason: string }[] = [];
    const validEntries: BatchInboxEntry[] = [];

    for (const row of parsedRows) {
      if (isMalformedCsvRow(row)) {
        failed.push({ email: row.email, reason: row.__reason });
        continue;
      }
      validEntries.push(row as BatchInboxEntry);
    }

    const result = await this.poolInboxService.batchUpload(req.userId!, validEntries);

    return {
      created: result.created,
      failed: [...failed, ...result.failed],
    };
  }

  /** Single pool-inbox add — same per-entry validation as one batch row. */
  @Post()
  async createOne(@Req() req: Request & { userId?: string }, @Body() body: BatchInboxEntryDto) {
    return this.poolInboxService.create(req.userId!, body as BatchInboxEntry);
  }

  /**
   * Lists everything in the user's warming pool, each row with its latest
   * `inbox_analysis` attached as `analysis` and a `source` discriminator:
   *
   *   - `'dedicated'` — rows from `pool_inboxes` (added via the CSV / wizard
   *     uploads on this page). Analysis keyed by `poolInboxId`.
   *   - `'owned'` — the user's own connected inboxes that have consented to
   *     the shared pool (`inboxes.poolConsentAt` set). Analysis keyed by
   *     `inboxId`. These are managed from the inbox detail page, so the
   *     frontend routes/acts on them differently (no pool-inbox reanalyze /
   *     remove — see PoolInboxGrid).
   *
   * Without the `'owned'` half, a user who connected a mailbox and toggled
   * "Join shared pool" never saw it here (it lives in `inboxes` /
   * `pool_members`, not `pool_inboxes`).
   */
  @Get()
  async findAll(@Req() req: Request & { userId?: string }) {
    const [dedicated, owned] = await Promise.all([
      this.poolInboxService.findByUser(req.userId!),
      this.poolInboxService.findConsentedOwnedForPool(req.userId!),
    ]);

    const [analysisByPoolInboxId, analysisByInboxId] = await Promise.all([
      getLatestAnalysisForPoolInboxes(dedicated.map((row) => row.id)),
      getLatestAnalysisForInboxes(owned.map((row) => row.id)),
    ]);

    return [
      ...dedicated.map((row) => ({
        ...row,
        source: 'dedicated' as const,
        analysis: analysisByPoolInboxId.get(row.id) ?? null,
      })),
      ...owned.map((row) => ({
        ...row,
        source: 'owned' as const,
        analysis: analysisByInboxId.get(row.id) ?? null,
      })),
    ];
  }

  /**
   * Single pool-inbox lookup with its latest analysis attached.
   * Ownership-checked — 404 if not found or belongs to another user.
   * Mirrors `InboxController.findOne`.
   */
  @Get(':id')
  async findOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    const row = await this.poolInboxService.findById(req.userId!, id);
    if (!row) throw new NotFoundException();
    const analysis = await getLatestAnalysisForPoolInbox(id);
    return { ...row, analysis };
  }

  /** Soft delete: status='removed', irreversible, ownership-checked. */
  @Delete(':id')
  async remove(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    await this.poolInboxService.softDelete(req.userId!, id);
    return { success: true };
  }

  /**
   * Re-run DNS analysis for one pool inbox (per-row "Re-analyze" button).
   * Returns 204 — the analysis itself happens asynchronously in the
   * `inbox-analysis` BullMQ worker, the result is observed by the
   * frontend via the `GET /pool-inboxes` analysis join. The service
   * resets `status='pending'` first so the readiness badge flips to
   * "Analysing…" immediately, before the worker even picks the job up.
   */
  @Post(':id/analyze')
  @HttpCode(204)
  async reanalyze(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    await this.poolInboxService.reanalyze(req.userId!, id);
  }
}
