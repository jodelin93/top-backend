import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  // JobsModule re-exports its Bull queues; the Redis check pings their connection
  imports: [JobsModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
