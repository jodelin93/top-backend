import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Expense } from '../database/entities/expense.entity';
import { ExpenseCategory } from '../database/entities/expense-category.entity';
import { SettingsModule } from '../settings/settings.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { ExpenseCategoriesService, ExpensesService } from './expenses.service';
import {
  ExpenseCategoriesController,
  ExpensesController,
} from './expenses.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Expense, ExpenseCategory]),
    SettingsModule,
    ShiftsModule,
  ],
  controllers: [ExpenseCategoriesController, ExpensesController],
  providers: [ExpenseCategoriesService, ExpensesService],
  exports: [ExpensesService],
})
export class ExpensesModule {}
