import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Device } from './device.entity';
import { DevicesService } from './devices.service';
import { DevicesController } from './devices.controller';
import { SettingsModule } from '../settings/settings.module';
import { LostDeviceInterceptor } from './lost-device.interceptor';

@Module({
  imports: [TypeOrmModule.forFeature([Device]), SettingsModule],
  controllers: [DevicesController],
  providers: [
    DevicesService,
    // Every request from a till marked lost is refused (DEVICE_LOST)
    { provide: APP_INTERCEPTOR, useClass: LostDeviceInterceptor },
  ],
  exports: [DevicesService],
})
export class DevicesModule {}
