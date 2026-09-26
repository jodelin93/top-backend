import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { GenerateVariantsResult, ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ListProductsQueryDto } from './dto/list-products-query.dto';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import {
  CreateProductVariantDto,
  UpdateVariantDto,
} from './dto/create-variant.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  AnyMember,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { checkBarcode } from './catalog-rules';
import { PrintLabelsDto } from './dto/labels.dto';
import { Product } from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('products')
export class ProductsController {
  constructor(private productsService: ProductsService) {}

  /**
   * List products for the current tenant
   * GET /products?search=&status=&productType=&categoryId=
   */
  @Get()
  @AnyMember() // costs are left out without inventory.cost.view (SensitiveFieldsInterceptor)
  async findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListProductsQueryDto,
  ): Promise<Product[]> {
    return this.productsService.findAll(tenantId, query);
  }

  /**
   * Normalize a barcode and check its EAN/UPC check digit (a warning, not an error)
   * GET /products/barcode-check?code=
   */
  @Get('barcode-check')
  @AnyMember()
  barcodeCheck(@Query('code') code?: string) {
    return checkBarcode(code);
  }

  /**
   * Label sheet data (name, SKU, code, price per copy; never costs)
   * POST /products/labels
   */
  @Post('labels')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission('catalog.manage', 'inventory.receive')
  labels(@CurrentTenant() tenantId: string, @Body() dto: PrintLabelsDto) {
    return this.productsService.labels(tenantId, dto);
  }

  /**
   * Get a single product
   * GET /products/:id
   */
  @Get(':id')
  @AnyMember()
  async findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Product> {
    return this.productsService.findOne(tenantId, id);
  }

  /**
   * Create a product (simple products get a default variant with the price)
   * POST /products
   */
  @Post()
  @RequirePermissions('catalog.manage')
  async create(
    @CurrentTenant() tenantId: string,
    @Body() createProductDto: CreateProductDto,
  ): Promise<Product> {
    return this.productsService.create(tenantId, createProductDto);
  }

  /**
   * Update a product
   * PATCH /products/:id
   */
  @Patch(':id')
  @RequirePermissions('catalog.manage')
  async update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateProductDto: UpdateProductDto,
  ): Promise<Product> {
    return this.productsService.update(tenantId, id, updateProductDto);
  }

  /**
   * Discontinue a product (soft delete)
   * DELETE /products/:id
   */
  @Delete(':id')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.productsService.remove(tenantId, id);
  }

  /**
   * List variants of a product
   * GET /products/:id/variants
   */
  @Get(':id/variants')
  @AnyMember()
  async listVariants(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductVariant[]> {
    await this.productsService.findOne(tenantId, id);
    return this.productsService.getProductVariants(tenantId, id);
  }

  /**
   * Add a variant to a product
   * POST /products/:id/variants
   */
  @Post(':id/variants')
  @RequirePermissions('catalog.manage')
  async createVariant(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateProductVariantDto,
  ): Promise<ProductVariant> {
    return this.productsService.createVariant(tenantId, {
      ...dto,
      productId: id,
    });
  }

  /**
   * Preview (dryRun) or create every combination of attribute values as variants,
   * skipping combinations that already exist
   * POST /products/:id/variants/generate
   */
  @Post(':id/variants/generate')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.OK)
  async generateVariants(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateVariantsDto,
  ): Promise<GenerateVariantsResult> {
    return this.productsService.generateVariants(tenantId, id, dto);
  }

  /**
   * Update a variant
   * PATCH /products/:id/variants/:variantId
   */
  @Patch(':id/variants/:variantId')
  @RequirePermissions('catalog.manage')
  async updateVariant(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
  ): Promise<ProductVariant> {
    return this.productsService.updateVariant(tenantId, id, variantId, dto);
  }

  /**
   * Discontinue a variant
   * DELETE /products/:id/variants/:variantId
   */
  @Delete(':id/variants/:variantId')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeVariant(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<void> {
    return this.productsService.removeVariant(tenantId, id, variantId);
  }
}
