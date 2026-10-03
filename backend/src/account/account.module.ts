import { Module } from '@nestjs/common';
import { InboxModule } from '../inbox/inbox.module';
import { WarmupModule } from '../warmup/warmup.module';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

@Module({
  imports: [WarmupModule, InboxModule],
  controllers: [AccountController],
  providers: [AccountService],
})
export class AccountModule {}
