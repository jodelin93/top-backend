import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { getJwtSecret } from '../config/jwt.config';
import { ApprovalsService } from './approvals.service';
import { ApprovalsController } from './approvals.controller';
import { ApprovalUsesInterceptor } from './approval-uses.interceptor';

// Global: PermissionsGuard (used in every module) verifies approval tokens
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([User, TenantMembership, TenantRole]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: getJwtSecret(configService),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ApprovalsController],
  providers: [
    ApprovalsService,
    // Gives back the approvals of a failed request; adds `action` to approval 403s
    { provide: APP_INTERCEPTOR, useClass: ApprovalUsesInterceptor },
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
