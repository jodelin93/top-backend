import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Supplier } from '../database/entities/supplier.entity';
import { SettingsModule } from '../settings/settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { SuppliersService } from './suppliers.service';
import { SuppliersController } from './suppliers.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { GoodsReceiptsController } from './goods-receipts.controller';
import { SupplierReturnsService } from './supplier-returns.service';
import { SupplierReturnsController } from './supplier-returns.controller';
import { SupplierInvoicesService } from './supplier-invoices.service';
import { PayablesService } from './payables.service';
import { PayablesController } from './payables.controller';
import { ReorderService } from './reorder.service';
import { ReorderController } from './reorder.controller';

/**
 * Suppliers, purchase orders and goods receipts (R070–R073); supplier returns,
 * invoices, credits, payments, aging and reorder suggestions (spec §10)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Supplier]),
    SettingsModule,
    InventoryModule,
  ],
  controllers: [
    SuppliersController,
    PurchaseOrdersController,
    GoodsReceiptsController,
    SupplierReturnsController,
    PayablesController,
    ReorderController,
  ],
  providers: [
    SuppliersService,
    PurchaseOrdersService,
    SupplierReturnsService,
    SupplierInvoicesService,
    PayablesService,
    ReorderService,
  ],
  exports: [PurchaseOrdersService],
})
export class PurchasingModule {}
