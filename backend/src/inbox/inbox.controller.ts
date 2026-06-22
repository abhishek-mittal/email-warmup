import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Redirect,
  Req,
  UseGuards,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { validateSync } from 'class-validator';
import { BetterAuthGuard } from '@/auth/better-auth.guard';
import { Public } from '@/auth/public.decorator';
import { InboxService } from './inbox.service';
import { GoogleOAuthService } from './oauth/google-oauth.service';
import { MicrosoftOAuthService } from './oauth/microsoft-oauth.service';
import {
  ConnectCustomSmtpDto,
  normalizeAliases,
} from './dto/connect-custom-smtp.dto';

@Controller('inboxes')
@UseGuards(BetterAuthGuard)
export class InboxController {
  constructor(private readonly inboxService: InboxService) {}

  @Get()
  findAll(@Req() req: Request & { userId?: string }) {
    return this.inboxService.findByUser(req.userId!);
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
      const messages = errors.flatMap((e) =>
        e.constraints ? Object.values(e.constraints) : [],
      );
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
