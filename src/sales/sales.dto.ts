import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  Matches,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsQuantity } from '../common/dto/quantity.decorator';
import { SaleStatus } from '../database/entities/sale.entity';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';

// Upper bound of any money amount in a request
const MAX_MONEY = 999_999_999;

export class SaleItemInput {
  @IsUUID() variantId: string;
  // Whole units, or up to the unit's precision for measured items (1.25 kg)
  @IsQuantity({ max: 100000 }) quantity: number;
  @IsNumber() @Min(0) @Max(100) @IsOptional() discountPercent?: number;
  // Price override: online it needs pos.price.override (or a manager approval);
  // for offline sales it is the price the customer actually paid
  // (prices are stored with 4 decimals: per-gram / per-cm prices)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_MONEY)
  @IsOptional()
  unitPrice?: number;
  // Why the line discount was given; required above the store's discount limit
  @IsString() @IsOptional() @MaxLength(255) discountReason?: string;
  // Free text printed under the line (e.g. "gift wrapped", a size note)
  @IsString() @IsOptional() @MaxLength(255) note?: string;
}

export class CartDiscountInput {
  @IsIn(['percentage', 'fixed']) type: 'percentage' | 'fixed';
  // Percent (≤ 100, checked when priced) or an amount
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_MONEY) value: number;
  // Why it was given; required above the store's discount limit
  @IsString() @IsOptional() @MaxLength(255) reason?: string;
}

export class PaymentInput {
  @IsUUID() paymentMethodId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_MONEY) amount: number;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  // Per-attempt key for provider payments (generated when omitted)
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;
  // Paid in another accepted currency: the amount handed over in that currency.
  // amount is then recomputed by the server from the store's exchange rate.
  @IsString() @IsOptional() @Length(3, 3) currencyCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsOptional()
  @Min(0.01)
  @Max(MAX_MONEY)
  tenderedAmount?: number;
  // Rate the till used; only honoured for offline sales uploaded by the till
  // (POST /sync/push), and only within 10% of the store's rate
  @IsNumber() @IsOptional() @Min(0.00000001) exchangeRate?: number;
  // GIFT_CARD tender: the card's code (only its hash is looked up, never stored)
  @IsString() @IsOptional() @MaxLength(64) giftCardCode?: string;
}

/** A gift card sold on the sale (a liability, not revenue: no tax, no discount) */
export class GiftCardLineInput {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(100000) amount: number;
  // Code of a pre-printed card; generated (and shown once) when omitted
  @IsString() @IsOptional() @MaxLength(64) code?: string;
}

export class QuoteSaleDto {
  @IsUUID() registerId: string;
  // Selling an estimate: its quoted prices and discounts need no new approval,
  // and the estimate is marked converted when the sale completes
  @IsUUID() @IsOptional() estimateId?: string;
  @IsUUID() @IsOptional() customerId?: string;
  @IsUUID() @IsOptional() priceListId?: string;
  @IsString() @IsOptional() @MaxLength(50) discountCode?: string;
  // Staff member credited with the sale (not necessarily the cashier)
  @IsUUID() @IsOptional() salespersonId?: string;

  @ValidateNested()
  @Type(() => CartDiscountInput)
  @IsOptional()
  cartDiscount?: CartDiscountInput;

  // May be empty when the sale only sells gift cards
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInput)
  items: SaleItemInput[];

  // Gift cards sold on this sale (online only)
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GiftCardLineInput)
  @IsOptional()
  giftCards?: GiftCardLineInput[];
}

export class CreateSaleDto extends QuoteSaleDto {
  // Empty only for a zero-value sale (allowZeroValueSales)
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PaymentInput)
  payments: PaymentInput[];

  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  // Client-generated key; resubmitting the same key returns the original sale
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;

  // Offline sales only (set by POST /sync/push; POST /sales refuses them):
  // when the sale was rung up
  @IsDateString() @IsOptional() offlineCapturedAt?: string;

  // Provisional receipt number printed while offline (OFFLINE-XXXXXXXX)
  @IsString()
  @IsOptional()
  @MaxLength(50)
  @Matches(/^OFFLINE-[A-Za-z0-9-]+$/)
  offlineNumber?: string;

  // Currency the change is handed back in (default: the sale currency)
  @IsString() @IsOptional() @Length(3, 3) changeCurrency?: string;

  // Device that recorded the sale and its per-device sequence number. Online the
  // X-Device-Id header is used instead; deviceSequence is offline only.
  @IsUUID() @IsOptional() deviceId?: string;
  @IsInt() @Min(0) @IsOptional() deviceSequence?: number;

  // Held (or resumed) cart this sale completes
  @IsUUID() @IsOptional() heldSaleId?: string;

  // AC05: the cart was repriced (resumed / stale cart) and the cashier confirmed
  // the new prices after seeing the before/after difference; kept for traceability
  @IsDateString() @IsOptional() repricedConfirmedAt?: string;
  // Cart total before the repricing the cashier confirmed
  @IsNumber() @Max(MAX_MONEY) @IsOptional() repricedPreviousTotal?: number;
}

export class HoldSaleDto extends QuoteSaleDto {
  // Replace this held/resumed cart instead of creating a new one
  @IsUUID() @IsOptional() heldSaleId?: string;
  // Shown in the held carts list, e.g. the customer's name
  @IsString() @IsOptional() @MaxLength(100) label?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;
}

export class HeldSalesQueryDto {
  @IsUUID() @IsOptional() registerId?: string;
  @IsUUID() @IsOptional() branchId?: string;
}

export class CancelSaleDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}

export class ListSalesQueryDto {
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
  @IsEnum(SaleStatus) @IsOptional() status?: SaleStatus;
  @IsUUID() @IsOptional() customerId?: string;
  @IsUUID() @IsOptional() registerId?: string;
  @IsUUID() @IsOptional() salespersonId?: string;
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class VoidSaleDto {
  @IsString() @MaxLength(500) reason: string;
}

export class CatalogQueryDto {
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @IsString() @IsOptional() @MaxLength(100) barcode?: string;
  @IsUUID() @IsOptional() categoryId?: string;
  @Transform(({ value }) => (value === undefined ? undefined : Number(value)))
  @IsInt()
  @Min(1)
  @Max(500)
  @IsOptional()
  limit?: number;
}

export class ListConflictCasesQueryDto {
  @IsIn(['open', 'resolved', 'dismissed']) @IsOptional() status?:
    'open' | 'resolved' | 'dismissed';
  @IsIn(Object.values(ConflictCaseType))
  @IsOptional()
  type?: ConflictCaseType;
  @IsUUID() @IsOptional() saleId?: string;
  // Cases raised by one till (sync dashboard link)
  @IsUUID() @IsOptional() deviceId?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class ResolveConflictCaseDto {
  // resolved: the problem was fixed (e.g. stock counted); dismissed: nothing to do
  @IsIn(['resolved', 'dismissed']) status: 'resolved' | 'dismissed';
  @IsString() @Length(1, 500) note: string;
}
