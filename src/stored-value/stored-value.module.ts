import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StoredValueAccount } from '../database/entities/stored-value-account.entity';
import { StoredValueEntry } from '../database/entities/stored-value-entry.entity';
import { SettingsModule } from '../settings/settings.module';
import { StoredValueService } from './stored-value.service';
import { GiftCardExpiryService } from './gift-card-expiry.service';
import { StoredValueController } from './stored-value.controller';

/** Gift cards and store credit: sales redeem / sell them, returns refund to them */
@Module({
  imports: [
    TypeOrmModule.forFeature([StoredValueAccount, StoredValueEntry]),
    SettingsModule,
  ],
  controllers: [StoredValueController],
  providers: [StoredValueService, GiftCardExpiryService],
  exports: [StoredValueService],
})
export class StoredValueModule {}
