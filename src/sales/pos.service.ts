import { LoyaltyService } from '../loyalty/loyalty.service';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { Customer } from '../database/entities/customer.entity';
import { assertBranchAccess, branchWhere } from '../auth/branch-scope';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { ProductStatus } from '../database/entities/product.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
} from '../database/entities/payment-method.entity';
import { Category } from '../database/entities/category.entity';
import { SettingsService } from '../settings/settings.service';
import { PricingService } from '../price-lists/pricing.service';
import { CatalogQueryDto, PosPricesDto } from './sales.dto';
import { TaxResolverService } from './tax-resolver.service';
import { sellingStaff, StaffMember } from './staff';
import {
  ensureSpecialMethod,
  GIFT_CARD_CODE,
  ON_ACCOUNT_CODE,
  STORE_CREDIT_CODE,
} from './special-tenders';
import {
  isSoldAtBranch,
  normalizeBarcode,
  soldAtBranchSql,
} from '../products/catalog-rules';
import {
  catalogUnit,
  CatalogUnit,
  unitOfVariant,
  VARIANT_UNIT_RELATIONS,
} from '../products/variant-units';
import {
  parseWeightedBarcode,
  scannedQuantity,
  WeightedBarcodeSettings,
} from '../products/weighted-barcode';
import { subQty } from '../common/utils/quantity';
import { StoreSettings } from '../settings/settings.service';
import { containsPattern } from '../common/utils/like';

// Only 13-digit codes starting with 2 can be variable measure labels (no
// settings lookup for ordinary scans)
const looksWeighted = (code: string | undefined): code is string =>
  !!code && /^2\d{12}$/.test(code.replace(/\s+/g, ''));

/** The store's weighted barcode settings, as the parser takes them */
export const weightedBarcodeSettings = (
  settings: Pick<
    StoreSettings,
    | 'weightedBarcodePrefixes'
    | 'weightedBarcodeLayout'
    | 'weightedBarcodeItemCodeLength'
    | 'weightedBarcodeValueDecimals'
  >,
): WeightedBarcodeSettings => ({
  prefixes: settings.weightedBarcodePrefixes ?? [],
  layout: settings.weightedBarcodeLayout ?? 'weight',
  itemCodeLength: settings.weightedBarcodeItemCodeLength ?? 5,
  valueDecimals: settings.weightedBarcodeValueDecimals ?? 3,
});

export interface CatalogItem {
  variantId: string;
  productId: string;
  categoryId: string | null;
  productName: string;
  variantName: string | null;
  sku: string;
  barcode: string | null;
  price: number;
  // Units available to sell: on hand minus reserved (held carts, pending card payments);
  // null for items whose stock is not tracked (services)
  stock: number | null;
  // False for services / non-stock items: never limited by stock
  stockTracked: boolean;
  allowBackorder: boolean;
  imageUrl: string | null;
  // Tax rate of the product (tax category, else store default), for offline totals
  taxRate: number;
  // Unit of measure; allowsDecimals = measured item (sold by weight / length /
  // volume: a quantity pad or the scale gives e.g. 1.250 kg). Null = by the piece.
  unit: CatalogUnit | null;
  // PLU / scale item code read from weighted and price-embedded barcodes
  pluCode: string | null;
  // Set when the item was found through a weighted / price-embedded barcode:
  // the quantity it carries (weight, or label price ÷ unit price) and the label
  // price (price layout). Quantity null when it cannot be computed (no price).
  scan?: { barcode: string; quantity: number | null; amount: number | null };
}

@Injectable()
export class PosService {
  constructor(
    private dataSource: DataSource,
    private settingsService: SettingsService,
    private pricingService: PricingService,
    private taxResolver: TaxResolverService,
    private loyaltyService: LoyaltyService,
  ) {}

  /**
   * Everything the POS screen needs at startup
   */
  async getContext(tenantId: string) {
    // "Loyalty points" payment method exists (and is active) while the programme is on
    await this.loyaltyService.ensurePaymentMethod(
      tenantId,
      this.dataSource.manager,
    );
    // On account, gift card and store credit tenders exist from the start
    for (const code of [
      ON_ACCOUNT_CODE,
      GIFT_CARD_CODE,
      STORE_CREDIT_CODE,
    ] as const) {
      await ensureSpecialMethod(this.dataSource.manager, tenantId, code);
    }
    const [settings, taxRate, registers, paymentMethods, categories] =
      await Promise.all([
        this.settingsService.getSettings(tenantId),
        this.settingsService.getDefaultTaxRate(tenantId),
        // Only the tills of the user's branches (spec §9)
        this.dataSource.getRepository(Register).find({
          where: {
            tenantId,
            status: RegisterStatus.ACTIVE,
            ...branchWhere(),
          },
          relations: { branch: true },
          order: { code: 'ASC' },
        }),
        this.dataSource.getRepository(PaymentMethod).find({
          where: { tenantId, status: PaymentMethodStatus.ACTIVE },
          order: { code: 'ASC' },
        }),
        this.dataSource.getRepository(Category).find({
          where: { tenantId, isActive: true },
          order: { sortOrder: 'ASC', code: 'ASC' },
        }),
      ]);

    return {
      settings,
      taxRate: taxRate ? Number(taxRate.rate) : 0,
      registers,
      // Exchange credit is only used by the exchange flow, never offered as a tender
      paymentMethods: paymentMethods.filter((m) => !m.settings?.hidden),
      categories,
    };
  }

  /**
   * Sellable variants with their current price and stock at the register's location
   */
  async getCatalog(
    tenantId: string,
    query: CatalogQueryDto,
  ): Promise<CatalogItem[]> {
    // The register decides the branch assortment, prices and stock location
    const register = query.registerId
      ? await this.dataSource
          .getRepository(Register)
          .findOne({ where: { id: query.registerId, tenantId } })
      : null;
    // Another branch's till (and its stock) is not visible
    if (register)
      assertBranchAccess(null, register.branchId, 'Register not found');

    const qb = this.dataSource
      .getRepository(ProductVariant)
      .createQueryBuilder('variant')
      .innerJoinAndSelect('variant.product', 'product')
      .leftJoinAndSelect('product.unit', 'unit')
      .where('variant.tenantId = :tenantId', { tenantId })
      .andWhere('variant.status = :active', { active: VariantStatus.ACTIVE })
      .andWhere('product.status = :productActive', {
        productActive: ProductStatus.ACTIVE,
      })
      .orderBy('product.name', 'ASC')
      .addOrderBy('variant.sortOrder', 'ASC')
      .take(query.limit ?? 100);

    if (register?.branchId) {
      // Products outside the branch's assortment are not sold at this till
      qb.andWhere(soldAtBranchSql('product'), { branchId: register.branchId });
    }
    // Weighted / price-embedded label (GS1 prefixes 20–29): look the PLU up
    const scan = looksWeighted(query.barcode)
      ? parseWeightedBarcode(
          query.barcode,
          weightedBarcodeSettings(
            await this.settingsService.getSettings(tenantId),
          ),
        )
      : null;
    if (scan?.ok) {
      const byPlu = qb.clone().andWhere('variant.pluCode = :plu', {
        plu: scan.plu,
      });
      const found = await byPlu.getMany();
      if (found.length > 0) {
        const items = await this.toCatalogItems(tenantId, found, register);
        return items.map((item) => ({
          ...item,
          scan: {
            barcode: query.barcode!.trim(),
            ...scannedQuantity(scan, item.price, item.unit?.precision ?? 0),
          },
        }));
      }
      // Unknown PLU: maybe an ordinary barcode starting with 2x
    }
    if (query.barcode) {
      // Scans are normalized like stored barcodes (spaces removed, letters
      // upper-cased); the SKU is matched as typed
      const barcode = normalizeBarcode(query.barcode) ?? query.barcode.trim();
      qb.andWhere(
        `(variant.barcode = :barcode OR variant.sku = :rawCode OR EXISTS (
          SELECT 1 FROM product_barcodes pb
          WHERE pb."variantId" = variant.id AND pb."tenantId" = variant."tenantId" AND pb.barcode = :barcode))`,
        { barcode, rawCode: query.barcode.trim() },
      );
    }
    if (query.search) {
      qb.andWhere(
        `(variant.sku ILIKE :search OR variant.barcode ILIKE :search
          OR product.name::text ILIKE :search OR variant.name::text ILIKE :search)`,
        { search: containsPattern(query.search) },
      );
    }
    if (query.categoryId) {
      qb.andWhere('product.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }

    const items = await this.toCatalogItems(
      tenantId,
      await qb.getMany(),
      register,
    );
    if (scan && !scan.ok && items.length === 0) {
      throw new BadRequestException(
        'The check digit of this weighted barcode is wrong: scan it again',
      );
    }
    return items;
  }

  /**
   * Current sellable state of the given variants at a register (same rules as
   * the catalog: active, sold at the register's branch). Used by the sync
   * delta: variants missing from the result are tombstones for the till.
   */
  async catalogItemsFor(
    tenantId: string,
    variantIds: string[],
    register: Register | null,
  ): Promise<CatalogItem[]> {
    if (variantIds.length === 0) return [];
    const variants = (
      await this.dataSource.getRepository(ProductVariant).find({
        where: { tenantId, id: In(variantIds) },
        relations: VARIANT_UNIT_RELATIONS,
      })
    ).filter(
      (v) =>
        v.status === VariantStatus.ACTIVE &&
        v.product?.status === ProductStatus.ACTIVE,
    );
    if (variants.length === 0) return [];
    let sellable = variants;
    if (register?.branchId) {
      const rows = await this.dataSource.query<
        { productId: string; branchId: string }[]
      >(
        `SELECT "productId", "branchId" FROM product_branches WHERE "productId" = ANY($1)`,
        [[...new Set(variants.map((v) => v.productId))]],
      );
      const assortment = new Map<string, string[]>();
      rows.forEach((r) =>
        assortment.set(r.productId, [
          ...(assortment.get(r.productId) ?? []),
          r.branchId,
        ]),
      );
      sellable = variants.filter((v) =>
        isSoldAtBranch(assortment.get(v.productId), register.branchId),
      );
    }
    return this.toCatalogItems(tenantId, sellable, register);
  }

  private async toCatalogItems(
    tenantId: string,
    variants: ProductVariant[],
    register: Register | null,
  ): Promise<CatalogItem[]> {
    if (variants.length === 0) return [];
    const prices = await this.pricingService.resolvePrices(tenantId, variants, {
      branchId: register?.branchId,
    });

    const stock = new Map<string, number>();
    if (register?.defaultLocationId) {
      const levels = await this.dataSource.getRepository(StockLevel).find({
        where: variants.map((v) => ({
          tenantId,
          variantId: v.id,
          locationId: register.defaultLocationId,
        })),
      });
      levels.forEach((level) =>
        stock.set(
          level.variantId,
          subQty(level.quantityOnHand, level.quantityReserved ?? 0),
        ),
      );
    }

    const tax = await this.taxResolver.load(
      tenantId,
      variants.map((v) => v.product.taxCategoryId),
    );

    return variants.map((variant) => {
      const stockTracked = variant.product.isStockTracked !== false;
      return {
        variantId: variant.id,
        productId: variant.productId,
        categoryId: variant.product.categoryId ?? null,
        productName: variant.product.name?.en ?? variant.sku,
        variantName: variant.name?.en ?? null,
        sku: variant.sku,
        barcode: variant.barcode ?? null,
        price: prices.get(variant.id) ?? 0,
        stock:
          register?.defaultLocationId && stockTracked
            ? (stock.get(variant.id) ?? 0)
            : null,
        stockTracked,
        allowBackorder: variant.product.allowBackorder,
        imageUrl: variant.imageUrl ?? null,
        taxRate: tax.rateFor(variant.product.taxCategoryId),
        unit: catalogUnit(unitOfVariant(variant)),
        pluCode: variant.pluCode ?? null,
      };
    });
  }

  /**
   * Prices of variants for a customer at a register: their group's price list
   * applies automatically (as in a sale), and the group's discount is returned
   * for the till to show and apply. Without a customer, the prices for everyone.
   */
  async customerPrices(tenantId: string, dto: PosPricesDto) {
    const register = await this.dataSource
      .getRepository(Register)
      .findOne({ where: { id: dto.registerId, tenantId } });
    if (!register) throw new NotFoundException('Register not found');
    assertBranchAccess(null, register.branchId, 'Register not found');
    let groupId: string | null = null;
    if (dto.customerId) {
      const customer = await this.dataSource.getRepository(Customer).findOne({
        where: { id: dto.customerId, tenantId },
        select: { id: true, groupId: true },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      groupId = customer.groupId;
    }
    const group = await this.pricingService.customerGroupPricing(
      tenantId,
      groupId,
    );
    const ids = [...new Set(dto.variantIds)];
    const variants = ids.length
      ? await this.dataSource.getRepository(ProductVariant).find({
          where: { tenantId, id: In(ids) },
          select: { id: true, price: true },
        })
      : [];
    const prices = await this.pricingService.resolvePrices(tenantId, variants, {
      branchId: register.branchId,
      priceListId: group?.priceListId ?? undefined,
    });
    return {
      customerGroup: group,
      prices: Object.fromEntries(prices),
    };
  }

  /**
   * Staff a sale can be credited to (salesperson picker at the till)
   */
  getStaff(tenantId: string): Promise<StaffMember[]> {
    return sellingStaff(this.dataSource.manager, tenantId);
  }
}
