import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';

@Injectable()
export class JobsService {
  constructor(
    @InjectQueue('stock-recalculation') private stockRecalcQueue: Queue,
    @InjectQueue('low-stock-alerts') private lowStockQueue: Queue,
    @InjectQueue('reports') private reportsQueue: Queue,
    @InjectQueue('sync') private syncQueue: Queue,
  ) {}

  /**
   * Schedule stock level recalculation for a variant
   */
  async scheduleStockRecalculation(
    tenantId: string,
    variantId: string,
    locationId: string,
  ): Promise<void> {
    await this.stockRecalcQueue.add('recalculate', {
      tenantId,
      variantId,
      locationId,
    });
  }

  /**
   * Schedule low stock alert check for all variants
   */
  async scheduleLowStockCheck(
    tenantId: string,
    locationId?: string,
  ): Promise<void> {
    await this.lowStockQueue.add('check-low-stock', {
      tenantId,
      locationId,
    });
  }

  /**
   * Schedule report generation
   */
  async scheduleReportGeneration(
    tenantId: string,
    reportType: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.reportsQueue.add('generate-report', {
      tenantId,
      reportType,
      params,
    });
  }

  /**
   * Schedule offline data sync
   */
  async scheduleSyncJob(
    tenantId: string,
    deviceId: string,
    operations: any[],
  ): Promise<void> {
    await this.syncQueue.add('sync-operations', {
      tenantId,
      deviceId,
      operations,
    });
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(queueName: string): Promise<any> {
    let queue: Queue;

    switch (queueName) {
      case 'stock-recalculation':
        queue = this.stockRecalcQueue;
        break;
      case 'low-stock-alerts':
        queue = this.lowStockQueue;
        break;
      case 'reports':
        queue = this.reportsQueue;
        break;
      case 'sync':
        queue = this.syncQueue;
        break;
      default:
        throw new Error(`Unknown queue: ${queueName}`);
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + delayed,
    };
  }
}
