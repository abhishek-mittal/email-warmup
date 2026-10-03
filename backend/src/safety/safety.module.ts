import { Module } from '@nestjs/common';
import { SafetyStopService } from './safety-stop.service';
import { SafetyController } from './safety.controller';

/**
 * Stop switches only. Bounce monitoring needs the warmup engine and the
 * mailbox clients, so BounceMonitorService is provided by WarmupModule to
 * avoid a module cycle.
 */
@Module({
  controllers: [SafetyController],
  providers: [SafetyStopService],
  exports: [SafetyStopService],
})
export class SafetyModule {}
