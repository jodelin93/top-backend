import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { canAccessLocation, locationFilterSql } from '../auth/branch-scope';
import { GoodsReceipt } from '../database/entities/goods-receipt.entity';
import {
  GoodsReceiptItem,
  ReceiptCondition,
} from '../database/entities/goods-receipt-item.entity';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { Supplier } from '../database/entities/supplier.entity';
import { SupplierReturn } from '../database/entities/supplier-return.entity';
import { SupplierReturnItem } from '../database/entities/supplier-return-item.entity';
import { SupplierCredit } from '../database/entities/supplier-credit.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { AuditService } from '../audit/audit.service';
import { InventoryService } from '../inventory/inventory.service';
import { SettingsService } from '../settings/settings.service';
import { nextDocumentNumber } from '../common/utils/sequence';
import { isoDate, planSupplierReturn } from './payables.logic';
import { assertUnitQuantities } from '../products/variant-units';
import { variantDisplayName } from './purchase-orders.service';
import {
  CreateSupplierReturnDto,
  SupplierDocumentsQueryDto,
} from './purchasing.dto';

/**
 * Supplier returns (spec §10): goods sent back from a receipt. Posts a stock
 * decrease at the receipt's location (damaged lines: the damaged / quarantine
 * location they were received into) and a supplier credit for their value.
 */
@Injectable()
export class SupplierReturnsService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private inventoryService: InventoryService,
    private settingsService: SettingsService,
  ) {}

  async list(tenantId: string, query: SupplierDocumentsQueryDto) {
    const qb = this.dataSource
      .getRepository(SupplierReturn)
      .createQueryBuilder('ret')
      .leftJoinAndSelect('ret.supplier', 'supplier')
      .leftJoinAndSelect('ret.receipt', 'receipt')
      .leftJoinAndSelect('ret.items', 'item')
      .where('ret.tenantId = :tenantId', { tenantId })
      .orderBy('ret.returnedAt', 'DESC')
      .take(200);
    if (query.supplierId) {
      qb.andWhere('ret.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    }
    // Branch-limited users: returns from their branches' locations (spec §9)
    const scope = locationFilterSql('"ret"."locationId"');
    if (scope) qb.andWhere(scope.sql, scope.params);
    return qb.getMany();
  }

  async get(tenantId: string, id: string) {
    const ret = await this.dataSource.getRepository(SupplierReturn).findOne({
      where: { tenantId, id },
      relations: { supplier: true, receipt: true, items: true },
    });
    if (
      !ret ||
      !(await canAccessLocation(
        this.dataSource.manager,
        tenantId,
        ret.locationId,
      ))
    ) {
      throw new NotFoundException('Supplier return not found');
    }
    const variants = await this.dataSource.getRepository(ProductVariant).find({
      where: { tenantId, id: In(ret.items.map((i) => i.variantId)) },
      relations: { product: true },
    });
    const byId = new Map(variants.map((v) => [v.id, v]));
    const credit = await this.dataSource
      .getRepository(SupplierCredit)
      .findOne({ where: { tenantId, returnId: id } });
    return {
      ...ret,
      credit,
      items: ret.items.map((item) => {
        const v = byId.get(item.variantId);
        return {
          ...item,
          sku: v?.sku ?? '',
          productName: v ? variantDisplayName(v.product?.name, v.name) : '',
        };
      }),
    };
  }

  async create(tenantId: string, userId: string, dto: CreateSupplierReturnDto) {
    const { currencyCode: storeCurrency } =
      await this.settingsService.getSettings(tenantId);
    const id = await this.dataSource.transaction(async (manager) => {
      // Serialises returns of the same receipt (returnable quantities)
      const receipt = await manager.findOne(GoodsReceipt, {
        where: { tenantId, id: dto.receiptId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !receipt ||
        !(await canAccessLocation(manager, tenantId, receipt.locationId))
      ) {
        throw new NotFoundException('Goods receipt not found');
      }
      const lines = await manager.find(GoodsReceiptItem, {
        where: { tenantId, receiptId: receipt.id },
      });
      const variantOf = new Map(lines.map((l) => [l.id, l.variantId]));
      await assertUnitQuantities(
        manager,
        tenantId,
        dto.items.flatMap((r) => {
          const variantId = variantOf.get(r.receiptItemId);
          return variantId ? [{ variantId, quantity: r.quantity }] : [];
        }),
        { allowZero: true },
      );
      const plan = planSupplierReturn(
        lines.map((l) => ({
          id: l.id,
          variantId: l.variantId,
          quantity: l.quantity,
          accepted: l.accepted,
          quantityReturned: l.quantityReturned,
          unitCost: Number(l.unitCost),
        })),
        dto.items,
      );
      if ('error' in plan) throw new BadRequestException(plan.error);

      const supplier = await manager.findOneOrFail(Supplier, {
        where: { tenantId, id: receipt.supplierId },
      });
      const po = receipt.purchaseOrderId
        ? await manager.findOne(PurchaseOrder, {
            where: { tenantId, id: receipt.purchaseOrderId },
          })
        : null;
      const currencyCode =
        po?.currencyCode ?? supplier.currencyCode ?? storeCurrency;

      const returnNumber = await nextDocumentNumber(manager, {
        table: 'supplier_returns',
        column: 'returnNumber',
        tenantId,
        prefix: 'SR',
      });
      const ret = await manager.save(
        manager.create(SupplierReturn, {
          tenantId,
          returnNumber,
          supplierId: supplier.id,
          receiptId: receipt.id,
          locationId: receipt.locationId,
          reason: dto.reason,
          reference: dto.reference ?? null,
          totalAmount: plan.total,
          currencyCode,
          userId,
        }),
      );
      // Accepted damaged units were received into the damaged / quarantine location
      const damagedIds = new Set(
        lines
          .filter((l) => l.condition === ReceiptCondition.DAMAGED)
          .map((l) => l.id),
      );
      const damagedLocationId = plan.lines.some((l) =>
        damagedIds.has(l.line.id),
      )
        ? await this.inventoryService.resolveConditionLocation(
            manager,
            tenantId,
            receipt.locationId,
            'damaged',
          )
        : receipt.locationId;
      for (const line of plan.lines) {
        await this.inventoryService.applyMovement(manager, {
          tenantId,
          userId,
          variantId: line.line.variantId,
          locationId: damagedIds.has(line.line.id)
            ? damagedLocationId
            : receipt.locationId,
          delta: -line.quantity,
          // Outbound "return": goods going back to the supplier
          movementType: MovementType.RETURN,
          referenceType: 'supplier_return',
          referenceId: ret.id,
          referenceNumber: returnNumber,
          notes:
            `${receipt.receiptNumber} → ${supplier.code}: ${dto.reason}`.slice(
              0,
              500,
            ),
          preventNegative: true,
        });
        await manager.insert(SupplierReturnItem, {
          tenantId,
          returnId: ret.id,
          receiptItemId: line.line.id,
          variantId: line.line.variantId,
          quantity: line.quantity,
          unitCost: line.line.unitCost,
          total: line.total,
        });
        await manager.increment(
          GoodsReceiptItem,
          { id: line.line.id, tenantId },
          'quantityReturned',
          line.quantity,
        );
      }

      const creditNumber = await nextDocumentNumber(manager, {
        table: 'supplier_credits',
        column: 'creditNumber',
        tenantId,
        prefix: 'SC',
      });
      const credit = await manager.save(
        manager.create(SupplierCredit, {
          tenantId,
          creditNumber,
          supplierId: supplier.id,
          creditType: 'return',
          returnId: ret.id,
          creditDate: isoDate(new Date()),
          amount: plan.total,
          currencyCode,
          reference: dto.reference ?? null,
          reason: `${returnNumber}: ${dto.reason}`.slice(0, 500),
          status: 'open',
          userId,
        }),
      );

      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_return.created',
          entityType: 'supplier_return',
          entityId: ret.id,
          reason: dto.reason,
          metadata: {
            returnNumber,
            receiptNumber: receipt.receiptNumber,
            supplierId: supplier.id,
            total: plan.total,
            creditId: credit.id,
            creditNumber,
            lines: plan.lines.map((l) => ({
              receiptItemId: l.line.id,
              variantId: l.line.variantId,
              quantity: l.quantity,
              unitCost: l.line.unitCost,
            })),
          },
        },
        manager,
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_credit.created',
          entityType: 'supplier_credit',
          entityId: credit.id,
          metadata: {
            creditNumber,
            supplierId: supplier.id,
            amount: plan.total,
            creditType: 'return',
            returnId: ret.id,
          },
        },
        manager,
      );
      return ret.id;
    });
    return this.get(tenantId, id);
  }
}
