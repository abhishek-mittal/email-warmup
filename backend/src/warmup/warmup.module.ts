import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { InboxModule } from '../inbox/inbox.module';
import { ContentService } from './content.service';
import { WarmupSendProcessor } from './warmup-send.processor';
import { WarmupReceiveProcessor } from './warmup-receive.processor';
import { WarmupService } from './warmup.service';
import { RampService } from './ramp.service';
import { PairingService } from './pairing.service';
import { WarmupLedgerService } from './warmup-ledger.service';
import { SafetyModule } from '../safety/safety.module';
import { PlacementModule } from '../placement/placement.module';
import { BounceMonitorService } from '../safety/bounce-monitor.service';

@Module({
  imports: [QueueModule, InboxModule, SafetyModule, PlacementModule],
  providers: [
    ContentService,
    WarmupSendProcessor,
    WarmupReceiveProcessor,
    WarmupService,
    RampService,
    PairingService,
    WarmupLedgerService,
    BounceMonitorService,
  ],
  exports: [
    ContentService,
    WarmupService,
    RampService,
    PairingService,
    WarmupLedgerService,
    BounceMonitorService,
  ],
})
export class WarmupModule {}
