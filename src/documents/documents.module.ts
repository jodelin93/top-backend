import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { PrintJobsService } from './print-jobs.service';
import { DocumentDeliveriesService } from './document-deliveries.service';
import {
  DocumentsController,
  PrintJobsController,
  PublicReceiptsController,
} from './documents.controller';

/**
 * Documents (spec §15): print history (print_jobs), e-mailed receipts and shared
 * receipt links (document_deliveries), server-rendered HTML receipts.
 * E-mail goes through the platform's EMAIL_CHANNEL (NotificationsModule, global).
 */
@Module({
  imports: [SettingsModule],
  controllers: [
    PrintJobsController,
    DocumentsController,
    PublicReceiptsController,
  ],
  providers: [PrintJobsService, DocumentDeliveriesService],
  exports: [PrintJobsService],
})
export class DocumentsModule {}
