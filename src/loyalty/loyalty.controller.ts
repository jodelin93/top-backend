import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { DataSource } from 'typeorm';
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import {
  AllowApproval,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { LoyaltyService } from './loyalty.service';
import { pointsEarned, pointsForAmount, valueOfPoints } from './loyalty-math';

export class AdjustPointsDto {
  // Positive adds points, negative removes them
  @IsInt() @NotEquals(0) @Min(-1_000_000) @Max(1_000_000) points: number;
  @IsString() @IsNotEmpty() @MaxLength(255) note: string;
}

export class LoyaltyPreviewQueryDto {
  @Type(() => Number) @IsNumber() @Min(0) amount: number;
}

export class LoyaltyHistoryQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(500) @IsOptional() limit?: number;
}

@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('loyalty')
export class LoyaltyController {
  constructor(
    private loyaltyService: LoyaltyService,
    private dataSource: DataSource,
  ) {}

  /**
   * Programme rules, and what an amount earns / costs in points
   * GET /loyalty/preview?amount=
   */
  @Get('preview')
  @RequirePermissions('customers.view')
  async preview(
    @CurrentTenant() tenantId: string,
    @Query() query: LoyaltyPreviewQueryDto,
  ) {
    const rules = await this.loyaltyService.rules(tenantId);
    return {
      rules,
      earnsPoints: pointsEarned(rules, query.amount),
      pointsToPay: pointsForAmount(rules, query.amount),
      valueOf100Points: valueOfPoints(rules, 100),
    };
  }

  /**
   * GET /loyalty/customers/:id — balance and its money value
   */
  @Get('customers/:id')
  @RequirePermissions('customers.view')
  balance(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.loyaltyService.balance(tenantId, id);
  }

  /**
   * GET /loyalty/customers/:id/history — every earn, spend, reversal and adjustment
   */
  @Get('customers/:id/history')
  @RequirePermissions('customers.view')
  history(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: LoyaltyHistoryQueryDto,
  ) {
    return this.loyaltyService.history(tenantId, id, query.limit);
  }

  /**
   * POST /loyalty/customers/:id/adjust — manual correction (audited). Points are
   * worth money at the till: the same permission as store credit adjustments
   * (customers.credit.manage), or a manager's approval.
   */
  @Post('customers/:id/adjust')
  @RequirePermissions('customers.credit.manage')
  @AllowApproval()
  adjust(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustPointsDto,
  ) {
    return this.dataSource.transaction((manager) =>
      this.loyaltyService.adjust(tenantId, id, dto.points, dto.note, manager),
    );
  }
}
