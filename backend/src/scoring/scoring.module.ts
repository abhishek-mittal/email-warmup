import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { ScoringService } from './scoring.service';
import { TrendService } from './trend.service';
import { ScoreComputeProcessor } from './score-compute.processor';
import { ScoringController } from './scoring.controller';

@Module({
  imports: [QueueModule],
  controllers: [ScoringController],
  providers: [ScoringService, TrendService, ScoreComputeProcessor],
  exports: [ScoringService, TrendService],
})
export class ScoringModule {}
