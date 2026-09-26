import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AnyMember } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { authThrottle } from '../config/throttle.config';
import { User } from '../database/entities/user.entity';
import { ApprovalsService } from './approvals.service';
import { RequestApprovalDto } from './approvals.dto';

@ApiTags('Authentication')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(private approvalsService: ApprovalsService) {}

  /**
   * A manager authorises one action for the signed-in user.
   * Send the returned approvalToken as the X-Approval-Token header on that request.
   * POST /approvals
   */
  @Post()
  @AnyMember() // the approver's credentials are what authorise the action
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: authThrottle }) // approver passwords: brute-force protection
  approve(
    @CurrentUser() user: User,
    @CurrentTenant() tenantId: string,
    @Body() dto: RequestApprovalDto,
  ) {
    return this.approvalsService.approve({ id: user.id, tenantId }, dto);
  }
}
