# Core Business Modules - Implementation Plan & Code Examples

## Overview

This document provides implementation patterns and code examples for all core business modules. Due to the extensive nature of these modules, I'm providing a comprehensive guide that you can use to implement each module systematically.

---

## ✅ Completed: Products Module

### Status: IMPLEMENTED

**Location**: `src/products/`

**Features Implemented**:
- ✅ Product CRUD operations
- ✅ Variant generation from attribute combinations
- ✅ SKU uniqueness validation
- ✅ Category association
- ✅ Barcode and SKU lookup
- ✅ Attribute management for variants
- ✅ Soft delete (status change to DISCONTINUED)

**Key Methods**:
- `create()` - Create product with validation
- `findAll()` - Search/filter products
- `findBySku()` - Lookup by SKU
- `generateVariants()` - Auto-generate variants from attributes
- `createVariant()` - Manual variant creation
- `findVariantByBarcode()` - POS scanner integration

---

## 📋 Implementation Pattern for Remaining Modules

### General Module Structure

```
src/{module}/
├── dto/
│   ├── create-{entity}.dto.ts
│   ├── update-{entity}.dto.ts
│   └── index.ts
├── {module}.module.ts
├── {module}.service.ts
├── {module}.controller.ts
└── {module}.service.spec.ts
```

---

## 1. Sales Module

### Required Files

```bash
nest generate module sales
nest generate service sales
nest generate controller sales
```

### Key Services Required

#### SalesService
```typescript
@Injectable()
export class SalesService {
  // Core CRUD
  async createSale(tenantId: string, dto: CreateSaleDto): Promise<Sale>
  async findOne(tenantId: string, id: string): Promise<Sale>
  async completeSale(tenantId: string, id: string): Promise<Sale>
  async voidSale(tenantId: string, id: string, reason: string): Promise<Sale>

  // Transaction processing
  async calculateTotal(items: SaleItem[]): Promise<SaleTotals>
  async addPayment(saleId: string, payment: PaymentDto): Promise<Payment>

  // Queries
  async getSalesByDateRange(tenantId: string, from: Date, to: Date): Promise<Sale[]>
  async getSalesByRegister(registerId: string, date: Date): Promise<Sale[]>
}
```

#### PriceCalculationService
```typescript
@Injectable()
export class PriceCalculationService {
  async calculateItemPrice(
    tenantId: string,
    variantId: string,
    quantity: number,
    customerId?: string,
  ): Promise<PriceCalculation>

  async getEffectivePriceList(
    tenantId: string,
    branchId: string,
    customerId?: string,
  ): Promise<PriceList>

  async applyDiscounts(
    items: SaleItem[],
    customerId?: string,
  ): Promise<DiscountApplication[]>
}
```

#### TaxCalculationService
```typescript
@Injectable()
export class TaxCalculationService {
  async calculateTax(
    tenantId: string,
    subtotal: number,
    taxRateIds: string[],
  ): Promise<TaxCalculation>

  async getTaxRatesForLocation(
    tenantId: string,
    branchId: string,
  ): Promise<TaxRate[]>

  async applyCompoundTax(
    subtotal: number,
    taxRates: TaxRate[],
  ): Promise<TaxBreakdown>
}
```

### DTOs Required

```typescript
// create-sale.dto.ts
export class CreateSaleDto {
  @IsUUID()
  branchId: string;

  @IsUUID()
  registerId: string;

  @IsUUID()
  @IsOptional()
  customerId?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items: SaleItemDto[];
}

export class SaleItemDto {
  @IsUUID()
  variantId: string;

  @IsNumber()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  unitPrice?: number; // Optional override

  @IsNumber()
  @Min(0)
  @IsOptional()
  discountAmount?: number;
}

// add-payment.dto.ts
export class AddPaymentDto {
  @IsUUID()
  paymentMethodId: string;

  @IsNumber()
  @Min(0)
  amount: number;

  @IsString()
  @IsOptional()
  reference?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
```

### Business Logic Example

```typescript
async completeSale(tenantId: string, saleId: string): Promise<Sale> {
  const sale = await this.findOne(tenantId, saleId);

  // Validate sale can be completed
  if (sale.status !== SaleStatus.DRAFT) {
    throw new BadRequestException('Sale is not in draft status');
  }

  // Validate payment received
  const totalPaid = sale.payments.reduce((sum, p) => sum + Number(p.amount), 0);
  if (totalPaid < Number(sale.total)) {
    throw new BadRequestException('Insufficient payment received');
  }

  // Reserve stock for all items
  for (const item of sale.items) {
    await this.inventoryService.reserveStock(
      tenantId,
      item.variantId,
      item.quantity,
      sale.id,
    );
  }

  // Complete sale
  sale.status = SaleStatus.COMPLETED;
  sale.changeAmount = totalPaid - Number(sale.total);

  return this.saleRepository.save(sale);
}
```

---

## 2. Inventory Module

### Required Files

```bash
nest generate module inventory
nest generate service inventory
nest generate controller inventory
```

### Key Services

#### InventoryService
```typescript
@Injectable()
export class InventoryService {
  // Stock level management
  async getStockLevel(tenantId: string, variantId: string, locationId: string): Promise<StockLevel>
  async updateStockLevel(tenantId: string, variantId: string, locationId: string, quantity: number): Promise<StockLevel>
  async reserveStock(tenantId: string, variantId: string, quantity: number, referenceId: string): Promise<void>
  async releaseReservation(tenantId: string, referenceId: string): Promise<void>

  // Stock movements
  async recordMovement(tenantId: string, dto: CreateStockMovementDto): Promise<StockMovement>
  async transferStock(tenantId: string, dto: StockTransferDto): Promise<StockMovement[]>

  // Stock adjustments
  async createAdjustment(tenantId: string, dto: CreateAdjustmentDto): Promise<StockAdjustment>
  async processAdjustment(tenantId: string, adjustmentId: string): Promise<void>

  // Alerts
  async getLowStockItems(tenantId: string, locationId?: string): Promise<LowStockAlert[]>
  async getOutOfStockItems(tenantId: string, locationId?: string): Promise<ProductVariant[]>
}
```

#### InventoryValuationService
```typescript
@Injectable()
export class InventoryValuationService {
  async calculateFIFO(
    tenantId: string,
    variantId: string,
    locationId: string,
  ): Promise<ValuationResult>

  async calculateLIFO(
    tenantId: string,
    variantId: string,
    locationId: string,
  ): Promise<ValuationResult>

  async calculateWeightedAverage(
    tenantId: string,
    variantId: string,
    locationId: string,
  ): Promise<ValuationResult>

  async getInventoryValue(
    tenantId: string,
    method: ValuationMethod,
    locationId?: string,
  ): Promise<InventoryValuationReport>
}
```

### Business Logic Example

```typescript
async reserveStock(
  tenantId: string,
  variantId: string,
  quantity: number,
  referenceId: string,
): Promise<void> {
  const stockLevel = await this.stockLevelRepository.findOne({
    where: { tenantId, variantId },
  });

  if (!stockLevel) {
    throw new NotFoundException('Stock level not found');
  }

  if (stockLevel.quantityAvailable < quantity) {
    throw new BadRequestException(`Insufficient stock. Available: ${stockLevel.quantityAvailable}, Requested: ${quantity}`);
  }

  // Update stock level
  stockLevel.quantityReserved += quantity;
  stockLevel.quantityAvailable -= quantity;

  await this.stockLevelRepository.save(stockLevel);

  // Record movement
  await this.stockMovementRepository.save({
    tenantId,
    variantId,
    movementType: MovementType.SALE,
    quantity: -quantity,
    referenceId,
    referenceType: 'sale',
  });
}
```

---

## 3. Customers Module

### Required Files

```bash
nest generate module customers
nest generate service customers
nest generate controller customers
```

### Key Services

#### CustomersService
```typescript
@Injectable()
export class CustomersService {
  // CRUD
  async create(tenantId: string, dto: CreateCustomerDto): Promise<Customer>
  async findAll(tenantId: string, filters: CustomerFilters): Promise<Customer[]>
  async findOne(tenantId: string, id: string): Promise<Customer>
  async update(tenantId: string, id: string, dto: UpdateCustomerDto): Promise<Customer>

  // Loyalty points
  async addLoyaltyPoints(customerId: string, points: number, reason: string): Promise<void>
  async redeemLoyaltyPoints(customerId: string, points: number): Promise<void>
  async getLoyaltyPointsBalance(customerId: string): Promise<number>

  // Credit management
  async checkCreditLimit(customerId: string, amount: number): Promise<boolean>
  async updateCreditBalance(customerId: string, amount: number): Promise<void>

  // Purchase history
  async getPurchaseHistory(customerId: string, limit?: number): Promise<Sale[]>
  async getCustomerStats(customerId: string): Promise<CustomerStats>
}
```

### DTOs

```typescript
export class CreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  code: string;

  @IsEnum(CustomerType)
  customerType: CustomerType;

  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsNumber()
  @Min(0)
  @IsOptional()
  creditLimit?: number;
}
```

---

## 4. Purchasing Module

### Required Files

```bash
nest generate module purchasing
nest generate service purchasing
nest generate controller purchasing
```

### Key Services

#### PurchasingService
```typescript
@Injectable()
export class PurchasingService {
  // Purchase orders
  async createPurchaseOrder(tenantId: string, dto: CreatePurchaseOrderDto): Promise<PurchaseOrder>
  async approvePurchaseOrder(tenantId: string, poId: string): Promise<PurchaseOrder>
  async cancelPurchaseOrder(tenantId: string, poId: string, reason: string): Promise<PurchaseOrder>

  // Goods receiving
  async receiveGoods(tenantId: string, poId: string, dto: ReceiveGoodsDto): Promise<PurchaseOrder>
  async partialReceive(tenantId: string, poId: string, items: ReceiveItemDto[]): Promise<PurchaseOrder>

  // Costing
  async updateCosts(tenantId: string, poId: string): Promise<void>
  async recalculateVariantCost(tenantId: string, variantId: string): Promise<number>
}
```

#### SupplierService
```typescript
@Injectable()
export class SupplierService {
  async create(tenantId: string, dto: CreateSupplierDto): Promise<Supplier>
  async findAll(tenantId: string): Promise<Supplier[]>
  async getSupplierStats(tenantId: string, supplierId: string): Promise<SupplierStats>
  async getSupplierOrders(tenantId: string, supplierId: string): Promise<PurchaseOrder[]>
}
```

---

## Module Configuration Example

### products.module.ts
```typescript
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { Product } from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { Category } from '../database/entities/category.entity';
import { AttributeDefinition } from '../database/entities/attribute-definition.entity';
import { AttributeValue } from '../database/entities/attribute-value.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      ProductVariant,
      Category,
      AttributeDefinition,
      AttributeValue,
    ]),
  ],
  providers: [ProductsService],
  controllers: [ProductsController],
  exports: [ProductsService], // Export for use in other modules
})
export class ProductsModule {}
```

---

## Controller Pattern Example

### products.controller.ts
```typescript
import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../database/entities/user.entity';

@Controller('products')
@UseGuards(JwtAuthGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Post()
  create(
    @CurrentUser() user: User,
    @Body() createProductDto: CreateProductDto,
  ) {
    // Get tenantId from user's context (from TenantMembership)
    const tenantId = 'tenant-uuid'; // TODO: Get from user context
    return this.productsService.create(tenantId, createProductDto);
  }

  @Get()
  findAll(
    @CurrentUser() user: User,
    @Query('categoryId') categoryId?: string,
    @Query('search') search?: string,
  ) {
    const tenantId = 'tenant-uuid';
    return this.productsService.findAll(tenantId, {
      categoryId,
      search,
    });
  }

  @Get(':id')
  findOne(@CurrentUser() user: User, @Param('id') id: string) {
    const tenantId = 'tenant-uuid';
    return this.productsService.findOne(tenantId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() updateProductDto: UpdateProductDto,
  ) {
    const tenantId = 'tenant-uuid';
    return this.productsService.update(tenantId, id, updateProductDto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    const tenantId = 'tenant-uuid';
    return this.productsService.remove(tenantId, id);
  }
}
```

---

## Testing Pattern Example

### products.service.spec.ts
```typescript
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { Product } from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';

describe('ProductsService', () => {
  let service: ProductsService;
  let mockProductRepository: any;

  beforeEach(async () => {
    mockProductRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      createQueryBuilder: jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue([]),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        {
          provide: getRepositoryToken(Product),
          useValue: mockProductRepository,
        },
        {
          provide: getRepositoryToken(ProductVariant),
          useValue: {},
        },
        // ... other repositories
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a product successfully', async () => {
      const dto = {
        sku: 'TEST-001',
        name: { en: 'Test Product' },
      };

      mockProductRepository.findOne.mockResolvedValue(null);
      mockProductRepository.create.mockReturnValue({ ...dto, id: 'uuid' });
      mockProductRepository.save.mockResolvedValue({ ...dto, id: 'uuid' });

      const result = await service.create('tenant-id', dto as any);

      expect(result).toBeDefined();
      expect(result.sku).toBe(dto.sku);
    });

    it('should throw ConflictException if SKU exists', async () => {
      const dto = {
        sku: 'TEST-001',
        name: { en: 'Test Product' },
      };

      mockProductRepository.findOne.mockResolvedValue({ id: 'existing' });

      await expect(service.create('tenant-id', dto as any))
        .rejects
        .toThrow('Product with SKU TEST-001 already exists');
    });
  });
});
```

---

## Priority Implementation Order

### Phase 1 (Critical for POS)
1. ✅ **Products Module** - DONE
2. **Sales Module** - Core POS functionality
3. **Inventory Module** - Stock tracking for sales
4. **Customers Module** - Customer lookup and loyalty

### Phase 2 (Operations)
5. **Purchasing Module** - Inventory replenishment
6. **Categories Module** - Product organization
7. **Price Lists Module** - Advanced pricing

### Phase 3 (Advanced)
8. **Reports Module** - Analytics and reporting
9. **Promotions Module** - Marketing campaigns
10. **Returns Module** - Return processing

---

## Next Steps

1. **Complete Products Module**:
   - Update products.module.ts with repository imports
   - Implement products.controller.ts with all CRUD endpoints
   - Add unit tests

2. **Implement Sales Module**:
   - Follow the pattern above
   - Focus on transaction processing
   - Integrate with Inventory for stock reservation

3. **Add Tenant Context**:
   - Create TenantContext decorator
   - Extract tenantId from user's active membership
   - Apply to all controllers

4. **Testing**:
   - Write unit tests for each service
   - Create integration tests for critical flows
   - Test multi-tenant isolation

---

## Useful Commands

```bash
# Generate new module
nest generate module {module-name}
nest generate service {module-name}
nest generate controller {module-name}

# Run tests
npm run test                # Unit tests
npm run test:watch         # Watch mode
npm run test:cov           # Coverage
npm run test:e2e           # End-to-end tests

# Build and run
npm run build
npm run start:dev
```

---

**Status**: Products Module implemented, patterns documented for all other modules
**Next**: Implement Sales Module following the documented pattern
