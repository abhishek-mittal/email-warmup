import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Redirect,
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
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { Public } from '@/auth/public.decorator';
import { InboxService, BatchInboxEntry } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import { normalizeAliases } from './dto/connect-custom-smtp.dto';
import { BatchUploadDto } from '@/pool-inbox/dto/batch-inbox-entry.dto';
import { parseInboxBatchCsv, isMalformedCsvRow } from '@/common/csv-parser';

@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  findAll(@Req() req: Request & { userId?: string }) {
    return this.inboxService.findByUser(req.userId!);
  }

  /**
   * Ownership-checked single-row lookup (T020 addendum). No analysis join
   * yet — a later step attaches the latest `inbox_analysis` row here.
   */
  @Get(':id')
  async findOne(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    const inbox = await this.inboxService.findById(req.userId!, id);
    if (!inbox) throw new NotFoundException();
    return inbox;
  }

  /**
   * Batch upload (T020). Accepts `{ inboxes: [...] }`, same per-entry shape
   * as `POST /pool-inboxes/batch`. class-validator (via BatchUploadDto)
   * structurally rejects entries missing required fields for their
   * provider before they ever reach InboxService — those land in
   * `failed[]`, never abort the whole request, matching the "partial
   * success" requirement (validateBatchEntry duplicates the same checks
   * for entries that the ValidationPipe can't catch, e.g. an unrecognized
   * provider value combined with otherwise-empty fields — defense in depth
   * with the service-layer validation that also runs per row).
   */
  @Post('batch')
  async batchUpload(@Req() req: Request & { userId?: string }, @Body() body: BatchUploadDto) {
    const entries = (body?.inboxes ?? []) as BatchInboxEntry[];
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

    const result = await this.inboxService.batchUpload(req.userId!, validEntries);

    return {
      created: result.created,
      failed: [...failed, ...result.failed],
    };
  }

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
        });
      }
      throw err;
    }
  }
}

@Controller('auth')
export class AuthCallbackController {
  constructor(
    private readonly inboxService: InboxService,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly microsoftOAuth: MicrosoftOAuthService,
  ) {}

  @Public()
  @Get('gmail/connect')
  getGmailConnectUrl(@Req() req: Request & { userId?: string }) {
    const state = Buffer.from(JSON.stringify({ userId: req.userId || 'anonymous' })).toString(
      'base64url',
    );
    return { url: this.googleOAuth.getAuthorizationUrl(state) };
  }

  @Public()
  @Get('outlook/connect')
  getOutlookConnectUrl(@Req() req: Request & { userId?: string }) {
    const state = Buffer.from(JSON.stringify({ userId: req.userId || 'anonymous' })).toString(
      'base64url',
    );
    return { url: this.microsoftOAuth.getAuthorizationUrl(state) };
  }

  @Public()
  @Get('callback/google')
  @Redirect()
  async googleCallback(@Query('code') code: string, @Query('state') state: string) {
    const { userId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    await this.inboxService.connectGmail(userId, code);
    return { url: '/inboxes' };
  }

  @Public()
  @Get('callback/microsoft')
  @Redirect()
  async microsoftCallback(@Query('code') code: string, @Query('state') state: string) {
    const { userId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    await this.inboxService.connectOutlook(userId, code);
    return { url: '/inboxes' };
  }
}
