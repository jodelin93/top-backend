import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { canAccessBranch, scopedBranchIds } from '../auth/branch-scope';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  assertQuantitiesFit,
  unitOfVariant,
  VARIANT_UNIT_RELATIONS,
} from '../products/variant-units';
import { Estimate, EstimateStatus } from '../database/entities/estimate.entity';
import { EstimateItem } from '../database/entities/estimate-item.entity';
import { Branch } from '../database/entities/branch.entity';
import { Customer } from '../database/entities/customer.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { ProductStatus } from '../database/entities/product.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { Permission } from '../auth/permissions';
import { nextDocumentNumber } from '../common/utils/sequence';
import { addQty } from '../common/utils/quantity';
import { paginate } from '../common/dto/pagination.dto';
import { SettingsService } from '../settings/settings.service';
import { PricingService } from '../price-lists/pricing.service';
import { TaxResolverService } from '../sales/tax-resolver.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuditService } from '../audit/audit.service';
import { calculateSale, CalcLineInput } from '../sales/sale-calculator';
import {
  approvalRequired,
  cartDiscountPercent,
  requiredOverrides,
} from '../sales/sale-authorization';
import {
  CreateEstimateDto,
  ListEstimatesQueryDto,
  UpdateEstimateDto,
} from './estimates.dto';
import { containsPattern } from '../common/utils/like';

// Estimates that can still be changed and turned into a sale
const OPEN_STATUSES = [
  EstimateStatus.DRAFT,
  EstimateStatus.SENT,
  EstimateStatus.ACCEPTED,
];
const DEFAULT_VALIDITY_DAYS = 30;

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export type EstimateView = Estimate & { expired: boolean };

/**
 * Branch access (spec §9): an estimate of another branch is "not found" for a
 * branch-limited user; store-level estimates (no branch) are visible to all
 */
const estimateVisible = (estimate: Pick<Estimate, 'branchId'>) =>
  !estimate.branchId || canAccessBranch(estimate.branchId);

@Injectable()
export class EstimatesService {
  constructor(
    @InjectRepository(Estimate)
    private estimateRepository: Repository<Estimate>,
    private dataSource: DataSource,
    private settingsService: SettingsService,
    private pricingService: PricingService,
    private taxResolver: TaxResolverService,
    private approvalsService: ApprovalsService,
    private auditService: AuditService,
  ) {}

  async findAll(tenantId: string, query: ListEstimatesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.estimateRepository
      .createQueryBuilder('estimate')
      .leftJoinAndSelect('estimate.customer', 'customer')
      .where('estimate.tenantId = :tenantId', { tenantId })
      .orderBy('estimate.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status)
      qb.andWhere('estimate.status = :status', { status: query.status });
    // Branch-limited users: their branches' estimates and store-level ones (no branch)
    const branches = scopedBranchIds();
    if (branches) {
      qb.andWhere(
        '(estimate.branchId IS NULL OR estimate.branchId = ANY(:estimateBranches))',
        { estimateBranches: branches },
      );
    }
    if (query.customerId)
      qb.andWhere('estimate.customerId = :customerId', {
        customerId: query.customerId,
      });
    if (query.search) {
      qb.andWhere(
        `(estimate.estimateNumber ILIKE :search OR estimate.customerName ILIKE :search
          OR CONCAT_WS(' ', customer.firstName, customer.lastName) ILIKE :search OR customer.companyName ILIKE :search)`,
        { search: containsPattern(query.search) },
      );
    }
    const [rows, total] = await qb.getManyAndCount();
    return paginate(
      rows.map((e) => this.view(e)),
      total,
      page,
      limit,
    );
  }

  async findOne(tenantId: string, id: string): Promise<EstimateView> {
    const estimate = await this.estimateRepository.findOne({
      where: { id, tenantId },
      relations: { items: true, customer: true },
      order: { items: { lineNumber: 'ASC' } },
    });
    if (!estimate || !estimateVisible(estimate)) {
      throw new NotFoundException('Estimate not found');
    }
    return this.view(estimate);
  }

  async create(
    tenantId: string,
    user: AuthUser,
    dto: CreateEstimateDto,
    approvalToken?: string,
  ) {
    const id = await this.dataSource.transaction(async (manager) => {
      const estimateNumber = await nextDocumentNumber(manager, {
        table: 'estimates',
        column: 'estimateNumber',
        tenantId,
        prefix: 'EST',
      });
      const issueDate = (dto.issueDate ?? today()).slice(0, 10);
      const estimate = manager.create(Estimate, {
        tenantId,
        estimateNumber,
        userId: user.id,
        status: EstimateStatus.DRAFT,
        issueDate,
        validUntil: (
          dto.validUntil ?? addDays(issueDate, DEFAULT_VALIDITY_DAYS)
        ).slice(0, 10),
        notes: dto.notes ?? null,
        terms: dto.terms ?? null,
      });
      await this.applyContent(
        manager,
        tenantId,
        user,
        estimate,
        dto,
        approvalToken,
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'estimate.created',
          entityType: 'estimate',
          entityId: estimate.id,
          metadata: { estimateNumber, total: estimate.total },
        },
        manager,
      );
      return estimate.id;
    });
    return this.findOne(tenantId, id);
  }

  async update(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: UpdateEstimateDto,
    approvalToken?: string,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const estimate = await this.lock(manager, tenantId, id);
      if (!OPEN_STATUSES.includes(estimate.status)) {
        throw new ConflictException(
          `A ${estimate.status} estimate can't be edited. Duplicate it instead.`,
        );
      }
      if (dto.issueDate) estimate.issueDate = dto.issueDate.slice(0, 10);
      if (dto.validUntil) estimate.validUntil = dto.validUntil.slice(0, 10);
      if (dto.notes !== undefined) estimate.notes = dto.notes;
      if (dto.terms !== undefined) estimate.terms = dto.terms;
      // Editing an accepted estimate sends it back for the customer's agreement
      if (estimate.status === EstimateStatus.ACCEPTED && dto.items)
        estimate.status = EstimateStatus.SENT;

      const existing = await manager.find(EstimateItem, {
        where: { tenantId, estimateId: id },
        order: { lineNumber: 'ASC' },
      });
      const content: CreateEstimateDto = {
        customerId:
          dto.customerId !== undefined ? dto.customerId : estimate.customerId,
        customerName:
          dto.customerName !== undefined
            ? dto.customerName
            : estimate.customerName,
        branchId: dto.branchId !== undefined ? dto.branchId : estimate.branchId,
        cartDiscount:
          dto.cartDiscount !== undefined
            ? dto.cartDiscount
            : estimate.cartDiscount,
        items:
          dto.items ??
          existing.map((i) => ({
            variantId: i.variantId,
            quantity: i.quantity,
            unitPrice: Number(i.unitPrice),
            discountPercent: Number(i.discountPercent),
            note: i.note ?? undefined,
          })),
      };
      await manager.delete(EstimateItem, { tenantId, estimateId: id });
      await this.applyContent(
        manager,
        tenantId,
        user,
        estimate,
        content,
        approvalToken,
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'estimate.updated',
          entityType: 'estimate',
          entityId: id,
          metadata: { total: estimate.total },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id);
  }

  async setStatus(
    tenantId: string,
    id: string,
    status:
      EstimateStatus.SENT | EstimateStatus.ACCEPTED | EstimateStatus.DECLINED,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const estimate = await this.lock(manager, tenantId, id);
      if (!OPEN_STATUSES.includes(estimate.status)) {
        throw new ConflictException(
          `This estimate is already ${estimate.status}`,
        );
      }
      if (status === EstimateStatus.ACCEPTED && this.isExpired(estimate)) {
        throw new ConflictException(
          'This estimate has expired. Extend its validity date first.',
        );
      }
      estimate.status = status;
      if (status === EstimateStatus.SENT) estimate.sentAt = new Date();
      else estimate.respondedAt = new Date();
      await manager.save(estimate);
      await this.auditService.record(
        {
          tenantId,
          action: `estimate.${status}`,
          entityType: 'estimate',
          entityId: id,
        },
        manager,
      );
    });
    return this.findOne(tenantId, id);
  }

  async remove(tenantId: string, id: string) {
    const estimate = await this.findOne(tenantId, id);
    if (estimate.status !== EstimateStatus.DRAFT) {
      throw new ConflictException(
        'Only draft estimates can be deleted; decline it instead',
      );
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Estimate, { id, tenantId });
      await this.auditService.record(
        {
          tenantId,
          action: 'estimate.deleted',
          entityType: 'estimate',
          entityId: id,
          metadata: { estimateNumber: estimate.estimateNumber },
        },
        manager,
      );
    });
  }

  /** New draft with the same customer and lines, re-priced at today's prices */
  async duplicate(
    tenantId: string,
    user: AuthUser,
    id: string,
    approvalToken?: string,
  ) {
    const source = await this.findOne(tenantId, id);
    return this.create(
      tenantId,
      user,
      {
        customerId: source.customerId,
        customerName: source.customerName,
        branchId: source.branchId,
        cartDiscount: source.cartDiscount ?? undefined,
        notes: source.notes,
        terms: source.terms,
        items: source.items.map((i) => ({
          variantId: i.variantId,
          quantity: i.quantity,
          // Keep negotiated prices; catalog-priced lines take the current price
          unitPrice:
            Number(i.unitPrice) !== Number(i.catalogPrice)
              ? Number(i.unitPrice)
              : undefined,
          discountPercent: Number(i.discountPercent) || undefined,
          note: i.note ?? undefined,
        })),
      },
      approvalToken,
    );
  }

  /**
   * Quoted prices for a sale converting this estimate: variantId → price/discount.
   * Used by SalesService so the till honours the estimate without new approvals.
   */
  async quotedLines(tenantId: string, id: string, manager?: EntityManager) {
    const repo = (manager ?? this.dataSource.manager).getRepository(Estimate);
    const estimate = await repo.findOne({
      where: { id, tenantId },
      relations: { items: true },
    });
    if (!estimate || !estimateVisible(estimate)) {
      throw new NotFoundException('Estimate not found');
    }
    if (!OPEN_STATUSES.includes(estimate.status)) {
      throw new ConflictException(
        `Estimate ${estimate.estimateNumber} is ${estimate.status}`,
      );
    }
    if (this.isExpired(estimate)) {
      throw new ConflictException(
        `Estimate ${estimate.estimateNumber} has expired`,
      );
    }
    // Per variant: its quoted price/discount and the quantity quoted (all its lines)
    const lines = new Map<
      string,
      { unitPrice: number; discountPercent: number; quantity: number }
    >();
    for (const i of estimate.items) {
      lines.set(i.variantId, {
        unitPrice: Number(i.unitPrice),
        discountPercent: Number(i.discountPercent),
        quantity: addQty(
          lines.get(i.variantId)?.quantity ?? 0,
          Number(i.quantity),
        ),
      });
    }
    return { estimate, lines };
  }

  /**
   * Lock the estimate a sale is converting until the sale's transaction ends;
   * refused when it is no longer open (another sale converted it meanwhile)
   */
  async lockOpen(manager: EntityManager, tenantId: string, id: string) {
    const estimate = await this.lock(manager, tenantId, id);
    if (!OPEN_STATUSES.includes(estimate.status)) {
      throw new ConflictException(
        `Estimate ${estimate.estimateNumber} is ${estimate.status}`,
      );
    }
    return estimate;
  }

  /**
   * Mark converted once its sale completes (called inside the sale transaction).
   * Refused when another sale converted it first, unless `strict` is false (a card
   * sale completing after its payment was captured: recorded, not undone).
   */
  async markConverted(
    manager: EntityManager,
    tenantId: string,
    id: string,
    saleId: string,
    { strict = true }: { strict?: boolean } = {},
  ) {
    const estimate = await manager.findOne(Estimate, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!estimate) throw new NotFoundException('Estimate not found');
    if (!OPEN_STATUSES.includes(estimate.status)) {
      if (estimate.convertedSaleId === saleId) return;
      if (strict) {
        throw new ConflictException(
          `Estimate ${estimate.estimateNumber} is ${estimate.status}`,
        );
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'estimate.conversion_skipped',
          entityType: 'estimate',
          entityId: id,
          metadata: {
            saleId,
            status: estimate.status,
            convertedSaleId: estimate.convertedSaleId ?? null,
          },
        },
        manager,
      );
      return;
    }
    await manager.update(
      Estimate,
      { id, tenantId, status: In(OPEN_STATUSES) },
      {
        status: EstimateStatus.CONVERTED,
        convertedSaleId: saleId,
        respondedAt: new Date(),
      },
    );
    await this.auditService.record(
      {
        tenantId,
        action: 'estimate.converted',
        entityType: 'estimate',
        entityId: id,
        metadata: { saleId },
      },
      manager,
    );
  }

  // ---------------------------------------------------------------------------

  /**
   * Price the lines like the till would (price lists, per-product tax, discounts),
   * enforce the same discount / price authority, and save the estimate + its items
   */
  private async applyContent(
    manager: EntityManager,
    tenantId: string,
    user: AuthUser,
    estimate: Estimate,
    dto: CreateEstimateDto,
    approvalToken?: string,
  ) {
    const settings = await this.settingsService.getSettings(tenantId);

    let customerName = dto.customerName ?? null;
    if (dto.customerId) {
      const customer = await manager.findOne(Customer, {
        where: { id: dto.customerId, tenantId },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      customerName = null;
    }
    let branch: Branch | null = null;
    if (dto.branchId) {
      branch = await manager.findOne(Branch, {
        where: { id: dto.branchId, tenantId },
      });
      if (!branch || !canAccessBranch(branch.id)) {
        throw new NotFoundException('Branch not found');
      }
    }

    const variantIds = [...new Set(dto.items.map((i) => i.variantId))];
    const variants = await manager.find(ProductVariant, {
      where: { tenantId, id: In(variantIds) },
      relations: VARIANT_UNIT_RELATIONS,
    });
    if (variants.length !== variantIds.length)
      throw new NotFoundException('One or more products were not found');
    for (const v of variants) {
      if (
        v.status !== VariantStatus.ACTIVE ||
        v.product.status !== ProductStatus.ACTIVE
      ) {
        throw new BadRequestException(
          `${v.product.name?.en ?? v.sku} is not available for sale`,
        );
      }
    }
    const byId = new Map(variants.map((v) => [v.id, v]));
    // Decimal quantities only for measured items, up to their unit's precision
    assertQuantitiesFit(
      new Map(variants.map((v) => [v.id, unitOfVariant(v)])),
      dto.items,
    );
    const prices = await this.pricingService.resolvePrices(tenantId, variants, {
      branchId: branch?.id,
    });
    const tax = await this.taxResolver.load(
      tenantId,
      variants.map((v) => v.product.taxCategoryId),
    );

    const inputs: (CalcLineInput & { catalogPrice: number })[] = dto.items.map(
      (item, index) => {
        const variant = byId.get(item.variantId)!;
        const catalogPrice = prices.get(variant.id)!;
        return {
          key: `${index}`,
          productId: variant.productId,
          categoryId: variant.product.categoryId ?? null,
          quantity: item.quantity,
          unitPrice: item.unitPrice ?? catalogPrice,
          discountPercent: item.discountPercent,
          taxRate: tax.rateFor(variant.product.taxCategoryId),
          catalogPrice,
        };
      },
    );
    const options = {
      taxRate: tax.defaultRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      cartDiscount: dto.cartDiscount ?? null,
    };
    const calc = calculateSale(inputs, options);

    // Quoting below the catalog price or above the discount limit needs the same
    // authority as at the till (or a manager's approval)
    const overrides = requiredOverrides(
      inputs.map((i) => ({
        catalogPrice: i.catalogPrice,
        unitPrice: i.unitPrice,
        discountPercent: i.discountPercent,
      })),
      cartDiscountPercent(inputs, options),
      Number(settings.maxDiscountPercent),
    );
    const approvals = await this.authorize(
      user,
      overrides.permissions,
      Number(settings.maxDiscountPercent),
      approvalToken,
    );

    Object.assign(estimate, {
      customerId: dto.customerId ?? null,
      customerName,
      branchId: branch?.id ?? null,
      cartDiscount: dto.cartDiscount ?? null,
      currencyCode: branch?.currencyCode ?? settings.currencyCode,
      subtotal: calc.subtotal,
      discountAmount: calc.discountAmount,
      taxAmount: calc.taxAmount,
      total: calc.total,
    });
    if (estimate.validUntil < estimate.issueDate) {
      throw new BadRequestException(
        'The validity date must be on or after the issue date',
      );
    }
    await manager.save(estimate);

    await manager.save(
      calc.lines.map((line, index) => {
        const variant = byId.get(dto.items[index].variantId)!;
        return manager.create(EstimateItem, {
          tenantId,
          estimateId: estimate.id,
          variantId: variant.id,
          sku: variant.sku,
          productName: variant.product.name?.en ?? variant.sku,
          variantName: variant.name?.en ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          catalogPrice: inputs[index].catalogPrice,
          discountPercent: line.discountPercent ?? 0,
          subtotal: line.subtotal,
          discountAmount: line.discountAmount,
          taxRate: line.taxRate ?? tax.defaultRate,
          taxAmount: line.taxAmount,
          total: line.total,
          note: dto.items[index].note ?? null,
          lineNumber: index + 1,
        });
      }),
    );

    if (approvals.length > 0) {
      await this.auditService.record(
        {
          tenantId,
          action: 'estimate.price_approved',
          entityType: 'estimate',
          entityId: estimate.id,
          approverId: approvals[0].approverId,
          reason: overrides.reasons.join('; ').slice(0, 500),
        },
        manager,
      );
    }
  }

  private async authorize(
    user: AuthUser,
    required: Permission[],
    maxPercent: number,
    approvalToken?: string,
  ) {
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const approvals: { permission: Permission; approverId: string }[] = [];
    for (const permission of required) {
      if (user.permissions?.includes(permission)) continue;
      let approverId: string | null = null;
      for (const token of tokens) {
        approverId = await this.approvalsService.verify(
          token,
          permission,
          user,
        );
        if (approverId) break;
      }
      if (!approverId) {
        throw approvalRequired(
          permission,
          permission === 'pos.price.override'
            ? 'Quoting a price different from the catalog price needs a manager approval'
            : `Discounts above ${maxPercent}% need a manager approval`,
        );
      }
      approvals.push({ permission, approverId });
    }
    return approvals;
  }

  private async lock(manager: EntityManager, tenantId: string, id: string) {
    const estimate = await manager.findOne(Estimate, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!estimate || !estimateVisible(estimate)) {
      throw new NotFoundException('Estimate not found');
    }
    return estimate;
  }

  private isExpired(estimate: Pick<Estimate, 'validUntil' | 'status'>) {
    return (
      OPEN_STATUSES.includes(estimate.status) && estimate.validUntil < today()
    );
  }

  private view(estimate: Estimate): EstimateView {
    return Object.assign(estimate, { expired: this.isExpired(estimate) });
  }
}
