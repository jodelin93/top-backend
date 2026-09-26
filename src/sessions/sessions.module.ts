import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserSession } from './user-session.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { SessionsService } from './sessions.service';
import { SessionsController } from './sessions.controller';
import { UsersModule } from '../users/users.module';

// Global: the JWT strategy and the users service revoke / check sessions
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature([UserSession, TenantMembership]),
    // Admin session routes apply the same member-management limits
    UsersModule,
  ],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
