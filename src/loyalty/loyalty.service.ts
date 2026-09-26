import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Customer } from '../database/entities/customer.entity';
import {
  LoyaltyTransaction,
  LoyaltyTransactionType,
} from '../database/entities/loyalty-transaction.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { round2 } from '../sales/sale-calculator';
import {
  applyPointChange,
  LoyaltyRules,
  pointsEarned,
  pointsForAmount,
  valueOfPoints,
} from './loyalty-math';

// Payment method customers use to pay with points
export const LOYALTY_METHOD_CODE = 'LOYALTY';

@Injectable()
export class LoyaltyService {
  constructor(
    @InjectRepository(LoyaltyTransaction)
    private ledger: Repository<LoyaltyTransaction>,
    private settingsService: SettingsService,
    private auditService: AuditService,
  ) {}

  async rules(tenantId: string): Promise<LoyaltyRules> {
    const s = await this.settingsService.getSettings(tenantId);
    return {
      enabled: s.loyaltyEnabled,
      earnPercent: Number(s.loyaltyEarnPercent),
      pointValue: Number(s.loyaltyPointValue),
      minRedeemPoints: Number(s.loyaltyMinRedeemPoints),
      maxRedeemPercent: Number(s.loyaltyMaxRedeemPercent),
    };
  }

  isLoyaltyMethod(method: Pick<PaymentMethod, 'code'>): boolean {
    return method.code === LOYALTY_METHOD_CODE;
  }

  /**
   * The "Loyalty points" payment method, created on first use and kept active
   * only while the programme is enabled
   */
  async ensurePaymentMethod(
    tenantId: string,
    manager: EntityManager,
  ): Promise<PaymentMethod | null> {
    const { enabled } = await this.rules(tenantId);
    const repo = manager.getRepository(PaymentMethod);
    let method = await repo.findOne({
      where: { tenantId, code: LOYALTY_METHOD_CODE },
    });
    if (!method && enabled) {
      method = await repo.save(
        repo.create({
          tenantId,
          code: LOYALTY_METHOD_CODE,
          name: { en: 'Loyalty points' },
          methodType: PaymentMethodType.STORE_CREDIT,
          requiresReference: false,
          opensDrawer: false,
          provider: 'manual',
        }),
      );
    }
    if (method) {
      const status = enabled
        ? PaymentMethodStatus.ACTIVE
        : PaymentMethodStatus.INACTIVE;
      if (method.status !== status) {
        await repo.update(method.id, { status });
        method.status = status;
      }
    }
    return method;
  }

  /**
   * Check a points payment before the sale is saved: customer present, enough
   * points, minimum and maximum respected. Returns the points it will cost.
   */
  async validateRedemption(
    tenantId: string,
    customer: Pick<Customer, 'id' | 'loyaltyPoints'> | null,
    amount: number,
    saleTotal: number,
  ): Promise<number> {
    const rules = await this.rules(tenantId);
    if (!rules.enabled)
      throw new BadRequestException('The loyalty programme is turned off');
    if (!customer)
      throw new BadRequestException(
        'Choose the customer to pay with loyalty points',
      );
    const points = pointsForAmount(rules, amount);
    if (points < rules.minRedeemPoints) {
      throw new BadRequestException(
        `At least ${rules.minRedeemPoints} points must be used at once`,
      );
    }
    if (points > Number(customer.loyaltyPoints)) {
      throw new BadRequestException(
        `The customer has ${customer.loyaltyPoints} points (worth ${valueOfPoints(rules, Number(customer.loyaltyPoints)).toFixed(2)})`,
      );
    }
    if (round2(amount) > round2((saleTotal * rules.maxRedeemPercent) / 100)) {
      throw new BadRequestException(
        `At most ${rules.maxRedeemPercent}% of a sale can be paid with points`,
      );
    }
    return points;
  }

  /** Spend points as a payment on a sale (inside the sale transaction) */
  async redeem(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      amount: number;
    },
  ) {
    const rules = await this.rules(input.tenantId);
    const points = pointsForAmount(rules, input.amount);
    // Guarded decrement: two tills can't spend the same points
    const rows = await manager.query<{ loyaltyPoints: number }[]>(
      `UPDATE customers SET "loyaltyPoints" = "loyaltyPoints" - $1
       WHERE id = $2 AND "tenantId" = $3 AND "loyaltyPoints" >= $1 RETURNING "loyaltyPoints"`,
      [points, input.customerId, input.tenantId],
    );
    const updated = Array.isArray(rows[0])
      ? (rows[0] as unknown as typeof rows)
      : rows;
    if (updated.length === 0) {
      throw new BadRequestException('The customer no longer has enough points');
    }
    await this.write(manager, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: LoyaltyTransactionType.REDEEM,
      points: -points,
      balanceAfter: Number(updated[0].loyaltyPoints),
      amount: input.amount,
      saleId: input.saleId,
    });
  }

  /**
   * Award points for a completed sale. Earned on what was paid with money, not on
   * the part paid with points.
   */
  async earn(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      amountPaid: number;
    },
  ) {
    const rules = await this.rules(input.tenantId);
    const points = pointsEarned(rules, input.amountPaid);
    if (points <= 0) return;
    await this.change(manager, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: LoyaltyTransactionType.EARN,
      points,
      amount: input.amountPaid,
      saleId: input.saleId,
    });
  }

  /**
   * Undo everything a sale did to the customer's points (void / cancel):
   * earned points are taken back and spent points given back
   */
  async reverseSale(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    note: string,
  ) {
    const rows = await manager.find(LoyaltyTransaction, {
      where: { tenantId, saleId },
    });
    const byCustomer = new Map<string, number>();
    for (const row of rows) {
      byCustomer.set(
        row.customerId,
        (byCustomer.get(row.customerId) ?? 0) + row.points,
      );
    }
    for (const [customerId, net] of byCustomer) {
      if (net === 0) continue;
      await this.change(manager, {
        tenantId,
        customerId,
        type: LoyaltyTransactionType.REVERSAL,
        points: -net,
        saleId,
        note,
      });
    }
  }

  /**
   * A return: take back the points earned on the refunded money, and give back
   * points refunded to the "Loyalty points" payment method
   */
  async onReturn(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      returnId: string;
      moneyRefunded: number;
      pointsRefundedAmount: number;
      returnNumber: string;
    },
  ) {
    const rules = await this.rules(input.tenantId);
    // Never take back more than the sale earned (net of earlier reversals)
    const earnedRows = await manager.find(LoyaltyTransaction, {
      where: { tenantId: input.tenantId, saleId: input.saleId },
    });
    const earnedLeft =
      earnedRows
        .filter((r) => r.type === LoyaltyTransactionType.EARN)
        .reduce((a, r) => a + r.points, 0) +
      earnedRows
        .filter(
          (r) => r.type === LoyaltyTransactionType.REVERSAL && r.points < 0,
        )
        .reduce((a, r) => a + r.points, 0);
    const takeBack = Math.min(
      Math.max(earnedLeft, 0),
      pointsEarned({ ...rules, enabled: true }, input.moneyRefunded),
    );
    if (takeBack > 0) {
      await this.change(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: LoyaltyTransactionType.REVERSAL,
        points: -takeBack,
        amount: input.moneyRefunded,
        saleId: input.saleId,
        returnId: input.returnId,
        note: `Return ${input.returnNumber}`,
      });
    }
    if (input.pointsRefundedAmount > 0) {
      await this.change(manager, {
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: LoyaltyTransactionType.REVERSAL,
        points: pointsForAmount(rules, input.pointsRefundedAmount),
        amount: input.pointsRefundedAmount,
        saleId: input.saleId,
        returnId: input.returnId,
        note: `Points refunded on return ${input.returnNumber}`,
      });
    }
  }

  /** Manual correction by a manager (audited) */
  async adjust(
    tenantId: string,
    customerId: string,
    points: number,
    note: string,
    manager: EntityManager,
  ) {
    const customer = await manager.findOne(Customer, {
      where: { id: customerId, tenantId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (Number(customer.loyaltyPoints) + points < 0) {
      throw new BadRequestException(
        `The customer only has ${customer.loyaltyPoints} points`,
      );
    }
    await this.change(manager, {
      tenantId,
      customerId,
      type: LoyaltyTransactionType.ADJUSTMENT,
      points,
      note,
    });
    await this.auditService.record(
      {
        tenantId,
        action: 'loyalty.adjusted',
        entityType: 'customer',
        entityId: customerId,
        reason: note,
        metadata: { points, before: Number(customer.loyaltyPoints) },
      },
      manager,
    );
    return this.balance(tenantId, customerId, manager);
  }

  async history(tenantId: string, customerId: string, limit = 100) {
    return this.ledger.find({
      where: { tenantId, customerId },
      order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  async balance(tenantId: string, customerId: string, manager?: EntityManager) {
    const repo = (manager ?? this.ledger.manager).getRepository(Customer);
    const customer = await repo.findOne({
      where: { id: customerId, tenantId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const rules = await this.rules(tenantId);
    const points = Number(customer.loyaltyPoints);
    return { points, value: valueOfPoints(rules, points), rules };
  }

  /**
   * Apply a point change to the balance (never below zero) and record it. The
   * ledger records the change actually applied, so the balance always equals the
   * sum of the ledger: a reversal of points the customer already spent records
   * only what was left, and notes the shortfall.
   */
  private async change(
    manager: EntityManager,
    entry: {
      tenantId: string;
      customerId: string;
      type: LoyaltyTransactionType;
      points: number;
      amount?: number;
      saleId?: string;
      returnId?: string;
      note?: string;
    },
  ) {
    // Lock the row so the balance read and the update can't interleave with another till
    const rows = await manager.query<{ loyaltyPoints: number }[]>(
      `SELECT "loyaltyPoints" FROM customers
       WHERE id = $1 AND "tenantId" = $2 FOR UPDATE`,
      [entry.customerId, entry.tenantId],
    );
    if (rows.length === 0) return;
    const { applied, balanceAfter, shortfall } = applyPointChange(
      Number(rows[0].loyaltyPoints),
      entry.points,
    );
    if (applied !== 0) {
      await manager.query(
        `UPDATE customers SET "loyaltyPoints" = $1 WHERE id = $2 AND "tenantId" = $3`,
        [balanceAfter, entry.customerId, entry.tenantId],
      );
    }
    const note = shortfall
      ? [
          entry.note,
          `${Math.abs(shortfall)} of ${Math.abs(entry.points)} points not taken back: already spent`,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 255)
      : entry.note;
    await this.write(manager, {
      ...entry,
      points: applied,
      balanceAfter,
      note,
    });
  }

  private async write(
    manager: EntityManager,
    entry: {
      tenantId: string;
      customerId: string;
      type: LoyaltyTransactionType;
      points: number;
      balanceAfter: number;
      amount?: number;
      saleId?: string;
      returnId?: string;
      note?: string;
    },
  ) {
    await manager.insert(LoyaltyTransaction, {
      tenantId: entry.tenantId,
      customerId: entry.customerId,
      type: entry.type,
      points: entry.points,
      balanceAfter: entry.balanceAfter,
      amount: entry.amount ?? null,
      saleId: entry.saleId ?? null,
      returnId: entry.returnId ?? null,
      userId: requestContext.get()?.userId ?? null,
      note: entry.note ?? null,
    });
  }
}
