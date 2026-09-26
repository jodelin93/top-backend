import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import {
  assertBranchAccess,
  assertRegisterAccess,
  branchScope,
  branchWhere,
} from '../auth/branch-scope';
import { Drawer, DrawerStatus } from '../database/entities/drawer.entity';
import { Register } from '../database/entities/register.entity';
import { Shift, ShiftStatus } from '../database/entities/shift.entity';
import { AuditService } from '../audit/audit.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import {
  CreateDrawerDto,
  ListDrawersQueryDto,
  UpdateDrawerDto,
} from './shifts.dto';

/** Cash drawers of the registers (one "MAIN" drawer is created with each register) */
@Injectable()
export class DrawersService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async list(tenantId: string, query: ListDrawersQueryDto) {
    // Only the drawers of the user's branches' registers (spec §9)
    const scope = branchScope();
    const registerIds =
      scope === null
        ? null
        : (
            await this.dataSource.getRepository(Register).find({
              where: { tenantId, ...branchWhere(scope) },
              select: { id: true },
            })
          ).map((r) => r.id);
    const drawers = await this.dataSource.getRepository(Drawer).find({
      where: {
        tenantId,
        ...(query.registerId ? { registerId: query.registerId } : {}),
        ...(registerIds && {
          registerId: In(
            query.registerId
              ? registerIds.filter((id) => id === query.registerId)
              : registerIds,
          ),
        }),
      },
      order: { registerId: 'ASC', code: 'ASC' },
    });
    if (drawers.length === 0) return [];
    // The running shift of each drawer, so the till can pick a free one
    const active = await this.dataSource.getRepository(Shift).find({
      where: {
        tenantId,
        drawerId: In(drawers.map((d) => d.id)),
        status: In([ShiftStatus.OPEN, ShiftStatus.CLOSING]),
      },
      select: {
        id: true,
        drawerId: true,
        shiftNumber: true,
        openedById: true,
        shared: true,
      },
    });
    const byDrawer = new Map(active.map((sh) => [sh.drawerId, sh]));
    return drawers.map((d) => {
      const shift = byDrawer.get(d.id);
      return {
        id: d.id,
        registerId: d.registerId,
        code: d.code,
        name: d.name,
        status: d.status,
        version: d.version,
        activeShift: shift
          ? {
              id: shift.id,
              shiftNumber: shift.shiftNumber,
              openedById: shift.openedById,
              shared: shift.shared,
            }
          : null,
      };
    });
  }

  async create(tenantId: string, dto: CreateDrawerDto) {
    const register = await this.dataSource
      .getRepository(Register)
      .findOne({ where: { id: dto.registerId, tenantId } });
    if (!register) throw new NotFoundException('Register not found');
    assertBranchAccess(null, register.branchId, 'Register not found');
    const repo = this.dataSource.getRepository(Drawer);
    try {
      const saved = await repo.save(
        repo.create({
          tenantId,
          registerId: register.id,
          code: dto.code.trim().toUpperCase(),
          name: dto.name.trim(),
          status: DrawerStatus.ACTIVE,
        }),
      );
      await this.auditService.record({
        tenantId,
        action: 'drawer.created',
        entityType: 'drawer',
        entityId: saved.id,
        changes: {
          after: {
            registerId: saved.registerId,
            code: saved.code,
            name: saved.name,
          },
        },
      });
      return saved;
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_drawer_code')) {
        throw new ConflictException(
          'This register already has a drawer with that code',
        );
      }
      throw error;
    }
  }

  async update(tenantId: string, id: string, dto: UpdateDrawerDto) {
    const repo = this.dataSource.getRepository(Drawer);
    const drawer = await repo.findOne({ where: { id, tenantId } });
    if (!drawer) throw new NotFoundException('Drawer not found');
    await assertRegisterAccess(
      this.dataSource.manager,
      tenantId,
      drawer.registerId,
      'Drawer not found',
    );
    const before = { name: drawer.name, status: drawer.status };
    if (
      dto.status === DrawerStatus.INACTIVE &&
      drawer.status !== DrawerStatus.INACTIVE
    ) {
      const running = await this.dataSource.getRepository(Shift).count({
        where: {
          tenantId,
          drawerId: id,
          status: In([ShiftStatus.OPEN, ShiftStatus.CLOSING]),
        },
      });
      if (running > 0) {
        throw new BadRequestException(
          'Close the shift running on this drawer before deactivating it',
        );
      }
      const others = await repo.count({
        where: {
          tenantId,
          registerId: drawer.registerId,
          status: DrawerStatus.ACTIVE,
        },
      });
      if (others <= 1) {
        throw new BadRequestException(
          'A register needs at least one active drawer',
        );
      }
    }
    if (dto.name !== undefined) drawer.name = dto.name.trim();
    if (dto.status !== undefined) drawer.status = dto.status;
    const saved = await repo.save(drawer);
    await this.auditService.record({
      tenantId,
      action: 'drawer.updated',
      entityType: 'drawer',
      entityId: id,
      changes: { before, after: { name: saved.name, status: saved.status } },
    });
    return saved;
  }
}
