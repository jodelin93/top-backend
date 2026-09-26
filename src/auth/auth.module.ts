import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule, JwtSignOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { User } from '../database/entities/user.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { getJwtSecret } from '../config/jwt.config';
import { SettingsModule } from '../settings/settings.module';
import { SensitiveFieldsInterceptor } from './sensitive-fields.interceptor';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, TenantMembership, TenantRole]),
    PassportModule,
    // Store policy (requireMfaForAdmins); sessions come from the global SessionsModule
    SettingsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: getJwtSecret(configService),
        signOptions: {
          // Validated by the env schema (e.g. 24h, 30m)
          expiresIn: (configService.get<string>('JWT_EXPIRES_IN') ??
            '24h') as JwtSignOptions['expiresIn'],
        },
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    AuthService,
    JwtStrategy,
    LocalStrategy,
    // Costs and customer balances only for those allowed to see them
    { provide: APP_INTERCEPTOR, useClass: SensitiveFieldsInterceptor },
  ],
  controllers: [AuthController],
  // JwtModule: the global rate limiter reads the store from access tokens
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
