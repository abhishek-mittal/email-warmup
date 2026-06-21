import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { InboxModule } from '../inbox/inbox.module';
import { ContentService } from './content.service';
import { WarmupSendProcessor } from './warmup-send.processor';
import { WarmupReceiveProcessor } from './warmup-receive.processor';

@Module({
  imports: [QueueModule, InboxModule],
  providers: [ContentService, WarmupSendProcessor, WarmupReceiveProcessor],
  exports: [ContentService],
})
export class WarmupModule {}
