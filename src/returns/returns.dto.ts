import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
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
import { ReturnDisposition } from '../database/entities/sale-return-item.entity';
import {
  ReturnStatus,
  ReturnType,
} from '../database/entities/sale-return.entity';
import {
  CartDiscountInput,
  GiftCardLineInput,
  PaymentInput,
  SaleItemInput,
} from '../sales/sales.dto';

export class ReturnItemInput {
  @IsUUID() saleItemId: string;
  // Decimals for measured items (e.g. 0.5 of a 1.25 kg line)
  @IsQuantity({ max: 100000 }) quantity: number;
  @IsEnum(ReturnDisposition) disposition: ReturnDisposition;
  // Restock location; defaults to the register's stock location
  @IsUUID() @IsOptional() locationId?: string;
  @IsString() @IsOptional() @MaxLength(255) reason?: string;
}

export class RefundInput {
  @IsUUID() paymentMethodId: string;
  @IsNumber() @Min(0.01) amount: number;
}

export class CreateReturnDto {
  @IsUUID() saleId: string;
  @IsUUID() registerId: string;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;

  // goodwill: money back without goods (no items; sales.refund.goodwill or approval)
  @IsIn(['return', 'goodwill']) @IsOptional() type?: 'return' | 'goodwill';
  // Goodwill refund amount
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  goodwillAmount?: number;

  // Empty only for a goodwill refund
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemInput)
  items: ReturnItemInput[];

  // Refund the whole amount as store credit of the sale's customer (or customerId)
  @IsBoolean() @IsOptional() refundToStoreCredit?: boolean;
  // Customer who gets the store credit when the sale had none
  @IsUUID() @IsOptional() customerId?: string;

  // How to pay the refund; omitted = back to the original payments (card first, then cash)
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RefundInput)
  @IsOptional()
  refunds?: RefundInput[];

  // Refund the whole amount with this one method (the server fills in the exact total)
  @IsUUID() @IsOptional() refundMethodId?: string;

  // Client-generated, one per return attempt (required: a retried request without a key
  // would refund twice). Resubmitting the same key returns the original return; the
  // same key with a different request is rejected (409).
  @IsString() @Length(8, 100) idempotencyKey: string;
}

/** The replacement sale of an exchange (the till's sale request, without register) */
export class ExchangeSaleInput {
  @IsUUID() @IsOptional() customerId?: string;
  @IsUUID() @IsOptional() salespersonId?: string;
  @IsString() @IsOptional() @MaxLength(50) discountCode?: string;
  @ValidateNested()
  @Type(() => CartDiscountInput)
  @IsOptional()
  cartDiscount?: CartDiscountInput;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInput)
  items: SaleItemInput[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => GiftCardLineInput)
  @IsOptional()
  giftCards?: GiftCardLineInput[];

  // Tenders for the difference when the new sale costs more than the goods returned
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PaymentInput)
  payments: PaymentInput[];

  // Pay whatever difference is left with this method (the server works out the
  // exact amount from the priced replacement sale)
  @IsUUID() @IsOptional() differenceMethodId?: string;

  // Replacement worth less than the exchange credit: how the rest of the credit is
  // refunded (default: the original payments; another method may need
  // sales.refund.any_method or a manager; or the customer's store credit)
  @IsUUID() @IsOptional() creditRefundMethodId?: string;
  @IsBoolean() @IsOptional() creditToStoreCredit?: boolean;

  @IsString() @IsOptional() @MaxLength(500) notes?: string;
}

/**
 * An exchange: the return (goods back, refund plan for any difference owed to the
 * customer) and the replacement sale, in one request
 */
export class CreateExchangeDto {
  @IsUUID() saleId: string;
  @IsUUID() registerId: string;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemInput)
  items: ReturnItemInput[];

  // How a difference owed to the customer is refunded (default: original payments)
  @IsUUID() @IsOptional() refundMethodId?: string;
  @IsBoolean() @IsOptional() refundToStoreCredit?: boolean;

  @ValidateNested()
  @Type(() => ExchangeSaleInput)
  newSale: ExchangeSaleInput;

  // One per exchange attempt; resubmitting completes an incomplete exchange
  @IsString() @Length(8, 100) idempotencyKey: string;
}

/** POST /returns/exchanges/:id/complete : ring up the replacement sale again */
export class CompleteExchangeDto {
  @IsUUID() registerId: string;

  @ValidateNested()
  @Type(() => ExchangeSaleInput)
  newSale: ExchangeSaleInput;
}

/**
 * POST /returns/exchanges/:id/cancel : give up an incomplete exchange and refund
 * its credit (default: the original payments of the sale)
 */
export class CancelExchangeDto {
  @IsUUID() registerId: string;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
  @IsUUID() @IsOptional() refundMethodId?: string;
  @IsBoolean() @IsOptional() refundToStoreCredit?: boolean;
  // Customer who gets the store credit when the sale had none
  @IsUUID() @IsOptional() customerId?: string;
}

export class ListExchangesQueryDto {
  @IsIn(['pending', 'completed', 'incomplete', 'cancelled'])
  @IsOptional()
  status?: 'pending' | 'completed' | 'incomplete' | 'cancelled';
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class ListReturnsQueryDto {
  @IsEnum(ReturnType) @IsOptional() returnType?: ReturnType;
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
  @IsEnum(ReturnStatus) @IsOptional() status?: ReturnStatus;
  @IsUUID() @IsOptional() saleId?: string;
  // Return number or original sale number
  @IsString() @IsOptional() @MaxLength(50) search?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class SaleLookupQueryDto {
  // Sale number (S-000123) or offline number (OFFLINE-…)
  @IsString() @IsNotEmpty() @MaxLength(50) saleNumber: string;
}
