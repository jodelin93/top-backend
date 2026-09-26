import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { SessionsModule } from './sessions/sessions.module';
import { DevicesModule } from './devices/devices.module';
import { SyncModule } from './sync/sync.module';
import { TenantsModule } from './tenants/tenants.module';
import { MetricsModule } from './metrics/metrics.module';
import { ProductsModule } from './products/products.module';
import { StorageModule } from './storage/storage.module';
import { TaxCategoriesModule } from './tax-categories/tax-categories.module';
import { ImportsModule } from './imports/imports.module';
import { JobsModule } from './jobs/jobs.module';
import { SettingsModule } from './settings/settings.module';
import { CategoriesModule } from './categories/categories.module';
import { PriceListsModule } from './price-lists/price-lists.module';
import { CustomersModule } from './customers/customers.module';
import { DiscountsModule } from './discounts/discounts.module';
import { InventoryModule } from './inventory/inventory.module';
import { PurchasingModule } from './purchasing/purchasing.module';
import { SalesModule } from './sales/sales.module';
import { ReportsModule } from './reports/reports.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { AuditModule } from './audit/audit.module';
import { RolesModule } from './roles/roles.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { ShiftsModule } from './shifts/shifts.module';
import { EmployeesModule } from './employees/employees.module';
import { ReturnsModule } from './returns/returns.module';
import { LoyaltyModule } from './loyalty/loyalty.module';
import { StoredValueModule } from './stored-value/stored-value.module';
import { EstimatesModule } from './estimates/estimates.module';
import { ExpensesModule } from './expenses/expenses.module';
import { PlatformModule } from './platform/platform.module';
import { IdempotencyModule } from './common/idempotency/idempotency.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ExportsModule } from './exports/exports.module';
import { DocumentsModule } from './documents/documents.module';
import { HardwareModule } from './hardware/hardware.module';
import { validateEnv } from './config/env.validation';
import {
  globalThrottle,
  isThrottleEnabled,
  tenantThrottle,
} from './config/throttle.config';
import {
  TENANT_THROTTLER,
  TenantThrottlerGuard,
} from './auth/guards/tenant-throttler.guard';

@Module({
  imports: [
    // Configuration module: fails fast on missing/invalid env vars (see config/env.validation.ts)
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnv,
    }),

    // Rate limits: anonymous requests per client IP, authenticated requests per store
    // (TenantThrottlerGuard); auth endpoints keep stricter per-IP limits
    ThrottlerModule.forRoot({
      throttlers: [
        { name: 'default', ...globalThrottle },
        { name: TENANT_THROTTLER, ...tenantThrottle },
      ],
      skipIf: () => !isThrottleEnabled(),
    }),

    // TypeORM database module
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DB_HOST'),
        port: parseInt(configService.get('DB_PORT') || '5432', 10),
        username: configService.get('DB_USERNAME'),
        password: configService.get('DB_PASSWORD'),
        database: configService.get('DB_DATABASE'),
        entities: [__dirname + '/**/*.entity{.ts,.js}'],
        synchronize: false, // Schema changes go through migrations only
        logging: configService.get('DB_LOGGING') === 'true',
        ssl:
          configService.get('DB_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : false,
        extra: {
          // node-postgres pool
          max: Number(configService.get('DB_POOL_MAX') ?? 20),
          idleTimeoutMillis: Number(
            configService.get('DB_IDLE_TIMEOUT') ?? 30000,
          ),
          connectionTimeoutMillis: 10000,
        },
      }),
    }),

    // Application modules
    AuthModule,
    SessionsModule,
    DevicesModule,
    SyncModule,
    TenantsModule,
    MetricsModule,
    ProductsModule,
    StorageModule,
    TaxCategoriesModule,
    ImportsModule,
    JobsModule,
    SettingsModule,
    CategoriesModule,
    PriceListsModule,
    CustomersModule,
    DiscountsModule,
    InventoryModule,
    PurchasingModule,
    SalesModule,
    ReportsModule,
    UsersModule,
    HealthModule,
    AuditModule,
    RolesModule,
    ApprovalsModule,
    ShiftsModule,
    EmployeesModule,
    ReturnsModule,
    LoyaltyModule,
    StoredValueModule,
    EstimatesModule,
    ExpensesModule,
    // Outbox, idempotency, notifications, reconciliation (spec §15/§17/§18/§24)
    PlatformModule,
    IdempotencyModule,
    NotificationsModule,
    // Background report exports and saved report filters (spec §14)
    ExportsModule,
    // Print history, e-mailed / shared receipts, hardware status (spec §15)
    DocumentsModule,
    HardwareModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: TenantThrottlerGuard },
  ],
})
export class AppModule {}
