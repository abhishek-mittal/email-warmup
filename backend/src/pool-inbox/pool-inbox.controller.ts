import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { BatchInboxEntry } from '@/inbox/inbox.service';
import { parseInboxBatchCsv, isMalformedCsvRow } from '@/common/csv-parser';
import { getLatestAnalysisForPoolInboxes } from '@/analysis/analysis.service';
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
    return this.poolInboxService.batchUpload(req.userId!, entries);
  }

  /** CSV variant of `POST /pool-inboxes/batch` — see InboxController.batchUploadCsv. */
  @Post('batch/csv')
  @UseInterceptors(FileInterceptor('file'))
  async batchUploadCsv(
    @Req() req: Request & { userId?: string },
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file?.buffer) {
      throw new BadRequestException('CSV file is required (multipart field "file")');
    }

    const parsedRows = parseInboxBatchCsv(file.buffer.toString('utf8'));

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

  /** Soft delete: status='removed', irreversible, ownership-checked. */
  @Delete(':id')
  async remove(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    await this.poolInboxService.softDelete(req.userId!, id);
    return { success: true };
  }
}
