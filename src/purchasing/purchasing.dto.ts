import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsQuantity } from '../common/dto/quantity.decorator';
import { SupplierStatus } from '../database/entities/supplier.entity';
import { PurchaseOrderStatus } from '../database/entities/purchase-order.entity';
import {
  IsNotFutureDate,
  IsOnOrAfterField,
} from '../common/validation/date-rules';

const upper = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

// ---- Suppliers ----

export class SupplierContactDto {
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsEmail() @IsOptional() @MaxLength(255) email?: string | null;
  @IsString() @IsOptional() @MaxLength(50) phone?: string | null;
  @IsString() @IsOptional() @MaxLength(100) role?: string | null;
}

export class CreateSupplierDto {
  @Transform(upper)
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  code: string;

  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsString() @IsOptional() @MaxLength(255) contactPerson?: string | null;
  @IsEmail() @IsOptional() @MaxLength(255) email?: string | null;
  @IsString() @IsOptional() @MaxLength(50) phone?: string | null;
  @IsString() @IsOptional() @MaxLength(255) addressLine1?: string | null;
  @IsString() @IsOptional() @MaxLength(255) addressLine2?: string | null;
  @IsString() @IsOptional() @MaxLength(100) city?: string | null;
  @IsString() @IsOptional() @MaxLength(100) stateProvince?: string | null;
  @IsString() @IsOptional() @MaxLength(20) postalCode?: string | null;

  @Transform(upper)
  @IsString()
  @IsOptional()
  @Length(2, 2)
  countryCode?: string | null;

  @IsString() @IsOptional() @MaxLength(100) taxNumber?: string | null;

  // Net payment days
  @IsInt() @IsOptional() @Min(0) paymentTermDays?: number | null;
  // Usual days from order to delivery
  @IsInt() @IsOptional() @Min(0) @Max(365) leadTimeDays?: number | null;

  @Transform(upper)
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be an ISO 4217 code' })
  currencyCode?: string | null;

  @IsString() @IsOptional() @MaxLength(5000) notes?: string | null;

  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SupplierContactDto)
  contacts?: SupplierContactDto[];

  // Inactive / blocked suppliers cannot get new purchase orders
  @IsEnum(SupplierStatus) @IsOptional() status?: SupplierStatus;
}

export class UpdateSupplierDto {
  @Transform(upper)
  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(50)
  code?: string;

  @IsString() @IsOptional() @MinLength(1) @MaxLength(255) name?: string;
  @IsString() @IsOptional() @MaxLength(255) contactPerson?: string | null;
  @IsEmail() @IsOptional() @MaxLength(255) email?: string | null;
  @IsString() @IsOptional() @MaxLength(50) phone?: string | null;
  @IsString() @IsOptional() @MaxLength(255) addressLine1?: string | null;
  @IsString() @IsOptional() @MaxLength(255) addressLine2?: string | null;
  @IsString() @IsOptional() @MaxLength(100) city?: string | null;
  @IsString() @IsOptional() @MaxLength(100) stateProvince?: string | null;
  @IsString() @IsOptional() @MaxLength(20) postalCode?: string | null;

  @Transform(upper)
  @IsString()
  @IsOptional()
  @Length(2, 2)
  countryCode?: string | null;

  @IsString() @IsOptional() @MaxLength(100) taxNumber?: string | null;
  @IsInt() @IsOptional() @Min(0) paymentTermDays?: number | null;
  @IsInt() @IsOptional() @Min(0) @Max(365) leadTimeDays?: number | null;

  @Transform(upper)
  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be an ISO 4217 code' })
  currencyCode?: string | null;

  @IsString() @IsOptional() @MaxLength(5000) notes?: string | null;

  @IsArray()
  @IsOptional()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SupplierContactDto)
  contacts?: SupplierContactDto[];

  @IsEnum(SupplierStatus) @IsOptional() status?: SupplierStatus;
}

// What a supplier sells: their code, last cost, minimum order quantity
export class SupplierProductDto {
  @IsUUID() variantId: string;
  @IsString() @IsOptional() @MaxLength(100) supplierSku?: string | null;
  @IsNumber({ maxDecimalPlaces: 4 }) @IsOptional() @Min(0) lastCost?:
    number | null;
  @IsInt() @IsOptional() @Min(1) minOrderQty?: number | null;
  // Used for reorder suggestions (one preferred supplier per variant)
  @IsBoolean() @IsOptional() isPreferred?: boolean;
}

// Replaces the supplier's whole product list
export class SaveSupplierProductsDto {
  @IsArray()
  @ArrayMaxSize(2000)
  @ValidateNested({ each: true })
  @Type(() => SupplierProductDto)
  items: SupplierProductDto[];
}

// ---- Purchase orders ----

export class PurchaseOrderLineDto {
  @IsUUID() variantId: string;
  // Decimals for measured items (kg, m, l)
  @IsQuantity() quantityOrdered: number;
  // Before the line discount
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost: number;
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(100)
  discountPercent?: number;
  // Tax charged on the line
  @IsNumber({ maxDecimalPlaces: 2 }) @IsOptional() @Min(0) taxAmount?: number;
  // e.g. "each", "case of 12"
  @IsString() @IsOptional() @MaxLength(30) unitOfMeasure?: string | null;
  // Defaults to the supplier's code for the variant (supplier products)
  @IsString() @IsOptional() @MaxLength(100) supplierSku?: string | null;
  @IsString() @IsOptional() @MaxLength(255) notes?: string;
}

export class SavePurchaseOrderDto {
  @IsUUID() supplierId: string;
  // Destination: where the goods will be received
  @IsUUID() locationId: string;

  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  @IsOptional()
  // Not in the past: checked by the service when the date is set or changed
  expectedDeliveryDate?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 }) @IsOptional() @Min(0) taxAmount?: number;
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsOptional()
  @Min(0)
  shippingCost?: number;

  @IsString() @IsOptional() @MaxLength(500) notes?: string | null;

  // Supplier's own reference (order confirmation / quote number)
  @IsString() @IsOptional() @MaxLength(100) supplierReference?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => PurchaseOrderLineDto)
  items: PurchaseOrderLineDto[];
}

// Change an approved / issued order: recorded as a revision
export class RevisePurchaseOrderDto extends SavePurchaseOrderDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

// Short-close: the reason is required
export class ClosePurchaseOrderDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

export class PurchaseOrdersQueryDto {
  @IsEnum(PurchaseOrderStatus) @IsOptional() status?: PurchaseOrderStatus;
  @IsUUID() @IsOptional() supplierId?: string;
  @IsString() @IsOptional() @MaxLength(100) search?: string;
}

export class ReasonDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}

export class ReceiptLineDto {
  @IsUUID() purchaseOrderItemId: string;
  // Units in good condition
  @IsQuantity({ min: 0 }) quantity: number;
  // Damaged units: put into stock only when accepted, otherwise only recorded
  @IsQuantity({ min: 0 }) @IsOptional() damagedQuantity?: number;
  @IsBoolean() @IsOptional() damagedAccepted?: boolean;
  // Defaults to the order line's net unit cost
  @IsNumber({ maxDecimalPlaces: 4 }) @IsOptional() @Min(0) unitCost?: number;
}

export class ReceivePurchaseOrderDto {
  // Client-generated (e.g. a UUID) once per receipt; retries reuse it
  @IsString() @MinLength(8) @MaxLength(100) idempotencyKey: string;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiptLineDto)
  items: ReceiptLineDto[];
}

// ---- Unplanned receipts (no purchase order) ----

export class UnplannedReceiptLineDto {
  @IsUUID() variantId: string;
  @IsQuantity({ min: 0 }) quantity: number;
  @IsQuantity({ min: 0 }) @IsOptional() damagedQuantity?: number;
  @IsBoolean() @IsOptional() damagedAccepted?: boolean;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitCost: number;
}

export class UnplannedReceiptDto {
  @IsUUID() supplierId: string;
  @IsUUID() locationId: string;
  @IsString() @MinLength(8) @MaxLength(100) idempotencyKey: string;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => UnplannedReceiptLineDto)
  items: UnplannedReceiptLineDto[];
}

export class ReceiptsQueryDto {
  @IsUUID() @IsOptional() supplierId?: string;
  @IsUUID() @IsOptional() purchaseOrderId?: string;
  @IsString() @IsOptional() @MaxLength(100) search?: string;
}

// ---- Supplier returns ----

export class SupplierReturnLineDto {
  @IsUUID() receiptItemId: string;
  @IsQuantity({ min: 0 }) quantity: number;
}

export class CreateSupplierReturnDto {
  @IsUUID() receiptId: string;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
  // Supplier's return authorisation (RMA) number
  @IsString() @IsOptional() @MaxLength(100) reference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SupplierReturnLineDto)
  items: SupplierReturnLineDto[];
}

export class SupplierDocumentsQueryDto {
  @IsUUID() @IsOptional() supplierId?: string;
  @IsString() @IsOptional() @MaxLength(30) status?: string;
  @IsUUID() @IsOptional() purchaseOrderId?: string;
}

// ---- Supplier invoices ----

export const SUPPLIER_INVOICE_TYPES = ['standard', 'opening_balance'] as const;

export class SupplierInvoiceLineDto {
  // Matched order line (3-way match); omit for charges not on the order
  @IsUUID() @IsOptional() purchaseOrderItemId?: string;
  @IsUUID() @IsOptional() receiptItemId?: string;
  // Defaults to the order line's product name
  @IsString() @IsOptional() @MaxLength(255) description?: string;
  @IsQuantity() quantity: number;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) unitPrice: number;
  @IsNumber({ maxDecimalPlaces: 2 }) @IsOptional() @Min(0) taxAmount?: number;
}

export class CreateSupplierInvoiceDto {
  @IsUUID() supplierId: string;
  // The supplier's invoice number (unique per supplier)
  @IsString() @MinLength(1) @MaxLength(100) invoiceNumber: string;
  @IsIn(SUPPLIER_INVOICE_TYPES)
  @IsOptional()
  invoiceType?: (typeof SUPPLIER_INVOICE_TYPES)[number];
  @IsUUID() @IsOptional() purchaseOrderId?: string;
  @IsDateString() @IsNotFutureDate() invoiceDate: string;
  // Defaults to the invoice date + the supplier's payment terms
  @IsDateString()
  @IsOnOrAfterField('invoiceDate', {
    message: 'The due date cannot be before the invoice date',
  })
  @IsOptional()
  dueDate?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;
  // Opening balance only: the amount owed when starting with the system
  @IsNumber({ maxDecimalPlaces: 2 }) @IsOptional() @Min(0.01) amount?: number;

  @IsArray()
  @IsOptional()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SupplierInvoiceLineDto)
  items?: SupplierInvoiceLineDto[];
}

export class VoidDto {
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

// ---- Credits, payments, allocations ----

export class CreateSupplierCreditDto {
  @IsUUID() supplierId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  @IsDateString() @IsNotFutureDate() @IsOptional() creditDate?: string;
  // Supplier's credit note number
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  @IsString() @MinLength(1) @MaxLength(500) reason: string;
}

export class AllocationDto {
  @IsUUID() invoiceId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
}

export class AllocateDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations: AllocationDto[];
}

export const SUPPLIER_PAYMENT_METHODS = [
  'cash',
  'bank_transfer',
  'check',
  'card',
  'mobile_money',
  'other',
] as const;

export class CreateSupplierPaymentDto {
  @IsUUID() supplierId: string;
  // In the supplier's currency. Paid in another currency: worked out from tenderedAmount
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  // Paid in another currency than the supplier's (e.g. HTG): HTG → USD at the sell
  // rate, USD → HTG at the buy rate
  @Matches(/^[A-Z]{3}$/, { message: 'currencyCode must be an ISO 4217 code' })
  @IsOptional()
  currencyCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  tenderedAmount?: number;
  @IsIn(SUPPLIER_PAYMENT_METHODS)
  method: (typeof SUPPLIER_PAYMENT_METHODS)[number];
  @IsDateString() @IsNotFutureDate() @IsOptional() paymentDate?: string;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  // Invoices this payment settles (partly or fully); the rest stays unapplied
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AllocationDto)
  allocations?: AllocationDto[];
}

export class AgingQueryDto {
  // Defaults to today
  @IsDateString() @IsOptional() asOf?: string;
}

export class StatementQueryDto {
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOnOrAfterField('from') @IsOptional() to?: string;
}

// ---- Reorder suggestions ----

export class ReorderQueryDto {
  // Stock at this location only (default: all locations)
  @IsUUID() @IsOptional() locationId?: string;
  @IsUUID() @IsOptional() supplierId?: string;
}
