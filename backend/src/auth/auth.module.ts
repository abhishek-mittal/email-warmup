import { Module } from '@nestjs/common';
import { BetterAuthGuard } from './better-auth.guard';
import { InternalController } from './internal.controller';
import { UserSyncService } from './user-sync.service';

@Module({
  controllers: [InternalController],
  providers: [BetterAuthGuard, UserSyncService],
  exports: [BetterAuthGuard, UserSyncService],
})
export class AuthModule {}
