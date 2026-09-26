// Jest mocks are asserted on as detached methods
/* eslint-disable @typescript-eslint/unbound-method */
import { ConflictException, Controller } from '@nestjs/common';
import { Repository } from 'typeorm';
import { IsOptional, IsString } from 'class-validator';
import { AuditService } from '../../audit/audit.service';
import { CrudController } from './crud-controller.factory';
import {
  parseExpectedVersion,
  TenantCrudService,
  withExpectedVersion,
} from './tenant-crud.service';

interface Thing {
  id: string;
  tenantId: string;
  name: string;
  version: number;
}

/** A versioned table with one row; `bump()` simulates someone else's save */
function fakeRepository(versioned = true) {
  const row: Thing = { id: 'a1', tenantId: 't1', name: 'Old', version: 3 };
  const save = jest.fn((entity: Thing) => {
    Object.assign(row, entity, { version: row.version + 1 });
    return Promise.resolve({ ...row });
  });
  const repo = {
    metadata: {
      versionColumn: versioned ? { propertyName: 'version' } : undefined,
    },
    target: 'Thing',
    findOne: jest.fn(() => Promise.resolve({ ...row })),
    save,
    manager: {
      transaction: jest.fn((fn: (manager: unknown) => Promise<unknown>) =>
        fn({
          getRepository: () => ({
            save,
            createQueryBuilder: () => {
              const qb = {
                select: () => qb,
                where: () => qb,
                setLock: () => qb,
                getRawOne: () => Promise.resolve({ version: row.version }),
              };
              return qb;
            },
          }),
        }),
      ),
    },
  };
  return {
    row,
    repo: repo as unknown as Repository<Thing>,
    save,
    bump: () => {
      row.version += 1;
    },
  };
}

class ThingsService extends TenantCrudService<Thing> {
  protected readonly entityName = 'Thing';
}

class UpdateThingDto {
  @IsString() @IsOptional() name?: string;
}

describe('optimistic concurrency (TenantCrudService)', () => {
  it('updates when the expected version is current', async () => {
    const { repo, row } = fakeRepository();
    const service = new ThingsService(repo);
    const updated = await withExpectedVersion('a1', 3, () =>
      service.update('t1', 'a1', { name: 'New' }),
    );
    expect(updated).toMatchObject({ name: 'New', version: 4 });
    expect(row.version).toBe(4);
  });

  it('409 VERSION_CONFLICT with the current version when it moved on', async () => {
    const { repo, save } = fakeRepository();
    const service = new ThingsService(repo);
    const attempt = withExpectedVersion('a1', 2, () =>
      service.update('t1', 'a1', { name: 'New' }),
    );
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await attempt.catch((error: ConflictException) =>
      expect(error.getResponse()).toMatchObject({
        code: 'VERSION_CONFLICT',
        currentVersion: 3,
        expectedVersion: 2,
      }),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it('re-checks under the row lock (a save that landed after the read)', async () => {
    const { repo, save, bump } = fakeRepository();
    const service = new ThingsService(repo);
    // Someone saves between our read and our write
    (repo.findOne as jest.Mock).mockImplementationOnce(async () => {
      const loaded = { id: 'a1', tenantId: 't1', name: 'Old', version: 3 };
      bump();
      return Promise.resolve(loaded);
    });
    await expect(
      withExpectedVersion('a1', 3, () =>
        service.update('t1', 'a1', { name: 'Mine' }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(save).not.toHaveBeenCalled();
  });

  it('is lenient without an expected version (last write wins)', async () => {
    const { repo } = fakeRepository();
    const service = new ThingsService(repo);
    await expect(
      service.update('t1', 'a1', { name: 'New' }),
    ).resolves.toMatchObject({ name: 'New', version: 4 });
    expect(repo.manager.transaction).not.toHaveBeenCalled();
  });

  it('ignores the expected version of another record or of unversioned entities', async () => {
    const other = fakeRepository();
    await expect(
      withExpectedVersion('zzz', 1, () =>
        new ThingsService(other.repo).update('t1', 'a1', { name: 'x' }),
      ),
    ).resolves.toMatchObject({ name: 'x' });

    const unversioned = fakeRepository(false);
    await expect(
      withExpectedVersion('a1', 1, () =>
        new ThingsService(unversioned.repo).update('t1', 'a1', { name: 'y' }),
      ),
    ).resolves.toMatchObject({ name: 'y' });
  });
});

describe('parseExpectedVersion', () => {
  it('reads If-Match forms and numbers', () => {
    expect(parseExpectedVersion('3')).toBe(3);
    expect(parseExpectedVersion('"7"')).toBe(7);
    expect(parseExpectedVersion('W/"12"')).toBe(12);
    expect(parseExpectedVersion(5)).toBe(5);
    expect(parseExpectedVersion('*')).toBeUndefined();
    expect(parseExpectedVersion('abc')).toBeUndefined();
    expect(parseExpectedVersion(undefined)).toBeUndefined();
    expect(parseExpectedVersion(-1)).toBeUndefined();
  });
});

describe('CRUD controller update with If-Match', () => {
  @Controller('things')
  class ThingsController extends CrudController<Thing>(
    UpdateThingDto,
    UpdateThingDto,
    { entityType: 'thing', permission: 'settings.manage', read: 'anyMember' },
  ) {
    constructor(service: ThingsService) {
      super(service);
    }
  }

  const setup = () => {
    const db = fakeRepository();
    const controller = new ThingsController(new ThingsService(db.repo));
    Object.assign(controller, {
      auditService: { record: jest.fn() } as unknown as AuditService,
    });
    return { controller, db };
  };

  it('409 when If-Match is stale', async () => {
    const { controller } = setup();
    await expect(
      controller.update('t1', 'a1', { name: 'New' }, undefined, '2'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts expectedVersion in the body', async () => {
    const { controller } = setup();
    await expect(
      controller.update('t1', 'a1', { name: 'New' }, 3),
    ).resolves.toMatchObject({ version: 4 });
    await expect(
      controller.update('t1', 'a1', { name: 'Newer' }, 3),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('works as before without a version', async () => {
    const { controller } = setup();
    await expect(
      controller.update('t1', 'a1', { name: 'New' }),
    ).resolves.toMatchObject({ name: 'New' });
  });
});
