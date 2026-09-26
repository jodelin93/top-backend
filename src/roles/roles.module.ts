import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';

// Global so any module (e.g. tenant provisioning) can seed and look up roles
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TenantRole, TenantMembership])],
  controllers: [RolesController],
  providers: [RolesService],
  exports: [RolesService],
})
export class RolesModule {}
