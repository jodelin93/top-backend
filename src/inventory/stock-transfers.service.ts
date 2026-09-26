import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { addQty } from '../common/utils/quantity';
import { assertUnitQuantities } from '../products/variant-units';
import {
  canAccessLocation,
  hasAllBranches,
  locationFilterSql,
} from '../auth/branch-scope';
import {
  StockTransfer,
  StockTransferStatus,
} from '../database/entities/stock-transfer.entity';
import { StockTransferItem } from '../database/entities/stock-transfer-item.entity';
import {
  StockTransferEvent,
  StockTransferEventKind,
} from '../database/entities/stock-transfer-event.entity';
import {
  InventoryLocation,
  LocationStockStatus,
} from '../database/entities/inventory-location.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import {
  MovementType,
  StockMovement,
} from '../database/entities/stock-movement.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { nextDocumentNumber } from '../common/utils/sequence';
import { requestContext } from '../common/context/request-context';
import { OutboxService } from '../platform/outbox/outbox.service';
import { InventoryService } from './inventory.service';
import { eventKey } from './stock-rules';
import {
  dispatchedUnitCost,
  isTransferLineBalanced,
  outstandingInTransit,
  planDispatch,
  planReceipt,
  planReturn,
  planWriteOff,
  TransferAction,
  transferNeedsApproval,
  transferStatus,
  transferTransitionError,
  writeOffReasonError,
} from './transfer.logic';
import {
  SaveTransferDto,
  TransferDispatchDto,
  TransferQuantitiesDto,
  TransferReceiveDto,
  TransfersQueryDto,
} from './inventory.dto';

const REFERENCE = 'stock_transfer';

/**
 * Stock transfers between locations (R067):
 * draft → requested → approved (inventory.transfer.approve, when the store's
 * setting asks for it) → dispatched in one or more goes → received (good,
 * damaged, missing reported), with write-offs for units that never arrive and
 * a return to the source when cancelled after dispatch.
 *
 * Ledger: each dispatch moves units source → the store's transit location and
 * each receipt transit → destination (damaged → its quarantine location), so
 * for every line: dispatched = received + damaged + written off + returned +
 * in transit, provable from stock_movements. stock_levels.quantityInTransit at
 * the destination follows the same numbers for display.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private dataSource: DataSource,
    private inventoryService: InventoryService,
    private auditService: AuditService,
    private settingsService: SettingsService,
    // Domain events (transfer.dispatched/received); optional for unit tests
    @Optional() private outbox?: OutboxService,
  ) {}

  async list(tenantId: string, query: TransfersQueryDto) {
    const qb = this.dataSource
      .getRepository(StockTransfer)
      .createQueryBuilder('transfer')
      .leftJoinAndSelect('transfer.fromLocation', 'fromLocation')
      .leftJoinAndSelect('transfer.toLocation', 'toLocation')
      .leftJoinAndSelect('transfer.items', 'item')
      .where('transfer.tenantId = :tenantId', { tenantId })
      .orderBy('transfer.created_at', 'DESC')
      .take(200);
    if (query.status) {
      qb.andWhere('transfer.status = :status', { status: query.status });
    }
    if (query.locationId) {
      qb.andWhere(
        '(transfer.fromLocationId = :locationId OR transfer.toLocationId = :locationId)',
        { locationId: query.locationId },
      );
    }
    // Branch-limited users: transfers from or to their branches' locations (spec §9)
    const from = locationFilterSql('"transfer"."fromLocationId"');
    const to = locationFilterSql('"transfer"."toLocationId"');
    if (from && to) qb.andWhere(`(${from.sql} OR ${to.sql})`, from.params);
    return qb.getMany();
  }

  async get(tenantId: string, id: string) {
    const transfer = await this.dataSource
      .getRepository(StockTransfer)
      .createQueryBuilder('transfer')
      .leftJoinAndSelect('transfer.fromLocation', 'fromLocation')
      .leftJoinAndSelect('transfer.toLocation', 'toLocation')
      .leftJoinAndSelect('transfer.items', 'item')
      .leftJoinAndSelect('item.variant', 'variant')
      .leftJoinAndSelect('variant.product', 'product')
      .where('transfer.tenantId = :tenantId AND transfer.id = :id', {
        tenantId,
        id,
      })
      .orderBy('variant.sku', 'ASC')
      .getOne();
    if (!transfer) throw new NotFoundException('Transfer not found');
    await this.assertTransferAccess(this.dataSource.manager, transfer, 'view');
    const events = await this.dataSource
      .getRepository(StockTransferEvent)
      .find({
        where: { tenantId, transferId: id },
        order: { createdAt: 'ASC' },
      });
    return {
      ...transfer,
      items: transfer.items.map((item) => ({
        ...item,
        quantityInTransit: outstandingInTransit(item),
      })),
      events,
    };
  }

  async create(tenantId: string, userId: string, dto: SaveTransferDto) {
    await this.validateInput(tenantId, dto);
    const id = await this.dataSource.transaction(async (manager) => {
      const transferNumber = await nextDocumentNumber(manager, {
        table: 'stock_transfers',
        column: 'transferNumber',
        tenantId,
        prefix: 'TRF',
      });
      const transfer = await manager.save(
        manager.create(StockTransfer, {
          tenantId,
          transferNumber,
          fromLocationId: dto.fromLocationId,
          toLocationId: dto.toLocationId,
          notes: dto.notes ?? null,
          createdById: userId,
          status: StockTransferStatus.DRAFT,
        }),
      );
      await this.insertItems(manager, transfer, dto);
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.transfer_created',
          entityType: 'stock_transfer',
          entityId: transfer.id,
          metadata: {
            transferNumber,
            fromLocationId: dto.fromLocationId,
            toLocationId: dto.toLocationId,
            items: dto.items,
          },
        },
        manager,
      );
      return transfer.id;
    });
    return this.get(tenantId, id);
  }

  async update(tenantId: string, id: string, dto: SaveTransferDto) {
    await this.validateInput(tenantId, dto);
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(manager, tenantId, id, 'edit');
      transfer.fromLocationId = dto.fromLocationId;
      transfer.toLocationId = dto.toLocationId;
      transfer.notes = dto.notes ?? null;
      await manager.save(transfer);
      await manager.delete(StockTransferItem, { tenantId, transferId: id });
      await this.insertItems(manager, transfer, dto);
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.transfer_updated',
          entityType: 'stock_transfer',
          entityId: id,
          metadata: {
            transferNumber: transfer.transferNumber,
            items: dto.items,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Submit a draft: approved at once unless the store's approval setting
   * (never / above a value / always) asks for inventory.transfer.approve
   */
  async request(tenantId: string, id: string, userId: string) {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(
        manager,
        tenantId,
        id,
        'request',
      );
      const items = await this.items(manager, tenantId, id);
      const { required, value } = await this.approvalNeed(
        manager,
        tenantId,
        items,
      );
      transfer.approvalRequired = required;
      transfer.requestedById = userId;
      transfer.requestedAt = new Date();
      if (required) {
        transfer.status = StockTransferStatus.REQUESTED;
      } else {
        transfer.status = StockTransferStatus.APPROVED;
        transfer.approvedAt = new Date();
      }
      await manager.save(transfer);
      await this.audit(manager, transfer, 'inventory.transfer_requested', {
        approvalRequired: required,
        value,
      });
    });
    return this.get(tenantId, id);
  }

  /**
   * Approve a requested transfer; the approver must differ from the requester
   * (checked by the controller)
   */
  async approve(tenantId: string, id: string, approverId: string) {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(
        manager,
        tenantId,
        id,
        'approve',
      );
      if (approverId === transfer.requestedById) {
        throw new BadRequestException(
          'A transfer must be approved by someone other than the requester',
        );
      }
      transfer.status = StockTransferStatus.APPROVED;
      transfer.approvedById = approverId;
      transfer.approvedAt = new Date();
      await manager.save(transfer);
      await this.audit(manager, transfer, 'inventory.transfer_approved', {
        approverId,
      });
    });
    return this.get(tenantId, id);
  }

  /** Send a requested transfer back to draft */
  async reject(tenantId: string, id: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(manager, tenantId, id, 'reject');
      transfer.status = StockTransferStatus.DRAFT;
      transfer.requestedAt = null;
      transfer.requestedById = null;
      await manager.save(transfer);
      await this.audit(
        manager,
        transfer,
        'inventory.transfer_rejected',
        {},
        reason,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Units leave the source for the transit location (costed TRANSFER
   * movements). Repeatable until everything requested is sent or `complete`.
   * D018: refused when the source doesn't have them available.
   */
  async dispatch(
    tenantId: string,
    id: string,
    userId: string,
    dto: TransferDispatchDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(
        manager,
        tenantId,
        id,
        'dispatch',
      );
      const event = await this.startEvent(
        manager,
        transfer,
        StockTransferEventKind.DISPATCH,
        userId,
        dto,
      );
      if (!event) return; // Retry of a dispatch that already went through

      const items = await this.items(manager, tenantId, id);
      if (transfer.status === StockTransferStatus.DRAFT) {
        const { required } = await this.approvalNeed(manager, tenantId, items);
        if (required) {
          throw new BadRequestException(
            'This transfer needs approval: submit it for approval first',
          );
        }
        transfer.requestedById = userId;
        transfer.requestedAt = new Date();
        transfer.approvedAt = new Date();
      }
      await this.assertLineUnits(manager, tenantId, items, dto.items);
      const plan = planDispatch(items, dto.items);
      if ('error' in plan) throw new BadRequestException(plan.error);

      const transitId =
        transfer.transitLocationId ??
        (await this.inventoryService.transitLocationId(manager, tenantId));
      transfer.transitLocationId = transitId;

      for (const { item, quantity } of plan.lines) {
        const moved = await this.inventoryService.moveBetween(manager, {
          tenantId,
          userId,
          variantId: item.variantId,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transitId,
          quantity,
          movementType: MovementType.TRANSFER,
          referenceType: REFERENCE,
          referenceId: transfer.id,
          referenceNumber: transfer.transferNumber,
          notes: dto.notes,
          sourceKey: eventKey(REFERENCE, transfer.id, event.id, item.id),
          metadata: { transferItemId: item.id, leg: 'dispatch' },
        });
        await this.inventoryService.adjustInTransit(manager, {
          tenantId,
          variantId: item.variantId,
          locationId: transfer.toLocationId,
          delta: quantity,
        });
        item.unitCost = dispatchedUnitCost(
          item.quantityDispatched,
          item.unitCost === null ? null : Number(item.unitCost),
          quantity,
          moved.out.unitCost,
        );
        item.quantityDispatched = addQty(item.quantityDispatched, quantity);
        await manager.update(
          StockTransferItem,
          { id: item.id, tenantId },
          {
            quantityDispatched: item.quantityDispatched,
            unitCost: item.unitCost,
          },
        );
      }
      if (dto.complete) transfer.dispatchComplete = true;
      transfer.status = transferStatus(items, {
        dispatchComplete: transfer.dispatchComplete,
      });
      transfer.dispatchedAt ??= new Date();
      transfer.dispatchedById = userId;
      await manager.save(transfer);
      await this.finishEvent(
        manager,
        event,
        plan.lines.map((l) => ({
          itemId: l.item.id,
          variantId: l.item.variantId,
          quantity: l.quantity,
        })),
      );
      await this.audit(manager, transfer, 'inventory.transfer_dispatched', {
        eventId: event.id,
        status: transfer.status,
        complete: transfer.dispatchComplete,
        lines: plan.lines.map((l) => ({
          variantId: l.item.variantId,
          quantity: l.quantity,
        })),
      });
      await this.outbox?.record(manager, {
        tenantId,
        type: 'transfer.dispatched',
        aggregateId: transfer.id,
        payload: {
          transferId: transfer.id,
          transferNumber: transfer.transferNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          lines: plan.lines.map((l) => ({
            variantId: l.item.variantId,
            quantity: l.quantity,
          })),
        },
      });
    });
    return this.get(tenantId, id);
  }

  /**
   * Units arrive at the destination: good ones at the destination location,
   * damaged ones at its warehouse's quarantine location (or written off when
   * there is none), missing ones reported and left in transit. Receiving more
   * than was sent is an over-receipt: within the store's tolerance it needs
   * nothing; above it `approverId` must be set (inventory.transfer.approve).
   */
  async receive(
    tenantId: string,
    id: string,
    userId: string,
    dto: TransferReceiveDto,
    approverId: string | null = null,
  ) {
    const { transferOverReceiptTolerancePercent: tolerance } =
      await this.settingsService.getSettings(tenantId);
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(
        manager,
        tenantId,
        id,
        'receive',
      );
      const event = await this.startEvent(
        manager,
        transfer,
        StockTransferEventKind.RECEIPT,
        userId,
        dto,
      );
      if (!event) return;

      const items = await this.items(manager, tenantId, id);
      await this.assertLineUnits(
        manager,
        tenantId,
        items,
        dto.items?.flatMap((l) => [
          { itemId: l.itemId, quantity: l.quantity },
          { itemId: l.itemId, quantity: l.damaged ?? 0 },
          { itemId: l.itemId, quantity: l.missing ?? 0 },
        ]),
      );
      const plan = planReceipt(items, dto.items, tolerance ?? 0);
      if ('error' in plan) throw new BadRequestException(plan.error);
      if (plan.needsApproval && !approverId) {
        throw new ForbiddenException({
          message: `Receiving more than was dispatched (over the ${tolerance ?? 0}% tolerance) needs approval`,
          error: 'Forbidden',
          missingPermissions: ['inventory.transfer.approve'],
          approvable: true,
        });
      }
      const quarantineId = await this.inventoryService.resolveConditionLocation(
        manager,
        tenantId,
        transfer.toLocationId,
        'damaged',
      );
      const hasQuarantine = quarantineId !== transfer.toLocationId;
      const transitId = transfer.transitLedger
        ? (transfer.transitLocationId ??
          (await this.inventoryService.transitLocationId(manager, tenantId)))
        : null;
      const common = {
        tenantId,
        userId,
        variantId: '',
        movementType: MovementType.TRANSFER,
        referenceType: REFERENCE,
        referenceId: transfer.id,
        referenceNumber: transfer.transferNumber,
        notes: dto.notes,
      };

      for (const line of plan.lines) {
        const { item } = line;
        const base = { ...common, variantId: item.variantId };
        const key = (leg: string) =>
          eventKey(REFERENCE, transfer.id, event.id, item.id, leg);
        const meta = (leg: string) => ({ transferItemId: item.id, leg });

        if (line.over > 0) {
          // The extra units left the source uncounted: dispatch them now
          if (transitId) {
            const moved = await this.inventoryService.moveBetween(manager, {
              ...base,
              fromLocationId: transfer.fromLocationId,
              toLocationId: transitId,
              quantity: line.over,
              sourceKey: key('over'),
              metadata: { ...meta('over_receipt'), approverId },
            });
            item.unitCost = dispatchedUnitCost(
              item.quantityDispatched,
              item.unitCost === null ? null : Number(item.unitCost),
              line.over,
              moved.out.unitCost,
            );
          } else {
            await this.inventoryService.applyMovement(manager, {
              ...base,
              locationId: transfer.fromLocationId,
              delta: -line.over,
              sourceKey: key('over'),
              metadata: { ...meta('over_receipt'), approverId },
            });
          }
          await this.inventoryService.adjustInTransit(manager, {
            tenantId,
            variantId: item.variantId,
            locationId: transfer.toLocationId,
            delta: line.over,
          });
          item.quantityDispatched = addQty(item.quantityDispatched, line.over);
          item.quantityOverReceived =
            (item.quantityOverReceived ?? 0) + line.over;
        }

        const cost = item.unitCost === null ? null : Number(item.unitCost);
        if (line.good > 0) {
          if (transitId) {
            await this.inventoryService.moveBetween(manager, {
              ...base,
              fromLocationId: transitId,
              toLocationId: transfer.toLocationId,
              quantity: line.good,
              sourceKey: key('good'),
              metadata: meta('receipt'),
            });
          } else {
            // Legacy transfer: arrives at the cost it left the source with
            await this.inventoryService.applyMovement(manager, {
              ...base,
              locationId: transfer.toLocationId,
              delta: line.good,
              cost,
              sourceKey: key('good'),
              metadata: meta('receipt'),
            });
          }
        }
        if (line.damaged > 0) {
          if (hasQuarantine) {
            if (transitId) {
              await this.inventoryService.moveBetween(manager, {
                ...base,
                fromLocationId: transitId,
                toLocationId: quarantineId,
                quantity: line.damaged,
                sourceKey: key('damaged'),
                metadata: { ...meta('receipt'), condition: 'damaged' },
              });
            } else {
              await this.inventoryService.applyMovement(manager, {
                ...base,
                locationId: quarantineId,
                delta: line.damaged,
                cost,
                sourceKey: key('damaged'),
                metadata: { ...meta('receipt'), condition: 'damaged' },
              });
            }
          } else if (transitId) {
            // Nowhere to hold damaged goods: they are a loss out of transit
            await this.inventoryService.applyMovement(manager, {
              ...base,
              locationId: transitId,
              delta: -line.damaged,
              movementType: MovementType.DAMAGE,
              sourceKey: key('damaged'),
              metadata: { ...meta('receipt'), condition: 'damaged' },
            });
          } else {
            await this.postLegacyLoss(manager, transfer, item, line.damaged, {
              userId,
              notes: dto.notes ?? 'Arrived damaged',
              movementType: MovementType.DAMAGE,
              kind: 'transfer_damaged',
            });
          }
        }
        const arrived = line.good + line.damaged;
        if (arrived > 0) {
          await this.inventoryService.adjustInTransit(manager, {
            tenantId,
            variantId: item.variantId,
            locationId: transfer.toLocationId,
            delta: -arrived,
          });
        }
        item.quantityReceived = addQty(item.quantityReceived, line.good);
        item.quantityDamaged = (item.quantityDamaged ?? 0) + line.damaged;
        item.quantityMissing = Math.min(
          (item.quantityMissing ?? 0) + line.missing,
          outstandingInTransit(item),
        );
        if (!isTransferLineBalanced(item)) {
          throw new BadRequestException(
            'The receipt would leave a transfer line out of balance',
          );
        }
        await manager.update(
          StockTransferItem,
          { id: item.id, tenantId },
          {
            quantityDispatched: item.quantityDispatched,
            quantityReceived: item.quantityReceived,
            quantityDamaged: item.quantityDamaged,
            quantityMissing: item.quantityMissing,
            quantityOverReceived: item.quantityOverReceived,
            unitCost: item.unitCost,
          },
        );
      }
      transfer.status = transferStatus(items, {
        dispatchComplete: transfer.dispatchComplete,
      });
      if (transfer.status === StockTransferStatus.RECEIVED) {
        transfer.receivedAt = new Date();
      }
      await manager.save(transfer);
      const lines = plan.lines.map((l) => ({
        itemId: l.item.id,
        variantId: l.item.variantId,
        quantity: l.good,
        damaged: l.damaged,
        missing: l.missing,
        over: l.over,
      }));
      await this.finishEvent(manager, event, lines, approverId);
      await this.audit(manager, transfer, 'inventory.transfer_received', {
        eventId: event.id,
        status: transfer.status,
        approverId,
        quarantineLocationId: hasQuarantine ? quarantineId : null,
        lines,
      });
      await this.outbox?.record(manager, {
        tenantId,
        type: 'transfer.received',
        aggregateId: transfer.id,
        payload: {
          transferId: transfer.id,
          transferNumber: transfer.transferNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          status: transfer.status,
          lines: lines.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
          })),
        },
      });
    });
    return this.get(tenantId, id);
  }

  /**
   * Units that left the source but will never arrive (lost, damaged in transit).
   * Needs a reason; the controller requires inventory.adjust (or a manager's
   * approval) on top of inventory.transfer. Posts a loss movement out of the
   * transit location referencing the transfer (legacy transfers without transit
   * ledger: a location-less loss movement, as the units already left on-hand).
   */
  async writeOff(
    tenantId: string,
    id: string,
    userId: string,
    dto: TransferQuantitiesDto & { reason: string },
  ) {
    const reasonError = writeOffReasonError(dto.reason);
    if (reasonError) throw new BadRequestException(reasonError);
    const reason = dto.reason.trim();
    const approverId = requestContext.get()?.approverId ?? null;

    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(
        manager,
        tenantId,
        id,
        'writeOff',
      );
      const event = await this.startEvent(
        manager,
        transfer,
        StockTransferEventKind.WRITE_OFF,
        userId,
        dto,
      );
      if (!event) return;
      const items = await this.items(manager, tenantId, id);
      await this.assertLineUnits(manager, tenantId, items, dto.items);
      const plan = planWriteOff(items, dto.items);
      if ('error' in plan) throw new BadRequestException(plan.error);

      for (const { item, quantity } of plan.lines) {
        await this.inventoryService.adjustInTransit(manager, {
          tenantId,
          variantId: item.variantId,
          locationId: transfer.toLocationId,
          delta: -quantity,
        });
        item.quantityWrittenOff = addQty(item.quantityWrittenOff, quantity);
        // shipped = received + damaged + written off + returned + in transit
        if (!isTransferLineBalanced(item)) {
          throw new BadRequestException(
            'The write-off would leave a transfer line out of balance',
          );
        }
        item.quantityMissing = Math.min(
          item.quantityMissing ?? 0,
          outstandingInTransit(item),
        );
        await manager.update(
          StockTransferItem,
          { id: item.id, tenantId },
          {
            quantityWrittenOff: item.quantityWrittenOff,
            quantityMissing: item.quantityMissing,
          },
        );
        const metadata = {
          kind: 'transfer_write_off',
          inTransit: true,
          transferItemId: item.id,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          approverId,
        };
        if (transfer.transitLedger) {
          await this.inventoryService.applyMovement(manager, {
            tenantId,
            userId,
            variantId: item.variantId,
            locationId:
              transfer.transitLocationId ??
              (await this.inventoryService.transitLocationId(
                manager,
                tenantId,
              )),
            delta: -quantity,
            movementType: MovementType.ADJUSTMENT,
            referenceType: REFERENCE,
            referenceId: transfer.id,
            referenceNumber: transfer.transferNumber,
            notes: reason.slice(0, 500),
            sourceKey: eventKey(REFERENCE, transfer.id, event.id, item.id),
            metadata,
          });
        } else {
          await this.postLegacyLoss(manager, transfer, item, quantity, {
            userId,
            notes: reason,
            movementType: MovementType.ADJUSTMENT,
            kind: 'transfer_write_off',
            metadata,
          });
        }
      }
      transfer.status = transferStatus(items, {
        dispatchComplete: transfer.dispatchComplete,
      });
      if (transfer.status === StockTransferStatus.RECEIVED) {
        transfer.receivedAt = new Date();
      }
      await manager.save(transfer);
      await this.finishEvent(
        manager,
        event,
        plan.lines.map((l) => ({
          itemId: l.item.id,
          variantId: l.item.variantId,
          quantity: l.quantity,
        })),
        approverId,
      );
      await this.audit(
        manager,
        transfer,
        'inventory.transfer_written_off',
        {
          eventId: event.id,
          status: transfer.status,
          notes: dto.notes ?? null,
          lines: plan.lines.map((l) => ({
            variantId: l.item.variantId,
            quantity: l.quantity,
            unitCost: l.item.unitCost,
            dispatched: l.item.quantityDispatched,
            received: l.item.quantityReceived,
            writtenOff: l.item.quantityWrittenOff,
          })),
        },
        reason,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Cancel. Before dispatch it is simply dropped; after dispatch whatever is
   * still in transit goes back to the source (movements, not erasure) and
   * what was already received stays at the destination.
   */
  async cancel(tenantId: string, id: string, userId: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const transfer = await this.lockTransfer(manager, tenantId, id, 'cancel');
      const items = await this.items(manager, tenantId, id);
      const returns = planReturn(items);
      let eventId: string | null = null;
      if (returns.length > 0) {
        const event = await this.startEvent(
          manager,
          transfer,
          StockTransferEventKind.RETURN,
          userId,
          { notes: reason },
        );
        eventId = event!.id;
        for (const { item, quantity } of returns) {
          const base = {
            tenantId,
            userId,
            variantId: item.variantId,
            movementType: MovementType.TRANSFER,
            referenceType: REFERENCE,
            referenceId: transfer.id,
            referenceNumber: transfer.transferNumber,
            notes: reason,
            sourceKey: eventKey(REFERENCE, transfer.id, event!.id, item.id),
            metadata: { transferItemId: item.id, leg: 'return' },
          };
          if (transfer.transitLedger) {
            await this.inventoryService.moveBetween(manager, {
              ...base,
              fromLocationId:
                transfer.transitLocationId ??
                (await this.inventoryService.transitLocationId(
                  manager,
                  tenantId,
                )),
              toLocationId: transfer.fromLocationId,
              quantity,
            });
          } else {
            await this.inventoryService.applyMovement(manager, {
              ...base,
              locationId: transfer.fromLocationId,
              delta: quantity,
              cost: item.unitCost === null ? null : Number(item.unitCost),
            });
          }
          await this.inventoryService.adjustInTransit(manager, {
            tenantId,
            variantId: item.variantId,
            locationId: transfer.toLocationId,
            delta: -quantity,
          });
          item.quantityReturned = addQty(item.quantityReturned ?? 0, quantity);
          item.quantityMissing = 0;
          await manager.update(
            StockTransferItem,
            { id: item.id, tenantId },
            { quantityReturned: item.quantityReturned, quantityMissing: 0 },
          );
        }
        await this.finishEvent(
          manager,
          event!,
          returns.map((l) => ({
            itemId: l.item.id,
            variantId: l.item.variantId,
            quantity: l.quantity,
          })),
        );
      }
      transfer.status = StockTransferStatus.CANCELLED;
      transfer.cancelledAt = new Date();
      transfer.dispatchComplete = true;
      await manager.save(transfer);
      await this.audit(
        manager,
        transfer,
        'inventory.transfer_cancelled',
        {
          eventId,
          returnedToSource: returns.map((l) => ({
            variantId: l.item.variantId,
            quantity: l.quantity,
          })),
        },
        reason,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Record the event, or return null when this idempotency key was already
   * used for the same kind of event on the transfer (a retry)
   */
  private async startEvent(
    manager: EntityManager,
    transfer: StockTransfer,
    kind: StockTransferEventKind,
    userId: string,
    dto: { idempotencyKey?: string; notes?: string | null },
  ): Promise<StockTransferEvent | null> {
    const idempotencyKey = dto.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const existing = await manager.findOne(StockTransferEvent, {
        where: {
          tenantId: transfer.tenantId,
          transferId: transfer.id,
          kind,
          idempotencyKey,
        },
      });
      if (existing) return null;
    }
    return manager.save(
      manager.create(StockTransferEvent, {
        tenantId: transfer.tenantId,
        transferId: transfer.id,
        kind,
        idempotencyKey,
        userId,
        notes: dto.notes?.slice(0, 500) ?? null,
        lines: [],
      }),
    );
  }

  private async finishEvent(
    manager: EntityManager,
    event: StockTransferEvent,
    lines: Record<string, unknown>[],
    approverId: string | null = null,
  ) {
    event.lines = lines;
    event.approverId = approverId;
    await manager.save(event);
  }

  /**
   * Legacy transfers (dispatched before the transit location): a loss is a
   * location-less movement, since the units already left on-hand at dispatch
   */
  private async postLegacyLoss(
    manager: EntityManager,
    transfer: StockTransfer,
    item: StockTransferItem,
    quantity: number,
    options: {
      userId: string;
      notes: string;
      movementType: MovementType;
      kind: string;
      metadata?: Record<string, unknown>;
    },
  ) {
    await manager.save(
      manager.create(StockMovement, {
        tenantId: transfer.tenantId,
        variantId: item.variantId,
        movementType: options.movementType,
        quantity,
        referenceType: REFERENCE,
        referenceId: transfer.id,
        referenceNumber: transfer.transferNumber,
        cost: item.unitCost ?? undefined,
        userId: options.userId,
        notes: options.notes.slice(0, 500),
        metadata: {
          kind: options.kind,
          inTransit: true,
          transferItemId: item.id,
          ...(options.metadata ?? {}),
        },
      }),
    );
  }

  /**
   * Value of the requested quantities at cost, and whether the store's
   * setting asks for an approval at that value
   */
  private async approvalNeed(
    manager: EntityManager,
    tenantId: string,
    items: StockTransferItem[],
  ) {
    const { transferApprovalMode, transferApprovalThreshold } =
      await this.settingsService.getSettings(tenantId);
    if (!transferApprovalMode || transferApprovalMode === 'never') {
      return { required: false, value: null };
    }
    const variants = items.length
      ? await manager.find(ProductVariant, {
          where: { tenantId, id: In(items.map((i) => i.variantId)) },
          select: { id: true, cost: true },
        })
      : [];
    const costOf = new Map(variants.map((v) => [v.id, Number(v.cost ?? 0)]));
    const value =
      Math.round(
        items.reduce(
          (sum, i) =>
            sum + i.quantityRequested * (costOf.get(i.variantId) ?? 0),
          0,
        ) * 100,
      ) / 100;
    return {
      required: transferNeedsApproval(
        transferApprovalMode,
        transferApprovalThreshold ?? 0,
        value,
      ),
      value,
    };
  }

  private audit(
    manager: EntityManager,
    transfer: StockTransfer,
    action: string,
    metadata: Record<string, unknown>,
    reason?: string,
  ) {
    return this.auditService.record(
      {
        tenantId: transfer.tenantId,
        action,
        entityType: 'stock_transfer',
        entityId: transfer.id,
        reason: reason ?? null,
        metadata: {
          transferNumber: transfer.transferNumber,
          fromLocationId: transfer.fromLocationId,
          toLocationId: transfer.toLocationId,
          ...metadata,
        },
      },
      manager,
    );
  }

  private items(manager: EntityManager, tenantId: string, transferId: string) {
    return manager.find(StockTransferItem, {
      where: { tenantId, transferId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private async lockTransfer(
    manager: EntityManager,
    tenantId: string,
    id: string,
    action: TransferAction,
  ): Promise<StockTransfer> {
    const transfer = await manager.findOne(StockTransfer, {
      where: { tenantId, id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!transfer) throw new NotFoundException('Transfer not found');
    await this.assertTransferAccess(manager, transfer, action);
    const error = transferTransitionError(transfer.status, action);
    if (error) throw new BadRequestException(error);
    return transfer;
  }

  /**
   * Branch access (spec §9): a branch-limited user sees a transfer from or to
   * one of their branches' locations (else "not found"); dispatching needs the
   * source, receiving the destination.
   */
  private async assertTransferAccess(
    manager: EntityManager,
    transfer: Pick<
      StockTransfer,
      'tenantId' | 'fromLocationId' | 'toLocationId'
    >,
    action: TransferAction | 'view',
  ) {
    if (hasAllBranches()) return;
    const [source, destination] = await Promise.all([
      canAccessLocation(manager, transfer.tenantId, transfer.fromLocationId),
      canAccessLocation(manager, transfer.tenantId, transfer.toLocationId),
    ]);
    if (!source && !destination) {
      throw new NotFoundException('Transfer not found');
    }
    if (action === 'dispatch' && !source) {
      throw new ForbiddenException(
        'Only staff of the sending branch can dispatch this transfer',
      );
    }
    if (action === 'receive' && !destination) {
      throw new ForbiddenException(
        'Only staff of the receiving branch can receive this transfer',
      );
    }
  }

  private async insertItems(
    manager: EntityManager,
    transfer: StockTransfer,
    dto: SaveTransferDto,
  ) {
    await manager.insert(
      StockTransferItem,
      dto.items.map((item) => ({
        tenantId: transfer.tenantId,
        transferId: transfer.id,
        variantId: item.variantId,
        quantityRequested: item.quantity,
      })),
    );
  }

  private async validateInput(tenantId: string, dto: SaveTransferDto) {
    if (dto.fromLocationId === dto.toLocationId) {
      throw new BadRequestException(
        'The source and destination locations must differ',
      );
    }
    const locations = await this.dataSource
      .getRepository(InventoryLocation)
      .find({
        where: { tenantId, id: In([dto.fromLocationId, dto.toLocationId]) },
        select: { id: true, stockStatus: true },
      });
    if (locations.length !== 2)
      throw new NotFoundException('Location not found');
    // A branch-limited user moves stock from or to one of their branches
    const [source, destination] = await Promise.all([
      canAccessLocation(this.dataSource.manager, tenantId, dto.fromLocationId),
      canAccessLocation(this.dataSource.manager, tenantId, dto.toLocationId),
    ]);
    if (!source && !destination) {
      throw new NotFoundException('Location not found');
    }
    if (locations.some((l) => l.stockStatus === LocationStockStatus.TRANSIT)) {
      throw new BadRequestException(
        'The transit location cannot be a transfer end',
      );
    }
    const variantIds = dto.items.map((i) => i.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException('Each variant can only appear once');
    }
    const variants = await this.dataSource
      .getRepository(ProductVariant)
      .count({ where: { tenantId, id: In(variantIds) } });
    if (variants !== variantIds.length) {
      throw new NotFoundException('One or more variants were not found');
    }
    // Decimals only for measured items, up to their unit's precision
    await assertUnitQuantities(this.dataSource.manager, tenantId, dto.items);
  }

  /** Quantities given per transfer line must suit the line's unit */
  private async assertLineUnits(
    manager: EntityManager,
    tenantId: string,
    items: StockTransferItem[],
    lines: { itemId: string; quantity: number }[] | undefined,
  ) {
    if (!lines?.length) return;
    const variantOf = new Map(items.map((i) => [i.id, i.variantId]));
    await assertUnitQuantities(
      manager,
      tenantId,
      lines.flatMap((l) => {
        const variantId = variantOf.get(l.itemId);
        return variantId ? [{ variantId, quantity: l.quantity }] : [];
      }),
      { allowZero: true },
    );
  }
}
