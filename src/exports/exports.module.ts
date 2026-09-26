import { Module } from '@nestjs/common';
import { ReportsModule } from '../reports/reports.module';
import { ExportsService } from './exports.service';
import { ExportWorkerService } from './export-worker.service';
import { SavedFiltersService } from './saved-filters.service';
import {
  ExportDownloadController,
  ExportsController,
  SavedFiltersController,
} from './exports.controller';

/**
 * Background report exports with expiring download links, and saved report
 * filters (spec §14). Files go to private storage (StorageModule is global).
 */
@Module({
  imports: [ReportsModule],
  controllers: [
    ExportDownloadController,
    ExportsController,
    SavedFiltersController,
  ],
  providers: [ExportsService, ExportWorkerService, SavedFiltersService],
})
export class ExportsModule {}
