import { timingSafeEqual } from 'crypto';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireAnyPermission } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { SkipCsrf } from '../auth/decorators/skip-csrf.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationGeneratorsService } from '../notifications/notification-generators.service';
import { OutboxService } from './outbox/outbox.service';
import { OutboxPublisherService } from './outbox/outbox-publisher.service';
import { EventHandlerRegistry } from './outbox/event-handler.registry';
import { ReconciliationJobsService } from './reconciliation-jobs.service';
import { activeTenantIds } from './scheduling';
import { DataSource } from 'typeorm';
import {
  BackupReportDto,
  CheckRunsQueryDto,
  OutboxQueryDto,
  ReplayEventDto,
} from './system-events.dto';
import { BALANCE_PAYLOAD_KEYS, EVENT_AGGREGATES } from '../events/event-types';

/** An event as shown to `user`: balances only with customers.finance.view */
export function eventForViewer<T extends { payload?: unknown }>(
  event: T,
  user: Pick<AuthUser, 'permissions'>,
): T {
  if (user.permissions?.includes('customers.finance.view')) return event;
  const payload = event.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return event;
  }
  const visible = Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).filter(
      ([key]) => !BALANCE_PAYLOAD_KEYS.includes(key),
    ),
  );
  return { ...event, payload: visible };
}

/**
 * System events page (spec §17/§18): outbox lag and failures with retry and
 * replay, reconciliation runs, and running the checks on demand.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('System events')
@ApiBearerAuth('JWT-auth')
@RequireAnyPermission('platform.operate', 'settings.manage')
@Controller('system-events')
export class SystemEventsController {
  constructor(
    private outbox: OutboxService,
    private publisher: OutboxPublisherService,
    private registry: EventHandlerRegistry,
    private reconciliation: ReconciliationJobsService,
    private generators: NotificationGeneratorsService,
    private auditService: AuditService,
  ) {}

  /** Outbox backlog, consumers and the last reconciliation run */
  @Get('summary')
  async summary(@CurrentTenant() tenantId: string) {
    const [outbox, runs] = await Promise.all([
      this.outbox.stats(tenantId),
      this.reconciliation.list(tenantId, 1),
    ]);
    return {
      outbox,
      lastRun: runs[0] ?? null,
      consumers: Object.keys(EVENT_AGGREGATES).map((eventType) => ({
        eventType,
        consumers: this.registry.consumersOf(eventType),
      })),
    };
  }

  /** GET /system-events/outbox?status=pending|failed|dead|published|all&eventType=&page=&limit= */
  @Get('outbox')
  async listOutbox(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: OutboxQueryDto,
  ) {
    const page = await this.outbox.list(tenantId, query);
    return {
      ...page,
      data: page.data.map((event) => eventForViewer(event, user)),
    };
  }

  /** One event; balances in its payload only with customers.finance.view */
  @Get('outbox/:id')
  async getEvent(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return eventForViewer(await this.outbox.get(tenantId, id), user);
  }

  /** Deliver a failed or dead-lettered event again (now) */
  @Post('outbox/:id/retry')
  @HttpCode(HttpStatus.OK)
  async retry(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const event = await this.outbox.retry(tenantId, id);
    await this.auditService.record({
      tenantId,
      action: 'system_event.retried',
      entityType: 'outbox_event',
      entityId: id,
      metadata: { eventType: event.eventType },
    });
    await this.publisher.publishPending(1);
    return eventForViewer(await this.outbox.get(tenantId, id), user);
  }

  /** Run an event's consumers again, even those that already handled it */
  @Post('outbox/:id/replay')
  @HttpCode(HttpStatus.OK)
  async replay(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplayEventDto,
  ) {
    const event = await this.outbox.replay(tenantId, id, dto.consumer);
    await this.auditService.record({
      tenantId,
      action: 'system_event.replayed',
      entityType: 'outbox_event',
      entityId: id,
      metadata: { eventType: event.eventType, consumer: dto.consumer ?? null },
    });
    await this.publisher.publishPending(1);
    return eventForViewer(await this.outbox.get(tenantId, id), user);
  }

  /** Reconciliation runs, newest first */
  @Get('checks')
  listRuns(
    @CurrentTenant() tenantId: string,
    @Query() query: CheckRunsQueryDto,
  ) {
    return this.reconciliation.list(tenantId, query.limit ?? 30);
  }

  @Get('checks/:id')
  getRun(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.reconciliation.get(tenantId, id);
  }

  /** Run the reconciliation checks and the notification checks now */
  @Post('checks/run')
  @HttpCode(HttpStatus.OK)
  async runChecks(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const run = await this.reconciliation.run(tenantId, 'manual', user.id);
    const notificationChecks = await this.generators.runChecks(tenantId);
    await this.auditService.record({
      tenantId,
      action: 'system_check.run',
      entityType: 'system_check_run',
      entityId: run.id,
      metadata: { status: run.status },
    });
    return { run, notificationChecks };
  }
}

/**
 * Hook for scripts/backup-db.sh (spec §15): reports a backup outcome with the
 * shared secret BACKUP_REPORT_TOKEN in the X-Backup-Token header. A failure
 * notifies the operators of every store (one database, one backup); a success
 * clears it. Disabled (404) while BACKUP_REPORT_TOKEN is unset.
 */
@Public()
// Called by scripts/backup-db.sh with a shared secret, never by a browser
@SkipCsrf()
@ApiTags('System events')
@Controller('platform')
export class BackupReportController {
  private readonly logger = new Logger(BackupReportController.name);

  constructor(
    private dataSource: DataSource,
    private notifications: NotificationsService,
  ) {}

  @Post('backup-report')
  @HttpCode(HttpStatus.ACCEPTED)
  async report(
    @Headers('x-backup-token') token: string | undefined,
    @Body() dto: BackupReportDto,
  ) {
    const expected = process.env.BACKUP_REPORT_TOKEN ?? '';
    if (expected.length < 16) throw new NotFoundException();
    if (!token || !safeEqual(token, expected)) {
      throw new ForbiddenException('Invalid backup token');
    }
    const tenants = await activeTenantIds(this.dataSource);
    for (const tenantId of tenants) {
      if (dto.status === 'failed') {
        await this.notifications.notify({
          tenantId,
          type: 'backup.failed',
          title: 'The database backup failed',
          body: dto.message?.slice(0, 500) ?? null,
          dedupeKey: 'backup.failed',
        });
      } else {
        await this.notifications.resolve(tenantId, 'backup.failed');
      }
    }
    if (dto.status === 'failed') {
      this.logger.error(`Backup failed: ${dto.message ?? 'no details'}`);
    } else {
      this.logger.log(`Backup succeeded${dto.file ? ` (${dto.file})` : ''}`);
    }
    return { received: true, stores: tenants.length };
  }
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
