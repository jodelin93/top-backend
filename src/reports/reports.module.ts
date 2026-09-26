import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { ReportRunnerService } from './report-runner.service';
import { ReconciliationReportService } from './reconciliation.service';
import { DailySummaryService } from './daily-summary.service';

@Module({
  imports: [SettingsModule],
  controllers: [ReportsController],
  providers: [
    ReportsService,
    ReportRunnerService,
    ReconciliationReportService,
    DailySummaryService,
  ],
  exports: [ReportRunnerService],
})
export class ReportsModule {}
