import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { TenantsService } from './tenants.service';
import { TenantsController } from './tenants.controller';

@Module({
  imports: [AuthModule, SettingsModule],
  controllers: [TenantsController],
  providers: [TenantsService],
})
export class TenantsModule {}
