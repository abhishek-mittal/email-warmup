import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { NotifyProcessor } from './notify.processor';

@Module({
  imports: [QueueModule],
  providers: [NotifyProcessor],
})
export class NotifyModule {}
