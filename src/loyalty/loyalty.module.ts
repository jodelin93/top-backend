import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LoyaltyTransaction } from '../database/entities/loyalty-transaction.entity';
import { SettingsModule } from '../settings/settings.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyController } from './loyalty.controller';

// Global: sales, returns and customers all move points
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([LoyaltyTransaction]), SettingsModule],
  controllers: [LoyaltyController],
  providers: [LoyaltyService],
  exports: [LoyaltyService],
})
export class LoyaltyModule {}
