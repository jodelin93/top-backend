import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsDateString,
  IsIn,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { BranchStatus } from '../../database/entities/branch.entity';
import {
  DrawerPolicy,
  RegisterStatus,
} from '../../database/entities/register.entity';
import {
  PaymentMethodStatus,
  PaymentMethodType,
} from '../../database/entities/payment-method.entity';
import {
  TaxRateStatus,
  TaxRateType,
} from '../../database/entities/tax-rate.entity';
import {
  WarehouseStatus,
  WarehouseType,
} from '../../database/entities/warehouse.entity';
import {
  LocationStockStatus,
  LocationType,
} from '../../database/entities/inventory-location.entity';

// Empty, an https URL, or http on localhost (local development storage)
const LOGO_URL =
  /^(?:https:\/\/[^\s"'<>\\]+|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s"'<>\\]*)?$/i;

// ---- Store-wide settings (stored in tenants.settings) ----

export class UpdateStoreSettingsDto {
  @IsString()
  @IsOptional()
  @MaxLength(255)
  storeName?: string;

  @IsString()
  @IsOptional()
  @Length(3, 3)
  currencyCode?: string;

  @IsBoolean()
  @IsOptional()
  pricesIncludeTax?: boolean;

  @IsUUID()
  @IsOptional()
  defaultTaxRateId?: string | null;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  receiptHeader?: string;

  @IsString()
  @IsOptional()
  @MaxLength(500)
  receiptFooter?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  lowStockThreshold?: number;

  // ---- Till ----
  // Largest line/cart discount (%) without pos.discount.override or a manager approval
  @IsNumber() @IsOptional() @Min(0) @Max(100) maxDiscountPercent?: number;
  @IsIn(['58mm', '80mm', 'a4', 'letter']) @IsOptional() receiptFormat?:
    '58mm' | '80mm' | 'a4' | 'letter';
  // Held carts (and their stock reservations) expire after this many hours
  @IsNumber() @IsOptional() @Min(1) @Max(168) heldCartExpiryHours?: number;
  // Selling needs an open shift on the register
  @IsBoolean() @IsOptional() requireOpenShift?: boolean;
  // Hour the trading day starts (0-23): sales and shifts before it count for the previous day
  @IsInt() @IsOptional() @Min(0) @Max(23) businessDayCutoffHour?: number;
  // Sales totalling 0.00 complete without payment (needs pos.discount.override)
  @IsBoolean() @IsOptional() allowZeroValueSales?: boolean;
  // Days after a sale during which it can be returned
  @IsNumber() @IsOptional() @Min(0) @Max(3650) returnWindowDays?: number;

  // ---- Cash ----
  // Shift close variance (absolute amount) above which a manager must approve
  @IsNumber() @IsOptional() @Min(0) shiftVarianceTolerance?: number;
  // Expenses above this amount need expenses.approve (0 = all need approval)
  @IsNumber() @IsOptional() @Min(0) expenseApprovalThreshold?: number;

  // ---- Inventory & purchasing ----
  @IsIn(['average', 'fifo']) @IsOptional() costingMethod?: 'average' | 'fifo';
  // Purchase orders above this total need purchasing.approve (0 = all)
  @IsNumber() @IsOptional() @Min(0) purchaseApprovalThreshold?: number;
  // Over-receipt allowed without purchasing.approve, in % of the ordered quantity
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(1000)
  purchaseOverReceiptTolerance?: number;
  // Invoice price variance (%) accepted without purchasing.approve
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  purchaseInvoiceVarianceTolerance?: number;
  // Stock count variances above this many units need inventory.count.approve
  @IsNumber() @IsOptional() @Min(0) countVarianceTolerance?: number;
  // Transfers needing inventory.transfer.approve: never, above the threshold (value at cost), always
  @IsIn(['never', 'threshold', 'always']) @IsOptional() transferApprovalMode?:
    'never' | 'threshold' | 'always';
  @IsNumber() @IsOptional() @Min(0) transferApprovalThreshold?: number;
  // % over the dispatched quantity a receipt may be without approval
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(100)
  transferOverReceiptTolerancePercent?: number;

  // ---- Offline & security ----
  // How long a till may keep selling offline after its last sync
  @IsNumber() @IsOptional() @Min(1) @Max(168) offlineLeaseHours?: number;
  // Offline limits carried by the till's lease (0 = no limit)
  @IsNumber() @IsOptional() @Min(0) offlineMaxSaleAmount?: number;
  @IsInt() @IsOptional() @Min(0) @Max(100_000) offlineMaxSales?: number;
  @IsNumber() @IsOptional() @Min(0) offlineMaxTotal?: number;
  // Gift cards expire this many months after sale (0 = never)
  @IsInt() @IsOptional() @Min(0) @Max(120) giftCardExpiryMonths?: number;
  // Staff with admin permissions must turn on two-factor authentication
  @IsBoolean() @IsOptional() requireMfaForAdmins?: boolean;

  // ---- Business information (printed on receipts and invoices) ----
  @IsString() @IsOptional() @MaxLength(255) businessLegalName?: string;
  @IsString() @IsOptional() @MaxLength(255) businessAddressLine1?: string;
  @IsString() @IsOptional() @MaxLength(255) businessAddressLine2?: string;
  @IsString() @IsOptional() @MaxLength(100) businessCity?: string;
  @IsString() @IsOptional() @MaxLength(100) businessState?: string;
  @IsString() @IsOptional() @MaxLength(20) businessPostalCode?: string;
  @IsString() @IsOptional() @MaxLength(100) businessCountry?: string;
  @IsString() @IsOptional() @MaxLength(50) businessPhone?: string;
  @IsString() @IsOptional() @MaxLength(255) businessEmail?: string;
  @IsString() @IsOptional() @MaxLength(255) businessWebsite?: string;
  // Tax / VAT identification number (NIF, TIN, VAT no.)
  @IsString() @IsOptional() @MaxLength(100) businessTaxId?: string;
  // Company registration number (RCS, company no.)
  @IsString() @IsOptional() @MaxLength(100) businessRegistrationNumber?: string;
  // Set by the logo upload; clients may only clear it or send back an https URL
  // (plain http only for a local development API on localhost / 127.0.0.1)
  @IsString()
  @IsOptional()
  @MaxLength(500)
  @Matches(LOGO_URL, {
    message: 'businessLogoUrl must be empty or an https URL',
  })
  businessLogoUrl?: string;
  @IsString() @IsOptional() @MaxLength(1000) returnPolicy?: string;

  // ---- Receipts & printing ----
  // Layout: classic (full detail), compact (short, saves paper), modern (spaced, bold totals)
  @IsIn(['classic', 'compact', 'modern']) @IsOptional() receiptTemplate?:
    'classic' | 'compact' | 'modern';
  @IsBoolean() @IsOptional() receiptShowLogo?: boolean;
  @IsBoolean() @IsOptional() receiptShowBusinessDetails?: boolean;
  @IsBoolean() @IsOptional() receiptShowTaxBreakdown?: boolean;
  @IsBoolean() @IsOptional() receiptShowSku?: boolean;
  @IsBoolean() @IsOptional() receiptShowCashier?: boolean;
  @IsBoolean() @IsOptional() receiptShowCustomer?: boolean;
  @IsBoolean() @IsOptional() receiptShowLoyalty?: boolean;
  @IsBoolean() @IsOptional() receiptShowBarcode?: boolean;
  @IsBoolean() @IsOptional() receiptShowReturnPolicy?: boolean;
  @IsIn(['small', 'normal', 'large']) @IsOptional() receiptFontSize?:
    'small' | 'normal' | 'large';
  // Print the receipt as soon as a sale completes
  @IsBoolean() @IsOptional() autoPrintReceipt?: boolean;
  @IsInt() @IsOptional() @Min(1) @Max(3) receiptCopies?: number;

  // ---- Loyalty (fidelity points) ----
  @IsBoolean() @IsOptional() loyaltyEnabled?: boolean;
  // Customers earn points worth this % of what they pay
  @IsNumber() @IsOptional() @Min(0) @Max(100) loyaltyEarnPercent?: number;
  // Money value of one point when spent (e.g. 0.01 = 100 points for 1.00)
  @IsNumber() @IsOptional() @Min(0.0001) @Max(1000) loyaltyPointValue?: number;
  // Fewest points a customer can spend at once
  @IsInt() @IsOptional() @Min(0) loyaltyMinRedeemPoints?: number;
  // Largest share of a sale that can be paid with points
  @IsNumber() @IsOptional() @Min(0) @Max(100) loyaltyMaxRedeemPercent?: number;

  // ---- Currencies ----
  // Other currencies customers may pay with: units of each per 1 unit of currencyCode,
  // e.g. { "HTG": 132.5 }. An empty object accepts the store currency only.
  @IsObject() @IsOptional() exchangeRates?: Record<string, number>;
  // Default language of the app for the store (each user can still choose their own)
  @IsIn(['en', 'fr', 'ht', 'es']) @IsOptional() language?:
    'en' | 'fr' | 'ht' | 'es';

  // ---- Weighted / price-embedded barcodes (GS1 variable measure) ----
  // Prefixes 20–29 read as scale labels; empty = off
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(10)
  @Matches(/^2\d$/, { each: true, message: 'Prefixes must be 20 to 29' })
  weightedBarcodePrefixes?: string[];
  @IsIn(['weight', 'price']) @IsOptional() weightedBarcodeLayout?:
    'weight' | 'price';
  // PLU digits after the prefix (the value takes the rest of the 12 digits)
  @IsInt() @IsOptional() @Min(4) @Max(6) weightedBarcodeItemCodeLength?: number;
  @IsInt() @IsOptional() @Min(0) @Max(3) weightedBarcodeValueDecimals?: number;
  // ---- Versioning ----
  // Future date: schedule the change instead of applying it now
  @IsDateString() @IsOptional() effectiveFrom?: string;
  // Shown in the settings history
  @IsString() @IsOptional() @MaxLength(255) note?: string;
}

// ---- Branches ----

export class CreateBranchDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsString() @IsOptional() @MaxLength(255) addressLine1?: string;
  @IsString() @IsOptional() @MaxLength(255) addressLine2?: string;
  @IsString() @IsOptional() @MaxLength(100) city?: string;
  @IsString() @IsOptional() @MaxLength(100) stateProvince?: string;
  @IsString() @IsOptional() @MaxLength(20) postalCode?: string;
  @IsString() @IsOptional() @Length(2, 2) countryCode?: string;
  @IsString() @IsOptional() @MaxLength(50) phone?: string;
  @IsString() @IsOptional() @MaxLength(255) email?: string;
  @IsString() @IsOptional() @MaxLength(50) timezone?: string;
  @IsString() @Length(3, 3) currencyCode: string;
  @IsString() @IsOptional() @MaxLength(50) taxNumber?: string;
}

export class SetBranchWarehousesDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  warehouseIds: string[];
}

export class UpdateBranchDto extends PartialType(CreateBranchDto) {
  @IsEnum(BranchStatus) @IsOptional() status?: BranchStatus;
}

// ---- Registers ----

export class CreateRegisterDto {
  @IsUUID() branchId: string;
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsUUID() @IsOptional() defaultLocationId?: string;
  // assigned: one cashier per drawer shift; shared: cashiers share the drawer's shift
  @IsEnum(DrawerPolicy) @IsOptional() drawerPolicy?: DrawerPolicy;
}

export class UpdateRegisterDto extends PartialType(CreateRegisterDto) {
  @IsEnum(RegisterStatus) @IsOptional() status?: RegisterStatus;
}

// ---- Warehouses & locations ----

export class CreateWarehouseDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsEnum(WarehouseType) @IsOptional() warehouseType?: WarehouseType;
  @IsString() @IsOptional() @MaxLength(255) addressLine1?: string;
  @IsString() @IsOptional() @MaxLength(100) city?: string;
  @IsString() @IsOptional() @Length(2, 2) countryCode?: string;
}

export class UpdateWarehouseDto extends PartialType(CreateWarehouseDto) {
  @IsEnum(WarehouseStatus) @IsOptional() status?: WarehouseStatus;
}

export class CreateLocationDto {
  @IsUUID() warehouseId: string;
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsString() @IsOptional() @MaxLength(100) name?: string;
  @IsEnum(LocationType) @IsOptional() locationType?: LocationType;
  // Legacy: prefer stockStatus (isSellable follows it)
  @IsBoolean() @IsOptional() isSellable?: boolean;
  // sellable | quarantine | damaged (transit locations are created by the system)
  @IsIn([
    LocationStockStatus.SELLABLE,
    LocationStockStatus.QUARANTINE,
    LocationStockStatus.DAMAGED,
  ])
  @IsOptional()
  stockStatus?: LocationStockStatus;
}

export class UpdateLocationDto extends PartialType(CreateLocationDto) {}

// ---- Payment methods ----

export class CreatePaymentMethodDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsObject() name: Record<string, string>;
  @IsEnum(PaymentMethodType) methodType: PaymentMethodType;
  @IsBoolean() @IsOptional() requiresReference?: boolean;
  @IsBoolean() @IsOptional() opensDrawer?: boolean;
}

export class UpdatePaymentMethodDto extends PartialType(
  CreatePaymentMethodDto,
) {
  @IsEnum(PaymentMethodStatus) @IsOptional() status?: PaymentMethodStatus;
}

// ---- Tax rates ----

export class CreateTaxRateDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsObject() name: Record<string, string>;
  @IsEnum(TaxRateType) @IsOptional() taxType?: TaxRateType;
  @IsNumber() @Min(0) @Max(100) rate: number;
  @IsString() @IsOptional() @Length(2, 2) countryCode?: string;
  @IsString() @IsOptional() @MaxLength(100) stateProvince?: string;
  @IsBoolean() @IsOptional() isDefault?: boolean;
}

export class UpdateTaxRateDto extends PartialType(CreateTaxRateDto) {
  @IsEnum(TaxRateStatus) @IsOptional() status?: TaxRateStatus;
}
