import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../database/entities/user.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, TenantMembership])],
  controllers: [UsersController],
  providers: [UsersService],
  // Employees deactivate a linked login through it
  exports: [UsersService],
})
export class UsersModule {}
