import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { EstimateStatus } from '../database/entities/estimate.entity';
import { EstimatesService } from './estimates.service';
import {
  CreateEstimateDto,
  ListEstimatesQueryDto,
  UpdateEstimateDto,
} from './estimates.dto';

@ApiTags('Sales')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('estimates.manage')
@Controller('estimates')
export class EstimatesController {
  constructor(private estimatesService: EstimatesService) {}

  /** GET /estimates?search=&status=&customerId=&page=&limit= */
  @Get()
  findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListEstimatesQueryDto,
  ) {
    return this.estimatesService.findAll(tenantId, query);
  }

  @Get(':id')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.estimatesService.findOne(tenantId, id);
  }

  /** Discounts above the limit / negotiated prices need X-Approval-Token like at the till */
  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEstimateDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.estimatesService.create(tenantId, user, dto, approvalToken);
  }

  @Patch(':id')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEstimateDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.estimatesService.update(tenantId, user, id, dto, approvalToken);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.estimatesService.remove(tenantId, id);
  }

  @Post(':id/send')
  @HttpCode(HttpStatus.OK)
  send(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.estimatesService.setStatus(tenantId, id, EstimateStatus.SENT);
  }

  @Post(':id/accept')
  @HttpCode(HttpStatus.OK)
  accept(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.estimatesService.setStatus(
      tenantId,
      id,
      EstimateStatus.ACCEPTED,
    );
  }

  @Post(':id/decline')
  @HttpCode(HttpStatus.OK)
  decline(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.estimatesService.setStatus(
      tenantId,
      id,
      EstimateStatus.DECLINED,
    );
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.estimatesService.duplicate(tenantId, user, id, approvalToken);
  }
}
