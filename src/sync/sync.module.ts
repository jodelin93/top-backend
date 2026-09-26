import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SettingsModule } from '../settings/settings.module';
import { SalesModule } from '../sales/sales.module';
import { SyncService } from './sync.service';
import { SyncPushService } from './sync-push.service';
import { SyncLogPruneService } from './sync-log-prune.service';
import { SyncController } from './sync.controller';
import { SyncOperation } from './sync-operation.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([SyncOperation]),
    SettingsModule,
    SalesModule,
  ],
  controllers: [SyncController],
  providers: [SyncService, SyncPushService, SyncLogPruneService],
})
export class SyncModule {}
