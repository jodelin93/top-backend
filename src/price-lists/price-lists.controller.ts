import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { PriceList } from '../database/entities/price-list.entity';
import { PriceListsService } from './price-lists.service';
import {
  CreatePriceListDto,
  SetPriceEntriesDto,
  UpdatePriceListDto,
} from './price-lists.dto';

@ApiTags('Price lists')
@ApiBearerAuth('JWT-auth')
@Controller('price-lists')
export class PriceListsController extends CrudController<PriceList>(
  CreatePriceListDto,
  UpdatePriceListDto,
  {
    entityType: 'price_list',
    permission: 'pricing.manage',
    // Customer groups pick a default price list
    read: { anyOf: ['pricing.manage', 'customers.manage'] },
  },
) {
  constructor(private priceListsService: PriceListsService) {
    super(priceListsService);
  }

  @Get(':id/entries')
  @RequirePermissions('pricing.manage')
  getEntries(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.priceListsService.getEntries(tenantId, id);
  }

  @Put(':id/entries')
  @RequirePermissions('pricing.manage')
  setEntries(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPriceEntriesDto,
  ) {
    return this.priceListsService.setEntries(tenantId, id, dto);
  }

  @Delete(':id/entries/:entryId')
  @RequirePermissions('pricing.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeEntry(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.priceListsService.removeEntry(tenantId, id, entryId);
  }
}
