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
import { Request } from 'express';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { BatchInboxEntry } from '@/inbox/inbox.service';
import { parseInboxBatchCsv, isMalformedCsvRow } from '@/common/csv-parser';
import { MAX_IMPORT_BYTES, assertImportSize } from '@/common/import-limits';
import {
  getLatestAnalysisForPoolInboxes,
  getLatestAnalysisForPoolInbox,
} from '@/analysis/analysis.service';
import { PoolInboxService } from './pool-inbox.service';
import { BatchUploadDto, BatchInboxEntryDto } from './dto/batch-inbox-entry.dto';

@Controller('pool-inboxes')
@UseGuards(BetterAuthGuard)
export class PoolInboxController {
  constructor(private readonly poolInboxService: PoolInboxService) {}

  /**
   * Batch upload (T020). Same shape/semantics as `POST /inboxes/batch` —
   * see InboxController.batchUpload for the shared rationale. Writes to
   * `pool_inboxes` instead of `inboxes`.
   */
  @Post('batch')
  async batchUpload(@Req() req: Request & { userId?: string }, @Body() body: BatchUploadDto) {
    const entries = (body?.inboxes ?? []) as BatchInboxEntry[];
    assertImportSize(entries.length);
    return this.poolInboxService.batchUpload(req.userId!, entries);
  }

  /** CSV variant of `POST /pool-inboxes/batch` — see InboxController.batchUploadCsv. */
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
   * Lists pool inboxes for the authenticated user, each with its latest
   * `inbox_analysis` row (or null if analysis hasn't completed yet)
   * attached as `analysis`.
   */
  @Get()
  async findAll(@Req() req: Request & { userId?: string }) {
    const poolInboxes = await this.poolInboxService.findByUser(req.userId!);
    const analysisByPoolInboxId = await getLatestAnalysisForPoolInboxes(
      poolInboxes.map((poolInbox) => poolInbox.id),
    );
    return poolInboxes.map((poolInbox) => ({
      ...poolInbox,
      analysis: analysisByPoolInboxId.get(poolInbox.id) ?? null,
    }));
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
