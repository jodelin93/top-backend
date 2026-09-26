import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { ProductImage } from '../database/entities/product-image.entity';
import { ProductBarcode } from '../database/entities/product-barcode.entity';
import { MAX_IMAGE_BYTES } from '../storage/image-validation';
import { ProductImagesService } from './product-images.service';
import { ProductBarcodesService } from './product-barcodes.service';
import {
  AddBarcodeDto,
  ReorderImagesDto,
  UpdateImageDto,
  UploadImageDto,
} from './dto/product-media.dto';

/**
 * Product images and extra variant barcodes.
 * Anyone signed in can read; changes need catalog.manage.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('products/:id')
export class ProductMediaController {
  constructor(
    private images: ProductImagesService,
    private barcodes: ProductBarcodesService,
  ) {}

  /** GET /products/:id/images (in display order) */
  @Get('images')
  @AnyMember()
  listImages(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProductImage[]> {
    return this.images.list(tenantId, id);
  }

  /** POST /products/:id/images (multipart: file, altText) */
  @Post('images')
  @RequirePermissions('catalog.manage')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: { type: 'string', format: 'binary' },
        altText: { type: 'string' },
      },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // One file per request; multer rejects bigger bodies with 413
      limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 },
    }),
  )
  uploadImage(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadImageDto,
  ): Promise<ProductImage> {
    return this.images.upload(tenantId, id, file, dto.altText);
  }

  /** POST /products/:id/images/reorder { imageIds } */
  @Post('images/reorder')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.OK)
  reorderImages(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReorderImagesDto,
  ): Promise<ProductImage[]> {
    return this.images.reorder(tenantId, id, dto.imageIds);
  }

  /** PATCH /products/:id/images/:imageId { altText?, isPrimary? } */
  @Patch('images/:imageId')
  @RequirePermissions('catalog.manage')
  updateImage(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
    @Body() dto: UpdateImageDto,
  ): Promise<ProductImage> {
    return this.images.update(tenantId, id, imageId, dto);
  }

  /** DELETE /products/:id/images/:imageId */
  @Delete('images/:imageId')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeImage(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('imageId', ParseUUIDPipe) imageId: string,
  ): Promise<void> {
    return this.images.remove(tenantId, id, imageId);
  }

  /** GET /products/:id/variants/:variantId/barcodes */
  @Get('variants/:variantId/barcodes')
  @AnyMember()
  listBarcodes(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
  ): Promise<ProductBarcode[]> {
    return this.barcodes.list(tenantId, id, variantId);
  }

  /** POST /products/:id/variants/:variantId/barcodes { barcode } */
  @Post('variants/:variantId/barcodes')
  @RequirePermissions('catalog.manage')
  addBarcode(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: AddBarcodeDto,
  ): Promise<ProductBarcode> {
    return this.barcodes.add(tenantId, id, variantId, dto.barcode);
  }

  /** DELETE /products/:id/variants/:variantId/barcodes/:barcodeId (extra barcodes only) */
  @Delete('variants/:variantId/barcodes/:barcodeId')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeBarcode(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Param('barcodeId', ParseUUIDPipe) barcodeId: string,
  ): Promise<void> {
    return this.barcodes.remove(tenantId, id, variantId, barcodeId);
  }
}
