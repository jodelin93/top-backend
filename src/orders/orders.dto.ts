import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
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
import { CartDiscountInput, SaleItemInput } from '../sales/sales.dto';
import { CustomerOrderStatus } from '../database/entities/customer-order.entity';

const MAX_MONEY = 999_999_999;

/** Money received for an order (or given back when it is cancelled) */
export class OrderPaymentInput {
  @IsUUID() paymentMethodId: string;
  // In the order currency (recomputed from tenderedAmount when paid in another)
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(MAX_MONEY) amount: number;
  @IsString() @IsOptional() @MaxLength(255) reference?: string;
  // Paid in another accepted currency: the amount handed over in it
  @IsString() @IsOptional() @Length(3, 3) currencyCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsOptional()
  @Min(0.01)
  @Max(MAX_MONEY)
  tenderedAmount?: number;
}

/** The cart of an order, priced like the till (no discount codes, no gift cards) */
export class QuoteOrderDto {
  @IsUUID() registerId: string;
  @IsUUID() customerId: string;
  @IsUUID() @IsOptional() priceListId?: string;

  @ValidateNested()
  @Type(() => CartDiscountInput)
  @IsOptional()
  cartDiscount?: CartDiscountInput;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SaleItemInput)
  items: SaleItemInput[];
}

export class CreateOrderDto extends QuoteOrderDto {
  // When the customer is told to come back (store's day)
  @IsDateString() @IsOptional() readyBy?: string;
  @IsString() @IsOptional() @MaxLength(1000) notes?: string;

  // The deposit taken now (none: the customer pays everything at pickup)
  @ValidateNested()
  @Type(() => OrderPaymentInput)
  @IsOptional()
  deposit?: OrderPaymentInput;

  // Client-generated key; resubmitting the same key returns the order taken
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;
}

export class AddDepositDto extends OrderPaymentInput {
  // The till taking it (cash goes into its open session)
  @IsUUID() registerId: string;
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;
}

export class UpdateOrderDto {
  @IsDateString() @IsOptional() readyBy?: string | null;
  @IsString() @IsOptional() @MaxLength(1000) notes?: string | null;
}

export class SetOrderStatusDto {
  // ready: prepared, waiting for the customer; open: back in preparation
  @IsIn([CustomerOrderStatus.OPEN, CustomerOrderStatus.READY])
  status: CustomerOrderStatus.OPEN | CustomerOrderStatus.READY;
}

export class CancelOrderDto {
  @IsString() @Length(3, 500) reason: string;
  // What happens to the deposits: given back, or kept by the store
  @IsIn(['refund', 'keep']) deposits: 'refund' | 'keep';
  // Refund: how the money goes back (cash comes out of the till's open session)
  @IsUUID() @IsOptional() refundMethodId?: string;
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @IsOptional() @MaxLength(255) reference?: string;
}

export class ListOrdersQueryDto {
  // "active": in preparation or ready (the till's list)
  @IsIn([...Object.values(CustomerOrderStatus), 'active'])
  @IsOptional()
  status?: CustomerOrderStatus | 'active';
  @IsUUID() @IsOptional() branchId?: string;
  @IsUUID() @IsOptional() customerId?: string;
  // Order number, customer name, code or phone
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class OrderPaymentsQueryDto {
  @IsDateString() from: string;
  @IsDateString() to: string;
  @IsUUID() @IsOptional() branchId?: string;
  @IsEnum(['deposit', 'refund']) @IsOptional() type?: 'deposit' | 'refund';
}
