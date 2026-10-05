import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  UnprocessableEntityException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { validateSync } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { InboxService, BatchInboxEntry } from './inbox.service';
import { PairingService } from '@/warmup/pairing.service';
import { MailboxLinkService, LinkProvider } from './oauth/mailbox-link.service';
import { normalizeAliases } from './dto/connect-custom-smtp.dto';
import { parseInboxBatchCsv, isMalformedCsvRow } from '@/common/csv-parser';
import { MAX_IMPORT_BYTES, assertImportSize } from '@/common/import-limits';
import {
  getLatestAnalysisForInbox,
  getLatestAnalysisForInboxes,
} from '@/analysis/analysis.service';

@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class InboxController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly pairing: PairingService,
  ) {}

  /**
   * Attaches each inbox's latest `inbox_analysis` row (or null if analysis
   * hasn't completed yet) as `analysis` — T023's grid needs the DNS
   * Health/Issues columns sourced from here.
   */
  @Get()
  async findAll(@Req() req: Request & { userId?: string }) {
    const inboxes = await this.inboxService.findByUser(req.userId!);
    const analysisByInboxId = await getLatestAnalysisForInboxes(inboxes.map((inbox) => inbox.id));
    return inboxes.map((inbox) => ({
      ...inbox,
      analysis: analysisByInboxId.get(inbox.id) ?? null,
    }));
  }

  /** Ownership-checked single-row lookup (T020 addendum), with the latest `inbox_analysis` row attached. */
  @Get(':id')
  async findOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    const inbox = await this.inboxService.findById(req.userId!, id);
    if (!inbox) throw new NotFoundException();
    const analysis = await getLatestAnalysisForInbox(id);
    // Drives the UI's Start button vs. the "add warming inboxes" prompt.
    const canStart = await this.pairing.hasEligiblePartners(inbox as never);
    return { ...inbox, analysis, warmupEligibility: { canStart } };
  }

  /**
   * Batch upload (T020). Accepts `{ inboxes: [...] }`, same per-entry shape
   * as `POST /pool-inboxes/batch`. Per-row structural validation is done in
   * InboxService.batchUpload (validateBatchEntry): entries missing required
   * fields for their provider land in `failed[]` and never abort the whole
   * request, matching the "partial success" requirement.
   *
   * The body is typed loosely on purpose so the global strict ValidationPipe
   * (whitelist + forbidNonWhitelisted) does NOT run against it — otherwise a
   * single malformed entry would reject the whole request with a 400 instead
   * of landing in `failed[]`.
   */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('batch')
  async batchUpload(
    @Req() req: Request & { userId?: string },
    @Body() body: { inboxes?: unknown[] },
  ) {
    const entries = (body?.inboxes ?? []) as BatchInboxEntry[];
    assertImportSize(entries.length);
    return this.inboxService.batchUpload(req.userId!, entries);
  }

  /**
   * CSV variant of `POST /inboxes/batch` (T020). Parses the uploaded file
   * in memory (never persisted to disk or DB) and funnels every
   * structurally valid row through the exact same InboxService.batchUpload
   * used by the JSON path. Rows the CSV parser itself flags as malformed
   * (missing required columns for their provider, unknown provider, no
   * email) are folded directly into the response's `failed[]` without ever
   * reaching the service — they never had enough information to attempt
   * an insert.
   */
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

    const result = await this.inboxService.batchUpload(req.userId!, validEntries);

    return {
      created: result.created,
      failed: [...failed, ...result.failed],
    };
  }

  /** Grant or withdraw consent to the shared warmup pool for one inbox. */
  @Post(':id/pool-consent')
  async setPoolConsent(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Body() body: { granted?: unknown },
  ) {
    if (typeof body?.granted !== 'boolean') {
      throw new BadRequestException('granted must be true or false');
    }
    const result = await this.inboxService.setPoolConsent(req.userId!, id, body.granted);
    if (!result) throw new NotFoundException();
    return result;
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('connect/smtp')
  async connectCustomSmtp(
    @Req() req: Request & { userId?: string },
    @Body() body: Record<string, unknown>,
  ) {
    // Normalize wire-format aliases (smtpPassword / imapPassword) into
    // the canonical DTO field names (smtpPass / imapPass) BEFORE
    // class-validator runs. Using a custom normalization helper here
    // instead of the framework ValidationPipe so the form's
    // user-friendly field names work without changing the DTO.
    const dto = normalizeAliases(body ?? {});
    const errors = validateSync(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length > 0) {
      const messages = errors.flatMap((e) => (e.constraints ? Object.values(e.constraints) : []));
      throw new BadRequestException(messages);
    }
    try {
      return await this.inboxService.connectCustomSmtp(req.userId!, dto);
    } catch (err: any) {
      if (err?.step) {
        throw new UnprocessableEntityException({
          step: err.step,
          error: err.message,
          errCode: err.errCode,
          host: err.host,
          port: err.port,
        });
      }
      throw err;
    }
  }
}

const CALLBACK_PROVIDERS: Record<string, LinkProvider> = { google: 'gmail', microsoft: 'outlook' };

/**
 * Mailbox OAuth linking endpoints (MR-01). Every route here requires a
 * signed-in user: the flow is started by, and may only be completed by, the
 * same account. The provider redirects the browser to the frontend
 * (/api/mailbox-oauth/callback/*), which forwards the result here with the
 * user's session — there is no public callback on the API.
 */
@Controller('auth')
@UseGuards(BetterAuthGuard)
export class AuthCallbackController {
  constructor(private readonly mailboxLink: MailboxLinkService) {}

  @Get('gmail/connect')
  getGmailConnectUrl(
    @Req() req: Request & { userId?: string },
    @Query('poolConsent') poolConsent?: string,
  ) {
    return this.mailboxLink.start(req.userId!, 'gmail', { poolConsent: poolConsent === 'true' });
  }

  @Get('outlook/connect')
  getOutlookConnectUrl(
    @Req() req: Request & { userId?: string },
    @Query('poolConsent') poolConsent?: string,
  ) {
    return this.mailboxLink.start(req.userId!, 'outlook', { poolConsent: poolConsent === 'true' });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('mailbox/callback')
  async completeLink(
    @Req() req: Request & { userId?: string },
    @Body() body: { provider?: unknown; code?: unknown; state?: unknown; error?: unknown },
  ) {
    const provider = typeof body?.provider === 'string' ? CALLBACK_PROVIDERS[body.provider] : null;
    if (!provider) throw new BadRequestException('Unknown provider');
    const text = (value: unknown) =>
      typeof value === 'string' && value.length > 0 && value.length <= 4096 ? value : undefined;
    return this.mailboxLink.complete(req.userId!, provider, {
      code: text(body.code),
      state: text(body.state),
      error: text(body.error),
    });
  }
}
