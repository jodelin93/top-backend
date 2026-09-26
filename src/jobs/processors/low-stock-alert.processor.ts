import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { NotificationGeneratorsService } from '../../notifications/notification-generators.service';

interface LowStockJobData {
  tenantId: string;
  locationId?: string;
}

/**
 * Low stock check queued with JobsService.scheduleLowStockCheck(). Raises one
 * de-duplicated in-app notification (and e-mail for those who opted in) per
 * location with items at or below their minimum, and clears it once restocked.
 * The same check also runs on a timer without Redis (NotificationGeneratorsService).
 */
@Processor('low-stock-alerts')
export class LowStockAlertProcessor {
  private readonly logger = new Logger(LowStockAlertProcessor.name);

  constructor(private generators: NotificationGeneratorsService) {}

  @Process('check-low-stock')
  async handleLowStockCheck(job: Job<LowStockJobData>) {
    const { tenantId, locationId } = job.data;

    this.logger.log(
      `Checking for low stock items${locationId ? ` at location ${locationId}` : ''}`,
    );

    try {
      const alerts = await this.generators.checkLowStock(tenantId, locationId);
      this.logger.log(`Found ${alerts.length} low stock items`);
      return {
        success: true,
        alertCount: alerts.length,
        alerts,
      };
    } catch (error) {
      this.logger.error(
        `Error checking low stock: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
