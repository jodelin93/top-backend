import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import { User } from '../database/entities/user.entity';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import {
  BatchListQueryDto,
  ImportSettlementDto,
  ResolveLineDto,
  ResolvePaymentDto,
  SetMethodProviderDto,
  UnmatchedQueryDto,
  UploadSettlementDto,
} from './payments.dto';
import {
  normalizeSettlementRows,
  parseSettlementCsv,
} from './settlement-matcher';

// Same cap as product CSV imports (tens of thousands of settlement lines)
const MAX_SETTLEMENT_FILE_BYTES = 2 * 1024 * 1024;

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('payments')
export class PaymentsController {
  constructor(
    private paymentsService: PaymentsService,
    private reconciliationService: ReconciliationService,
  ) {}

  /** Registered provider adapters (for the payment method settings) */
  @Get('providers')
  @RequireAnyPermission('settings.manage', 'payments.reconcile')
  providers() {
    return this.paymentsService.providers();
  }

  /** PATCH /payments/methods/:id/provider { provider } */
  @Patch('methods/:id/provider')
  @RequirePermissions('settings.manage')
  setMethodProvider(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetMethodProviderDto,
  ) {
    return this.paymentsService.setMethodProvider(tenantId, id, dto.provider);
  }

  /** Payment state of a sale (the POS polls this while a sale is payment_pending) */
  @Get('sales/:saleId')
  @RequirePermissions('pos.sell')
  saleState(
    @CurrentTenant() tenantId: string,
    @Param('saleId', ParseUUIDPipe) saleId: string,
  ) {
    return this.paymentsService.saleState(tenantId, saleId);
  }

  /** Ask the provider for the current status (after a timeout) */
  @Post(':id/lookup')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pos.sell')
  lookup(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentsService.lookup(tenantId, id);
  }

  /** New attempt for a failed payment */
  @Post(':id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pos.sell')
  retry(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.paymentsService.retry(tenantId, id);
  }

  // ---- Settlement reconciliation ----

  /** Import a settlement batch as JSON */
  @Post('settlements')
  @RequirePermissions('payments.reconcile')
  importJson(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: ImportSettlementDto,
  ) {
    return this.reconciliationService.importBatch(tenantId, user.id, {
      provider: dto.provider,
      reference: dto.reference,
      source: 'json',
      lines: normalizeSettlementRows(dto.lines.map((l) => ({ ...l }))),
    });
  }

  /** Import a settlement batch from a CSV file (columns: reference, amount, fee, date) */
  @Post('settlements/upload')
  @RequirePermissions('payments.reconcile')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      // One file, the two DTO fields (provider, reference), small field values
      limits: {
        fileSize: MAX_SETTLEMENT_FILE_BYTES,
        files: 1,
        fields: 5,
        fieldSize: 1024,
        parts: 6,
      },
    }),
  )
  importCsv(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: UploadSettlementDto,
  ) {
    if (!file)
      throw new BadRequestException('Attach the settlement CSV as "file"');
    return this.reconciliationService.importBatch(tenantId, user.id, {
      provider: dto.provider,
      reference: dto.reference,
      source: 'csv',
      lines: parseSettlementCsv(file.buffer.toString('utf8')),
    });
  }

  @Get('settlements')
  @RequirePermissions('payments.reconcile')
  listBatches(
    @CurrentTenant() tenantId: string,
    @Query() query: BatchListQueryDto,
  ) {
    return this.reconciliationService.listBatches(
      tenantId,
      query.page,
      query.limit,
    );
  }

  @Get('settlements/:id')
  @RequirePermissions('payments.reconcile')
  getBatch(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reconciliationService.getBatch(tenantId, id);
  }

  /** Unmatched settlement lines and unreconciled captured payments */
  @Get('reconciliation/unmatched')
  @RequirePermissions('payments.reconcile')
  unmatched(
    @CurrentTenant() tenantId: string,
    @Query() query: UnmatchedQueryDto,
  ) {
    return this.reconciliationService.unmatched(tenantId, query.provider);
  }

  @Post('settlements/lines/:id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.reconcile')
  resolveLine(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveLineDto,
  ) {
    return this.reconciliationService.resolveLine(tenantId, user.id, id, dto);
  }

  @Post(':id/reconcile')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('payments.reconcile')
  resolvePayment(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolvePaymentDto,
  ) {
    return this.reconciliationService.resolvePayment(tenantId, id, dto.note);
  }
}

/**
 * Provider webhooks: public (no JWT), authenticated by the provider's signature.
 * POST /payments/webhooks/:provider
 */
@ApiTags('Payments')
@Controller('payments/webhooks')
export class PaymentWebhooksController {
  constructor(private paymentsService: PaymentsService) {}

  @Post(':provider')
  @Public()
  // Signed by the provider's server, never sent with a browser session
  @SkipCsrf()
  @HttpCode(HttpStatus.OK)
  webhook(
    @Param('provider') provider: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Headers() headers: Record<string, string | string[] | undefined>,
  ) {
    // Exact bytes when the app keeps them (NestFactory rawBody: true); otherwise the
    // compact JSON re-serialisation of the parsed body
    const rawBody = req.rawBody
      ? req.rawBody.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body ?? {});
    return this.paymentsService.handleWebhook(provider, rawBody, headers);
  }
}
