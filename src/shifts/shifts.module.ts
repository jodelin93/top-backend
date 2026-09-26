import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Shift } from '../database/entities/shift.entity';
import { CashMovement } from '../database/entities/cash-movement.entity';
import { CashDenominationSet } from '../database/entities/cash-denomination-set.entity';
import { Drawer } from '../database/entities/drawer.entity';
import { ShiftCorrection } from '../database/entities/shift-correction.entity';
import { SettingsModule } from '../settings/settings.module';
import { ShiftsService } from './shifts.service';
import { ShiftsController } from './shifts.controller';
import { DrawersService } from './drawers.service';
import { DrawersController } from './drawers.controller';
import { ShiftEventsConsumer } from './shift-events.consumer';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Shift,
      CashMovement,
      CashDenominationSet,
      Drawer,
      ShiftCorrection,
    ]),
    SettingsModule,
  ],
  controllers: [ShiftsController, DrawersController],
  providers: [ShiftsService, DrawersService, ShiftEventsConsumer],
  exports: [ShiftsService],
})
export class ShiftsModule {}
