import { Module } from '@nestjs/common';
import { BetterAuthGuard } from './better-auth.guard';
import { UserSyncService } from './user-sync.service';

@Module({
  providers: [BetterAuthGuard, UserSyncService],
  exports: [BetterAuthGuard, UserSyncService],
})
export class AuthModule {}
