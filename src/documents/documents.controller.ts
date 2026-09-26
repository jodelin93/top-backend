import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  GoneException,
  HttpCode,
  HttpException,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { PrintActor, PrintJobsService } from './print-jobs.service';
import { DocumentDeliveriesService } from './document-deliveries.service';
import { ANY_PRINT_PERMISSIONS } from './print-job-rules';
import { escapeHtml } from './receipt-html';
import {
  CreatePrintJobDto,
  EmailReceiptDto,
  ListPrintJobsQueryDto,
  ShareLinkDto,
  UpdatePrintJobDto,
} from './documents.dto';

const actorOf = (user: AuthUser): PrintActor => ({
  id: user.id,
  permissions: user.permissions ?? [],
});

/**
 * Print history (spec §15). The POS records every print here first and prints
 * what the answer says: the original, or COPY #n.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Documents')
@ApiBearerAuth('JWT-auth')
@Controller('print-jobs')
export class PrintJobsController {
  constructor(private printJobs: PrintJobsService) {}

  /** POST /print-jobs — the permission for the document type is checked inside */
  @Post()
  @RequireAnyPermission(...ANY_PRINT_PERMISSIONS)
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePrintJobDto,
  ) {
    return this.printJobs.create(tenantId, actorOf(user), dto);
  }

  /** GET /print-jobs?documentType=&documentId= */
  @Get()
  @RequireAnyPermission(
    'sales.view',
    'sales.refund',
    'estimates.manage',
    'shifts.manage',
    'shifts.operate',
  )
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: ListPrintJobsQueryDto,
  ) {
    return this.printJobs.list(tenantId, query.documentType, query.documentId);
  }

  /** PATCH /print-jobs/:id — { status: sent | printed | failed | unknown, error? } */
  @Patch(':id')
  @RequireAnyPermission(...ANY_PRINT_PERMISSIONS)
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePrintJobDto,
  ) {
    return this.printJobs.updateStatus(tenantId, id, dto);
  }

  /** POST /print-jobs/:id/retry — uncertain prints come back as a COPY */
  @Post(':id/retry')
  @RequireAnyPermission(...ANY_PRINT_PERMISSIONS)
  retry(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.printJobs.retry(tenantId, actorOf(user), id);
  }
}

/** E-mailed receipts and shared receipt links (spec §15) */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Documents')
@ApiBearerAuth('JWT-auth')
@Controller('documents')
export class DocumentsController {
  constructor(private deliveries: DocumentDeliveriesService) {}

  /** POST /documents/receipts/:saleId/email — { to, consentConfirmed?, documentType? } */
  @Post('receipts/:saleId/email')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sales.reprint')
  // Anti-relay: 5 a minute (the service also caps per user and per sale)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  email(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() dto: EmailReceiptDto,
  ) {
    return this.deliveries.emailReceipt(tenantId, user.id, saleId, dto);
  }

  /** POST /documents/receipts/:saleId/share-link — { expiresInDays?, recipient? } */
  @Post('receipts/:saleId/share-link')
  @RequirePermissions('sales.reprint')
  shareLink(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('saleId', ParseUUIDPipe) saleId: string,
    @Body() dto: ShareLinkDto,
  ) {
    return this.deliveries.createShareLink(tenantId, user.id, saleId, dto);
  }

  /** GET /documents/deliveries?documentId= */
  @Get('deliveries')
  @RequirePermissions('sales.view')
  deliveriesOf(
    @CurrentTenant() tenantId: string,
    @Query('documentId', ParseUUIDPipe) documentId: string,
  ) {
    return this.deliveries.list(tenantId, documentId);
  }

  /** POST /documents/deliveries/:id/revoke — a shared link stops working */
  @Post('deliveries/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('sales.reprint')
  revoke(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.deliveries.revoke(tenantId, id);
  }
}

/**
 * Read-only receipt page behind a signed, expiring link (GET /public/receipts/:token).
 * No sign-in: the signature is the authorisation.
 */
@ApiTags('Documents')
@Controller('public/receipts')
export class PublicReceiptsController {
  constructor(private deliveries: DocumentDeliveriesService) {}

  @Get(':token')
  @Public()
  async show(@Param('token') token: string, @Res() res: Response) {
    // A static page: no scripts, no framing, not indexed, not cached by proxies
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html');
    try {
      res.status(200).send(await this.deliveries.publicReceiptHtml(token));
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      const gone = error instanceof GoneException;
      const message = gone ? error.message : 'This receipt link is not valid.';
      res
        .status(gone ? 410 : 404)
        .send(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Receipt</title></head><body style="font-family:Arial,sans-serif;padding:32px;text-align:center"><p>${escapeHtml(message)}</p></body></html>`,
        );
    }
  }
}
