import { Module } from '@nestjs/common';
import { HardwareService } from './hardware.service';
import { HardwareController } from './hardware.controller';

/** Receipt printers, cash drawers, scanners, customer display (spec §15) */
@Module({
  controllers: [HardwareController],
  providers: [HardwareService],
})
export class HardwareModule {}
