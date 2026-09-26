import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { OutboxService } from './outbox/outbox.service';
import { EventHandlerRegistry } from './outbox/event-handler.registry';
import {
  DOMAIN_EVENTS_QUEUE,
  OutboxPublisherService,
} from './outbox/outbox-publisher.service';
import { ReconciliationJobsService } from './reconciliation-jobs.service';
import {
  BackupReportController,
  SystemEventsController,
} from './system-events.controller';

/**
 * Platform backbone (spec §17/§18): transactional outbox + publisher, event
 * consumers registry, scheduled reconciliation and the System events API.
 * Global so every module can record events and register consumers.
 */
@Global()
@Module({
  imports: [BullModule.registerQueue({ name: DOMAIN_EVENTS_QUEUE })],
  controllers: [SystemEventsController, BackupReportController],
  providers: [
    OutboxService,
    EventHandlerRegistry,
    OutboxPublisherService,
    ReconciliationJobsService,
  ],
  exports: [OutboxService, EventHandlerRegistry, OutboxPublisherService],
})
export class PlatformModule {}
