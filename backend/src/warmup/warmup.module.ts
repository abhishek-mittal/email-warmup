import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { InboxModule } from '../inbox/inbox.module';
import { ContentService } from './content.service';
import { WarmupSendProcessor } from './warmup-send.processor';
import { WarmupReceiveProcessor } from './warmup-receive.processor';
import { WarmupService } from './warmup.service';
import { RampService } from './ramp.service';
import { PairingService } from './pairing.service';

@Module({
  imports: [QueueModule, InboxModule],
  providers: [
    ContentService,
    WarmupSendProcessor,
    WarmupReceiveProcessor,
    WarmupService,
    RampService,
    PairingService,
  ],
  exports: [ContentService, WarmupService, RampService, PairingService],
})
export class WarmupModule {}
