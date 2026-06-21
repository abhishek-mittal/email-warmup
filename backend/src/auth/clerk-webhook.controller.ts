import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Webhook } from 'svix';
import { UserSyncService } from './user-sync.service';

@Controller('webhooks')
export class ClerkWebhookController {
  constructor(private readonly userSync: UserSyncService) {}

  @Post('clerk')
  async handleClerkWebhook(
    @Req() req: RawBodyRequest<any>,
    @Headers() headers: Record<string, string>,
  ) {
    const secret = process.env.CLERK_WEBHOOK_SECRET;
    if (!secret) {
      throw new BadRequestException('Webhook secret not configured');
    }

    const wh = new Webhook(secret);
    let event: any;
    try {
      event = wh.verify(req.rawBody, {
        'svix-id': headers['svix-id'],
        'svix-timestamp': headers['svix-timestamp'],
        'svix-signature': headers['svix-signature'],
      });
    } catch {
      throw new BadRequestException('Invalid webhook signature');
    }

    switch (event.type) {
      case 'user.created': {
        const primary = event.data.email_addresses?.[0]?.email_address;
        if (primary) {
          await this.userSync.upsertUser({
            id: event.data.id,
            email: primary,
            plan: 'trial',
            trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          });
        }
        break;
      }
      case 'user.updated': {
        const primary = event.data.email_addresses?.[0]?.email_address;
        if (primary) {
          await this.userSync.updateEmail(event.data.id, primary);
        }
        break;
      }
      case 'user.deleted': {
        await this.userSync.softDeleteUser(event.data.id);
        break;
      }
    }

    return { received: true };
  }
}
