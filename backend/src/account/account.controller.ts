import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { BetterAuthGuard } from '../auth/better-auth.guard';
import { AccountService } from './account.service';

type AuthedRequest = Request & { userId?: string };

@Controller()
@UseGuards(BetterAuthGuard)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  /** Stop a mailbox for good and erase its stored credentials. */
  @Post('inboxes/:id/disconnect')
  @HttpCode(200)
  disconnect(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.account.disconnectInbox(req.userId!, id);
  }

  /** Everything held about the signed-in account, as JSON. */
  @Get('account/export')
  export(@Req() req: AuthedRequest) {
    return this.account.exportData(req.userId!);
  }

  /** Delete the signed-in account: `{ confirmEmail }` must match its address. */
  @Post('account/delete')
  @HttpCode(200)
  delete(@Req() req: AuthedRequest, @Body() body: { confirmEmail?: unknown }) {
    return this.account.deleteAccount(req.userId!, body?.confirmEmail);
  }
}
