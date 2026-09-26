import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockLevel } from '../database/entities/stock-level.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { StockRecalculationProcessor } from './processors/stock-recalculation.processor';
import { LowStockAlertProcessor } from './processors/low-stock-alert.processor';
import { JobsService } from './jobs.service';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        redis: {
          host: configService.get('REDIS_HOST') || 'localhost',
          port: configService.get('REDIS_PORT') || 6379,
          password: configService.get('REDIS_PASSWORD'),
          db: configService.get('QUEUE_REDIS_DB') || 1,
        },
        defaultJobOptions: {
          removeOnComplete: 100, // Keep last 100 completed jobs
          removeOnFail: 1000, // Keep last 1000 failed jobs
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      }),
      inject: [ConfigService],
    }),
    BullModule.registerQueue(
      { name: 'stock-recalculation' },
      { name: 'low-stock-alerts' },
      { name: 'reports' },
      { name: 'sync' },
    ),
    TypeOrmModule.forFeature([StockLevel, ProductVariant]),
  ],
  // The "domain-events" queue (outbox copy) is registered by PlatformModule
  providers: [JobsService, StockRecalculationProcessor, LowStockAlertProcessor],
  exports: [JobsService, BullModule],
})
export class JobsModule {}
