import { Module } from '@nestjs/common';
import { HardwareService } from './hardware.service';
import { HardwareController } from './hardware.controller';
import { JodaPrintService } from './jodaprint.service';

/** Receipt printers, cash drawers, scanners, customer display (spec §15) */
@Module({
  controllers: [HardwareController],
  providers: [HardwareService, JodaPrintService],
})
export class HardwareModule {}
