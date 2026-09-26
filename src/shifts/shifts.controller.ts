import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  APPROVAL_HEADER,
  PermissionsGuard,
} from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { ShiftsService } from './shifts.service';
import {
  CloseShiftDto,
  CountDto,
  CreateCashMovementDto,
  CreateShiftCorrectionDto,
  CurrentShiftQueryDto,
  DrawerOpenDto,
  HandoverShiftDto,
  DenominationsQueryDto,
  ListShiftsQueryDto,
  OpenShiftDto,
  SetDenominationsDto,
  StartCloseDto,
} from './shifts.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Shifts')
@ApiBearerAuth('JWT-auth')
@Controller('shifts')
export class ShiftsController {
  constructor(private shiftsService: ShiftsService) {}

  /** GET /shifts?status=&registerId=&userId=&from=&to=&varianceOnly=&page=&limit= */
  @Get()
  @RequirePermissions('shifts.operate')
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListShiftsQueryDto,
  ) {
    return this.shiftsService.list(tenantId, user, query);
  }

  /** The register's open shift with live totals: GET /shifts/current?registerId= */
  @Get('current')
  @RequirePermissions('shifts.operate')
  current(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: CurrentShiftQueryDto,
  ) {
    return this.shiftsService.current(tenantId, user, query.registerId);
  }

  /** Notes and coins to count: GET /shifts/denominations?currencyCode= */
  @Get('denominations')
  @RequireAnyPermission('shifts.operate', 'shifts.manage')
  denominations(
    @CurrentTenant() tenantId: string,
    @Query() query: DenominationsQueryDto,
  ) {
    return this.shiftsService.getDenominations(tenantId, query.currencyCode);
  }

  /** Custom denominations for a currency (empty list = defaults) */
  @Put('denominations')
  @RequirePermissions('shifts.manage')
  setDenominations(
    @CurrentTenant() tenantId: string,
    @Body() dto: SetDenominationsDto,
  ) {
    return this.shiftsService.setDenominations(tenantId, dto);
  }

  /** Open a shift with its opening float: POST /shifts/open */
  @Post('open')
  @RequirePermissions('shifts.operate')
  open(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: OpenShiftDto,
  ) {
    return this.shiftsService.open(tenantId, user, dto);
  }

  @Get(':id')
  @RequirePermissions('shifts.operate')
  findOne(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shiftsService.findOne(tenantId, user, id);
  }

  /** Printable shift summary (frozen once closed) */
  @Get(':id/z-report')
  @RequirePermissions('shifts.operate')
  zReport(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shiftsService.zReport(tenantId, user, id);
  }

  /** Drawer ledger: every movement, per-sale cash and no-sale openings included */
  @Get(':id/ledger')
  @RequirePermissions('shifts.operate')
  ledger(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shiftsService.ledger(tenantId, user, id);
  }

  /** No-sale: open the drawer without a sale (reason required, audited) */
  @Post(':id/drawer-open')
  @RequirePermissions('shifts.operate')
  @Idempotent('shift.drawer_open')
  drawerOpen(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DrawerOpenDto,
  ) {
    return this.shiftsService.drawerOpen(tenantId, user, id, dto);
  }

  /** Correct a closed shift with a linked record (it is never reopened) */
  @Post(':id/corrections')
  @RequirePermissions('shifts.manage')
  @AllowApproval()
  correct(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateShiftCorrectionDto,
  ) {
    return this.shiftsService.addCorrection(tenantId, user, id, dto);
  }

  /** Paid-in, paid-out or safe drop (manager, or cashier with approval) */
  @Post(':id/movements')
  @RequirePermissions('shifts.manage')
  @AllowApproval()
  @Idempotent('shift.movement')
  addMovement(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCashMovementDto,
  ) {
    return this.shiftsService.addMovement(tenantId, user, id, dto);
  }

  /** Begin counting the drawer (optionally blind) */
  @Post(':id/start-close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shifts.operate')
  startClose(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StartCloseDto,
  ) {
    return this.shiftsService.startClose(tenantId, user, id, dto);
  }

  /** Cancel the count and go back to selling */
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shifts.operate')
  resume(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.shiftsService.resume(tenantId, user, id);
  }

  /** Review a count: expected, variance and whether approval is needed */
  @Post(':id/preview-close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shifts.operate')
  previewClose(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CountDto,
  ) {
    return this.shiftsService.previewClose(tenantId, user, id, dto);
  }

  /**
   * Close the shift (idempotent). Over-tolerance variances need shifts.manage
   * or a manager approval for shifts.manage in X-Approval-Token.
   */
  // The body's idempotencyKey still works; an Idempotency-Key header adds the generic replay
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shifts.operate')
  @Idempotent('shift.close')
  close(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CloseShiftDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.shiftsService.close(tenantId, user, id, dto, approvalToken);
  }

  /**
   * Close and hand the drawer over: the incoming cashier's shift opens on the
   * same drawer with the counted cash as its float (one step, idempotent)
   */
  @Post(':id/handover')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('shifts.operate')
  @Idempotent('shift.handover')
  handover(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HandoverShiftDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.shiftsService.handover(tenantId, user, id, dto, approvalToken);
  }
}
