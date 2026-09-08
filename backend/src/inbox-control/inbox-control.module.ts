import { Module } from '@nestjs/common';
import { InboxControlController } from './inbox-control.controller';
import { InboxControlService } from './inbox-control.service';
import { WarmupModule } from '../warmup/warmup.module';

@Module({
  // We import WarmupModule (not InboxModule) to avoid a cycle: warmup
  // already imports inbox for ContentService. The only thing this
  // module needs from the warmup side is the pause/resume methods
  // on WarmupService.
  imports: [WarmupModule],
  controllers: [InboxControlController],
  providers: [InboxControlService],
})
export class InboxControlModule {}