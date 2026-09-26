import { StorageService } from '../storage/storage.service';
import { detectImageType } from '../storage/image-validation';
import { AuditService } from '../audit/audit.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, IsNull, Repository } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import { Branch } from '../database/entities/branch.entity';
import { Register } from '../database/entities/register.entity';
import { Warehouse } from '../database/entities/warehouse.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import {
  PaymentMethod,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { TaxRate, TaxRateStatus } from '../database/entities/tax-rate.entity';
import { UpdateStoreSettingsDto } from './dto/settings.dto';
import { SettingsVersion } from './settings-version.entity';
import { requestContext } from '../common/context/request-context';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  applyChanges,
  diffSettings,
  dueVersions,
  nextScheduledAt,
  resolveEffective,
  versionStatus,
} from './settings-versioning';

/** Validate an exchangeRates setting: ISO codes, positive rates, not the store currency */
export function normalizeExchangeRates(
  input: unknown,
  storeCurrency: string,
): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('exchangeRates must be an object');
  }
  const rates: Record<string, number> = {};
  for (const [rawCode, rawRate] of Object.entries(input)) {
    const code = rawCode.trim().toUpperCase();
    const rate = Number(rawRate);
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new BadRequestException(`${rawCode} is not a currency code`);
    }
    if (code === storeCurrency.toUpperCase()) {
      throw new BadRequestException(
        `${code} is the store currency; it needs no exchange rate`,
      );
    }
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
      throw new BadRequestException(
        `The ${code} rate must be a positive number`,
      );
    }
    rates[code] = Math.round(rate * 1_000_000) / 1_000_000;
  }
  return rates;
}

// Logos are small: they print on 58/80 mm receipts
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface StoreSettings {
  storeName: string;
  currencyCode: string;
  pricesIncludeTax: boolean;
  defaultTaxRateId: string | null;
  receiptHeader: string;
  receiptFooter: string;
  lowStockThreshold: number;
  maxDiscountPercent: number;
  // 'letter': US Letter invoice (same layout as A4)
  receiptFormat: '58mm' | '80mm' | 'a4' | 'letter';
  heldCartExpiryHours: number;
  requireOpenShift: boolean;
  // Hour (branch time) at which the trading day starts: 4 = sales before 04:00
  // count for the previous business date
  businessDayCutoffHour: number;
  // A sale totalling 0.00 may complete without payment (needs pos.discount.override)
  allowZeroValueSales: boolean;
  returnWindowDays: number;
  shiftVarianceTolerance: number;
  expenseApprovalThreshold: number;
  costingMethod: 'average' | 'fifo';
  purchaseApprovalThreshold: number;
  // % above the ordered quantity that may be received without purchasing.approve
  purchaseOverReceiptTolerance: number;
  // % a supplier invoice price may exceed the order price before it needs approval
  purchaseInvoiceVarianceTolerance: number;
  countVarianceTolerance: number;
  // Transfers needing inventory.transfer.approve before dispatch:
  // never, above transferApprovalThreshold (value at cost), or always
  transferApprovalMode: 'never' | 'threshold' | 'always';
  transferApprovalThreshold: number;
  // Receiving more than was dispatched: allowed up to this % of the line
  // without approval; above it needs inventory.transfer.approve
  transferOverReceiptTolerancePercent: number;
  offlineLeaseHours: number;
  // Offline selling limits carried by the till's signed lease (0 = no limit):
  // largest single sale, number of sales and their total under one lease
  offlineMaxSaleAmount: number;
  offlineMaxSales: number;
  offlineMaxTotal: number;
  // Gift cards sold expire this many months after they are sold (0 = never);
  // the remaining value is written off by the daily expiry job
  giftCardExpiryMonths: number;
  requireMfaForAdmins: boolean;
  // Business information
  businessLegalName: string;
  businessAddressLine1: string;
  businessAddressLine2: string;
  businessCity: string;
  businessState: string;
  businessPostalCode: string;
  businessCountry: string;
  businessPhone: string;
  businessEmail: string;
  businessWebsite: string;
  businessTaxId: string;
  businessRegistrationNumber: string;
  businessLogoUrl: string;
  returnPolicy: string;
  // Receipts & printing
  receiptTemplate: 'classic' | 'compact' | 'modern';
  receiptShowLogo: boolean;
  receiptShowBusinessDetails: boolean;
  receiptShowTaxBreakdown: boolean;
  receiptShowSku: boolean;
  receiptShowCashier: boolean;
  receiptShowCustomer: boolean;
  receiptShowLoyalty: boolean;
  receiptShowBarcode: boolean;
  receiptShowReturnPolicy: boolean;
  receiptFontSize: 'small' | 'normal' | 'large';
  autoPrintReceipt: boolean;
  receiptCopies: number;
  // Loyalty
  loyaltyEnabled: boolean;
  loyaltyEarnPercent: number;
  loyaltyPointValue: number;
  loyaltyMinRedeemPoints: number;
  loyaltyMaxRedeemPercent: number;
  // Other accepted currencies: units per 1 unit of currencyCode (e.g. { HTG: 132.5 })
  exchangeRates: Record<string, number>;
  // Default app language for everyone in the store
  language: 'en' | 'fr' | 'ht' | 'es';
  // Weighted / price-embedded barcodes (GS1 variable measure): two-digit prefixes
  // (20–29) whose EAN-13 codes carry a PLU and a weight or price; empty = off
  weightedBarcodePrefixes: string[];
  // What the value digits hold: the weight ('weight') or the price ('price')
  weightedBarcodeLayout: 'weight' | 'price';
  // Digits of the item code (PLU) after the prefix
  weightedBarcodeItemCodeLength: number;
  // Decimals of the value (weight: 3 = grams → kg; price: 2)
  weightedBarcodeValueDecimals: number;
}

export const DEFAULT_SETTINGS: Omit<StoreSettings, 'storeName'> = {
  currencyCode: 'USD',
  pricesIncludeTax: false,
  defaultTaxRateId: null,
  receiptHeader: '',
  receiptFooter: 'Thank you for your purchase!',
  lowStockThreshold: 5,
  maxDiscountPercent: 20,
  receiptFormat: '80mm',
  heldCartExpiryHours: 24,
  requireOpenShift: false,
  businessDayCutoffHour: 0,
  allowZeroValueSales: false,
  returnWindowDays: 30,
  shiftVarianceTolerance: 5,
  expenseApprovalThreshold: 0,
  costingMethod: 'average',
  purchaseApprovalThreshold: 0,
  purchaseOverReceiptTolerance: 0,
  purchaseInvoiceVarianceTolerance: 0,
  countVarianceTolerance: 0,
  transferApprovalMode: 'never',
  transferApprovalThreshold: 0,
  transferOverReceiptTolerancePercent: 0,
  offlineLeaseHours: 24,
  // Amounts depend on the currency, so they are off until the store sets them
  offlineMaxSaleAmount: 0,
  offlineMaxSales: 500,
  offlineMaxTotal: 0,
  giftCardExpiryMonths: 0,
  requireMfaForAdmins: false,
  businessLegalName: '',
  businessAddressLine1: '',
  businessAddressLine2: '',
  businessCity: '',
  businessState: '',
  businessPostalCode: '',
  businessCountry: '',
  businessPhone: '',
  businessEmail: '',
  businessWebsite: '',
  businessTaxId: '',
  businessRegistrationNumber: '',
  businessLogoUrl: '',
  returnPolicy: '',
  receiptTemplate: 'classic',
  receiptShowLogo: true,
  receiptShowBusinessDetails: true,
  receiptShowTaxBreakdown: true,
  receiptShowSku: false,
  receiptShowCashier: true,
  receiptShowCustomer: true,
  receiptShowLoyalty: true,
  receiptShowBarcode: true,
  receiptShowReturnPolicy: false,
  receiptFontSize: 'normal',
  autoPrintReceipt: false,
  receiptCopies: 1,
  // 1% back at 0.01 per point = 1 point per currency unit (the original behaviour)
  loyaltyEnabled: true,
  loyaltyEarnPercent: 1,
  loyaltyPointValue: 0.01,
  loyaltyMinRedeemPoints: 100,
  loyaltyMaxRedeemPercent: 100,
  exchangeRates: {},
  language: 'en',
  weightedBarcodePrefixes: [],
  weightedBarcodeLayout: 'weight',
  weightedBarcodeItemCodeLength: 5,
  weightedBarcodeValueDecimals: 3,
};

// Effective settings are cached per store this long (and never past a scheduled change)
const SETTINGS_CACHE_TTL_MS = 30_000;
// A change dated less than this far ahead is applied immediately
const SCHEDULE_MIN_LEAD_MS = 1_000;

interface CachedSettings {
  value: StoreSettings;
  expiresAt: number;
}

@Injectable()
export class SettingsService {
  private readonly cache = new Map<string, CachedSettings>();

  constructor(
    @InjectRepository(Tenant)
    private tenantRepository: Repository<Tenant>,
    @InjectRepository(TaxRate)
    private taxRateRepository: Repository<TaxRate>,
    @InjectRepository(SettingsVersion)
    private versionRepository: Repository<SettingsVersion>,
    private dataSource: DataSource,
    private auditService: AuditService,
    private storageService: StorageService,
    // Domain events (settings.changed); optional for unit tests
    @Optional() private outbox?: OutboxService,
  ) {}

  /**
   * Effective store settings: defaults + stored values, after applying any scheduled
   * change that has become due. Cached briefly per store; pass a transaction's manager
   * to read inside it (uncached).
   */
  async getSettings(
    tenantId: string,
    manager?: EntityManager,
  ): Promise<StoreSettings> {
    if (manager) {
      const tenant = await manager
        .getRepository(Tenant)
        .findOneOrFail({ where: { id: tenantId } });
      return this.toSettings(tenant);
    }

    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.value };
    }

    const nextChange = await this.applyDueVersions(tenantId);
    const tenant = await this.tenantRepository.findOneOrFail({
      where: { id: tenantId },
    });
    const value = this.toSettings(tenant);
    this.cache.set(tenantId, {
      value,
      expiresAt: Math.min(
        Date.now() + SETTINGS_CACHE_TTL_MS,
        nextChange?.getTime() ?? Infinity,
      ),
    });
    return { ...value };
  }

  /** Drop the cached settings of a store (after any change). */
  invalidate(tenantId: string) {
    this.cache.delete(tenantId);
  }

  /**
   * Change settings now, or schedule the change for a future `effectiveFrom`.
   * Every change is stored as a new version and audited.
   */
  async updateSettings(
    tenantId: string,
    dto: UpdateStoreSettingsDto,
    // costingMigration: set by InventoryService.changeCostingMethod, which revalues stock first
    options: { costingMigration?: boolean } = {},
  ): Promise<StoreSettings> {
    const { effectiveFrom: effectiveInput, note, ...patch } = dto;
    if (patch.costingMethod !== undefined && !options.costingMigration) {
      await this.assertCostingChangeAllowed(tenantId, patch.costingMethod);
    }
    if (patch.exchangeRates !== undefined) {
      const current = await this.getSettings(tenantId);
      patch.exchangeRates = normalizeExchangeRates(
        patch.exchangeRates,
        patch.currencyCode ?? current.currencyCode,
      );
    }

    if (patch.weightedBarcodePrefixes !== undefined) {
      patch.weightedBarcodePrefixes = [
        ...new Set(patch.weightedBarcodePrefixes.map((p) => p.trim())),
      ].sort();
    }

    if (patch.defaultTaxRateId) {
      await this.taxRateRepository.findOneOrFail({
        where: { id: patch.defaultTaxRateId, tenantId },
      });
    }

    const now = new Date();
    const effectiveFrom = effectiveInput ? new Date(effectiveInput) : now;
    if (Number.isNaN(effectiveFrom.getTime())) {
      throw new BadRequestException('effectiveFrom is not a valid date');
    }
    const scheduled =
      effectiveFrom.getTime() - now.getTime() >= SCHEDULE_MIN_LEAD_MS;

    // Make sure anything already due is applied before comparing
    await this.applyDueVersions(tenantId);

    await this.dataSource.transaction(async (manager) => {
      const tenant = await this.lockTenant(manager, tenantId);
      const pending = await manager.getRepository(SettingsVersion).find({
        where: { tenantId, appliedAt: IsNull(), cancelledAt: IsNull() },
      });
      const current = this.toSettings(tenant);
      // A scheduled change is compared with what will be in force at that time
      const baseline = scheduled
        ? resolveEffective(current, pending, effectiveFrom)
        : current;
      const { changes, changedKeys } = diffSettings(baseline, patch);
      if (changedKeys.length === 0) return;

      const snapshot = applyChanges(baseline, changes) as unknown as Record<
        string,
        unknown
      >;
      const version = await manager.getRepository(SettingsVersion).save(
        manager.getRepository(SettingsVersion).create({
          tenantId,
          version: await this.nextVersionNumber(manager, tenantId),
          changes,
          changedKeys,
          snapshot,
          actorId: requestContext.get()?.userId ?? null,
          effectiveFrom: scheduled ? effectiveFrom : now,
          appliedAt: scheduled ? null : now,
          note: note ?? null,
        }),
      );

      if (scheduled) {
        await this.auditService.record(
          {
            tenantId,
            action: 'settings.change_scheduled',
            entityType: 'settings',
            entityId: tenantId,
            changes: {
              before: pick(baseline, changedKeys),
              after: changes,
            },
            metadata: {
              version: version.version,
              effectiveFrom: effectiveFrom.toISOString(),
            },
          },
          manager,
        );
        await this.recordChanged(manager, tenantId, version, true);
        return;
      }

      this.applyToTenant(tenant, changes);
      await manager.getRepository(Tenant).save(tenant);
      await this.auditService.record(
        {
          tenantId,
          action: 'settings.updated',
          entityType: 'settings',
          entityId: tenantId,
          changes: { before: pick(current, changedKeys), after: changes },
          metadata: { version: version.version },
        },
        manager,
      );
      await this.recordChanged(manager, tenantId, version, false);
    });

    this.invalidate(tenantId);
    return this.getSettings(tenantId);
  }

  /**
   * The costing method only changes freely while the store holds no stock;
   * afterwards it goes through POST /inventory/costing-method, which revalues
   * the stock and records valuation entries.
   */
  private async assertCostingChangeAllowed(
    tenantId: string,
    costingMethod: StoreSettings['costingMethod'],
  ) {
    const current = await this.getSettings(tenantId);
    if (current.costingMethod === costingMethod) return;
    const rows = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM stock_levels WHERE "tenantId" = $1 AND "quantityOnHand" <> 0 LIMIT 1`,
      [tenantId],
    );
    if (rows.length > 0) {
      throw new BadRequestException(
        'The store holds stock: change the costing method from Inventory (costing method change), which revalues the stock',
      );
    }
  }

  /** Settings history, newest first. */
  async listVersions(tenantId: string, limit = 50) {
    await this.applyDueVersions(tenantId);
    const versions = await this.versionRepository.find({
      where: { tenantId },
      order: { version: 'DESC' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const names = await this.userNames(
      versions.flatMap((v) => [v.actorId, v.cancelledBy]),
    );
    return versions.map((v) => ({
      id: v.id,
      version: v.version,
      status: versionStatus(v),
      changedKeys: v.changedKeys,
      changes: v.changes,
      effectiveFrom: v.effectiveFrom,
      appliedAt: v.appliedAt,
      cancelledAt: v.cancelledAt,
      createdAt: v.createdAt,
      note: v.note,
      actorId: v.actorId,
      actorName: v.actorId ? (names.get(v.actorId) ?? null) : null,
      cancelledByName: v.cancelledBy
        ? (names.get(v.cancelledBy) ?? null)
        : null,
    }));
  }

  /** One version, with the full settings snapshot. */
  async getVersion(tenantId: string, id: string) {
    const version = await this.versionRepository.findOne({
      where: { tenantId, id },
    });
    if (!version) throw new NotFoundException('Settings version not found');
    const names = await this.userNames([version.actorId]);
    return {
      ...version,
      status: versionStatus(version),
      actorName: version.actorId ? (names.get(version.actorId) ?? null) : null,
    };
  }

  /** Cancel a scheduled change that hasn't taken effect yet. */
  async cancelVersion(tenantId: string, id: string) {
    await this.applyDueVersions(tenantId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockTenant(manager, tenantId);
      const repo = manager.getRepository(SettingsVersion);
      const version = await repo.findOne({ where: { tenantId, id } });
      if (!version) throw new NotFoundException('Settings version not found');
      if (version.appliedAt || version.cancelledAt) {
        throw new BadRequestException(
          'Only a scheduled change that has not taken effect can be cancelled',
        );
      }
      version.cancelledAt = new Date();
      version.cancelledBy = requestContext.get()?.userId ?? null;
      await repo.save(version);
      await this.auditService.record(
        {
          tenantId,
          action: 'settings.change_cancelled',
          entityType: 'settings',
          entityId: tenantId,
          changes: { after: version.changes },
          metadata: {
            version: version.version,
            effectiveFrom: version.effectiveFrom.toISOString(),
          },
        },
        manager,
      );
    });
    this.invalidate(tenantId);
    return this.getVersion(tenantId, id);
  }

  /** settings.changed domain event (scheduled: a future change was planned) */
  private async recordChanged(
    manager: EntityManager,
    tenantId: string,
    version: Pick<SettingsVersion, 'version' | 'changedKeys' | 'effectiveFrom'>,
    scheduled: boolean,
  ) {
    await this.outbox?.record(manager, {
      tenantId,
      type: 'settings.changed',
      aggregateId: tenantId,
      aggregateVersion: version.version,
      payload: {
        version: version.version,
        changedKeys: version.changedKeys,
        scheduled,
        effectiveFrom: new Date(version.effectiveFrom).toISOString(),
      },
    });
  }

  /** First history entry of a new store (inside the provisioning transaction). */
  async recordInitialVersion(
    tenantId: string,
    manager: EntityManager,
    note = 'Store created',
  ) {
    const settings = await this.getSettings(tenantId, manager);
    const now = new Date();
    await manager.getRepository(SettingsVersion).save(
      manager.getRepository(SettingsVersion).create({
        tenantId,
        version: await this.nextVersionNumber(manager, tenantId),
        changes: {},
        changedKeys: [],
        snapshot: { ...settings } as Record<string, unknown>,
        actorId: requestContext.get()?.userId ?? null,
        effectiveFrom: now,
        appliedAt: now,
        note,
      }),
    );
  }

  /**
   * Apply scheduled changes that are due (resolving settings "at read time").
   * Returns when the next scheduled change takes effect, if any.
   */
  private async applyDueVersions(tenantId: string): Promise<Date | null> {
    const waiting = await this.versionRepository.find({
      where: { tenantId, appliedAt: IsNull(), cancelledAt: IsNull() },
      select: {
        id: true,
        version: true,
        effectiveFrom: true,
        appliedAt: true,
        cancelledAt: true,
      },
    });
    if (waiting.length === 0) return null;
    const now = new Date();
    if (
      dueVersions(
        waiting.map((v) => ({ ...v, changes: {} })),
        now,
      ).length
    ) {
      await this.dataSource.transaction(async (manager) => {
        const tenant = await this.lockTenant(manager, tenantId);
        const repo = manager.getRepository(SettingsVersion);
        // Re-read under the lock: another request may have applied them already
        const due = dueVersions(
          await repo.find({
            where: { tenantId, appliedAt: IsNull(), cancelledAt: IsNull() },
          }),
          now,
        );
        if (due.length === 0) return;
        for (const version of due) {
          const before = this.toSettings(tenant);
          this.applyToTenant(tenant, version.changes);
          version.appliedAt = now;
          await repo.save(version);
          await this.auditService.record(
            {
              tenantId,
              action: 'settings.scheduled_applied',
              entityType: 'settings',
              entityId: tenantId,
              actorId: version.actorId,
              changes: {
                before: pick(before, version.changedKeys),
                after: version.changes,
              },
              metadata: {
                version: version.version,
                effectiveFrom: version.effectiveFrom.toISOString(),
              },
            },
            manager,
          );
          await this.recordChanged(manager, tenantId, version, false);
        }
        await manager.getRepository(Tenant).save(tenant);
      });
      this.invalidate(tenantId);
    }
    return nextScheduledAt(
      waiting.map((v) => ({ ...v, changes: {} })),
      now,
    );
  }

  private toSettings(tenant: Tenant): StoreSettings {
    return {
      ...DEFAULT_SETTINGS,
      ...(tenant.settings as Partial<StoreSettings>),
      storeName: tenant.name,
    };
  }

  private applyToTenant(tenant: Tenant, changes: Record<string, unknown>) {
    const { storeName, ...rest } = changes;
    if (typeof storeName === 'string' && storeName) {
      tenant.name = storeName;
    }
    tenant.settings = { ...tenant.settings, ...rest };
  }

  private async lockTenant(manager: EntityManager, tenantId: string) {
    const tenant = await manager.getRepository(Tenant).findOne({
      where: { id: tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tenant) throw new NotFoundException('Store not found');
    return tenant;
  }

  // Call with the tenant row locked
  private async nextVersionNumber(manager: EntityManager, tenantId: string) {
    const [row] = await manager.query<{ next: number }[]>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM settings_versions WHERE "tenantId" = $1`,
      [tenantId],
    );
    return Number(row?.next ?? 1);
  }

  private async userNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (unique.length === 0) return names;
    const rows = await this.dataSource.query<
      {
        id: string;
        email: string;
        firstName: string | null;
        lastName: string | null;
      }[]
    >(
      `SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
      [unique],
    );
    rows.forEach((u) =>
      names.set(
        u.id,
        [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      ),
    );
    return names;
  }

  /**
   * Store an uploaded logo (content checked by its bytes, not its name) and use it
   */
  async uploadLogo(tenantId: string, file: Express.Multer.File | undefined) {
    if (!file) throw new BadRequestException('Choose an image file');
    const detected = detectImageType(file.buffer);
    if (!detected) {
      throw new UnsupportedMediaTypeException(
        'The logo must be a JPEG, PNG or WebP image',
      );
    }
    const key = this.storageService.newKey(
      `logos/${tenantId}`,
      detected.extension,
    );
    await this.storageService.put(key, file.buffer, detected.contentType);
    return this.updateSettings(tenantId, {
      businessLogoUrl: this.storageService.publicUrl(key),
    });
  }

  /**
   * Active tax rate applied to sales: the configured default, else none (0%)
   */
  async getDefaultTaxRate(tenantId: string): Promise<TaxRate | null> {
    const { defaultTaxRateId } = await this.getSettings(tenantId);
    if (!defaultTaxRateId) {
      return null;
    }
    return this.taxRateRepository.findOne({
      where: { id: defaultTaxRateId, tenantId, status: TaxRateStatus.ACTIVE },
    });
  }

  /**
   * Create the minimum setup needed to sell: a branch, a warehouse with a
   * stock location, a register and cash/card payment methods.
   * Safe to call repeatedly — existing records are reused.
   */
  async initializeDefaults(tenantId: string, manager?: EntityManager) {
    if (manager) {
      return this.createDefaults(tenantId, manager);
    }
    return this.dataSource.transaction((tx) =>
      this.createDefaults(tenantId, tx),
    );
  }

  private async createDefaults(tenantId: string, manager: EntityManager) {
    const settings = await this.getSettings(tenantId, manager);
    {
      const branchRepo = manager.getRepository(Branch);
      let branch = await branchRepo.findOne({
        where: { tenantId },
        order: { createdAt: 'ASC' },
      });
      branch ??= await branchRepo.save(
        branchRepo.create({
          tenantId,
          code: 'MAIN',
          name: 'Main Store',
          currencyCode: settings.currencyCode,
        }),
      );

      const warehouseRepo = manager.getRepository(Warehouse);
      let warehouse = await warehouseRepo.findOne({
        where: { tenantId },
        order: { createdAt: 'ASC' },
      });
      warehouse ??= await warehouseRepo.save(
        warehouseRepo.create({
          tenantId,
          code: 'MAIN',
          name: 'Main Stockroom',
        }),
      );

      const locationRepo = manager.getRepository(InventoryLocation);
      let location = await locationRepo.findOne({
        where: { tenantId, warehouseId: warehouse.id },
        order: { createdAt: 'ASC' },
      });
      location ??= await locationRepo.save(
        locationRepo.create({
          tenantId,
          warehouseId: warehouse.id,
          code: 'FLOOR',
          name: 'Sales floor',
          isSellable: true,
        }),
      );

      const registerRepo = manager.getRepository(Register);
      let register = await registerRepo.findOne({
        where: { tenantId },
        order: { createdAt: 'ASC' },
      });
      register ??= await registerRepo.save(
        registerRepo.create({
          tenantId,
          branchId: branch.id,
          code: 'REG-1',
          name: 'Register 1',
          defaultLocationId: location.id,
        }),
      );

      const methodRepo = manager.getRepository(PaymentMethod);
      const existingMethods = await methodRepo.find({ where: { tenantId } });
      const defaults = [
        {
          code: 'CASH',
          name: { en: 'Cash' },
          methodType: PaymentMethodType.CASH,
          opensDrawer: true,
        },
        {
          code: 'CARD',
          name: { en: 'Card' },
          methodType: PaymentMethodType.CARD,
          opensDrawer: false,
        },
      ];
      for (const method of defaults) {
        if (!existingMethods.some((m) => m.code === method.code)) {
          await methodRepo.save(methodRepo.create({ tenantId, ...method }));
        }
      }

      return { branch, warehouse, location, register };
    }
  }
}

function pick(settings: object, keys: string[]): Record<string, unknown> {
  const source = settings as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, source[key]]));
}
