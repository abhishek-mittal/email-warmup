import { Module } from '@nestjs/common';
import { ClerkGuard } from './clerk.guard';
import { ClerkWebhookController } from './clerk-webhook.controller';
import { UserSyncService } from './user-sync.service';

@Module({
  controllers: [ClerkWebhookController],
  providers: [ClerkGuard, UserSyncService],
  exports: [ClerkGuard, UserSyncService],
})
export class AuthModule {}
