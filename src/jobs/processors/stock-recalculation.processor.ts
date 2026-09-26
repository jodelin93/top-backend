import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import type { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { StockLevel } from '../../database/entities/stock-level.entity';

interface RecalculationJobData {
  tenantId: string;
  variantId: string;
  locationId: string;
}

@Processor('stock-recalculation')
export class StockRecalculationProcessor {
  private readonly logger = new Logger(StockRecalculationProcessor.name);

  constructor(
    @InjectRepository(StockLevel)
    private stockLevelRepository: Repository<StockLevel>,
  ) {}

  @Process('recalculate')
  async handleRecalculation(job: Job<RecalculationJobData>) {
    const { tenantId, variantId, locationId } = job.data;

    this.logger.log(
      `Recalculating stock for variant ${variantId} at location ${locationId}`,
    );

    try {
      const stockLevel = await this.stockLevelRepository.findOne({
        where: { tenantId, variantId, locationId },
      });

      if (!stockLevel) {
        this.logger.warn(
          `Stock level not found for ${variantId} at ${locationId}`,
        );
        return;
      }

      // Recalculate available quantity
      stockLevel.quantityAvailable =
        stockLevel.quantityOnHand - stockLevel.quantityReserved;

      await this.stockLevelRepository.save(stockLevel);

      this.logger.log(
        `Stock recalculated: ${stockLevel.quantityAvailable} available`,
      );

      return {
        success: true,
        quantityAvailable: stockLevel.quantityAvailable,
      };
    } catch (error) {
      this.logger.error(
        `Error recalculating stock: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }
}
