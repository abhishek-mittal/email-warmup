import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { WarmupModule } from '../warmup/warmup.module';
import { DnsService } from './dns.service';
import { DnsCheckProcessor } from './dns-check.processor';
import { BlacklistService } from './blacklist.service';
import { BlacklistCheckProcessor } from './blacklist-check.processor';

@Module({
  imports: [QueueModule, WarmupModule],
  providers: [DnsService, DnsCheckProcessor, BlacklistService, BlacklistCheckProcessor],
  exports: [DnsService, BlacklistService],
})
export class MonitorModule {}
