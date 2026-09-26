import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { Tenant, TenantStatus } from '../database/entities/tenant.entity';
import { User, UserStatus } from '../database/entities/user.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { OWNER_ROLE } from '../auth/permissions';
import { RolesService } from '../roles/roles.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, LoginResponse } from '../auth/auth.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { SignupDto } from './tenants.dto';
import {
  assertNotLocked,
  consumeTotp,
  passwordMatches,
  recordFailedAttempt,
} from '../auth/credentials';
import { slugify } from './slug';

export interface SignupResponse extends LoginResponse {
  tenant: { id: string; name: string; slug: string };
}

@Injectable()
export class TenantsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly rolesService: RolesService,
    private readonly settingsService: SettingsService,
    private readonly auditService: AuditService,
    private readonly authService: AuthService,
  ) {}

  isSignupEnabled(): boolean {
    return this.config.get<string>('ALLOW_SIGNUP') === 'true';
  }

  /**
   * Create a store in one transaction: tenant, owner (new account, or an existing one
   * after checking its password), built-in roles, default branch/register/payment
   * methods and the first settings version. Then sign the owner in to it.
   */
  async signup(dto: SignupDto): Promise<SignupResponse> {
    if (!this.isSignupEnabled()) {
      throw new NotFoundException('Store sign-up is not enabled');
    }
    const email = dto.email.trim().toLowerCase();
    const name = dto.storeName.trim();

    let result: { tenant: Tenant; user: User };
    try {
      result = await this.dataSource.transaction(async (manager) => {
        const user = await this.ownerAccount(manager, email, dto);
        const slug = await this.uniqueSlug(manager, dto.slug ?? slugify(name));
        const tenant = await manager.getRepository(Tenant).save(
          manager.getRepository(Tenant).create({
            name,
            slug,
            status: TenantStatus.ACTIVE,
            settings: dto.currencyCode
              ? { currencyCode: dto.currencyCode.toUpperCase() }
              : {},
          }),
        );
        await manager.getRepository(TenantMembership).save(
          manager.getRepository(TenantMembership).create({
            tenantId: tenant.id,
            userId: user.id,
            role: OWNER_ROLE,
            status: MembershipStatus.ACTIVE,
          }),
        );
        await this.rolesService.ensureSystemRoles(tenant.id, manager);
        await this.settingsService.initializeDefaults(tenant.id, manager);
        await this.settingsService.recordInitialVersion(tenant.id, manager);
        await this.auditService.record(
          {
            tenantId: tenant.id,
            actorId: user.id,
            action: 'tenant.created',
            entityType: 'tenant',
            entityId: tenant.id,
            changes: { after: { name, slug, ownerEmail: email } },
            metadata: { source: 'signup' },
          },
          manager,
        );
        return { tenant, user };
      });
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          'That store address or email is already taken. Try again.',
        );
      }
      throw err;
    }

    const session = await this.authService.startSession(
      result.user,
      result.tenant.id,
      'signup',
    );
    return {
      ...session,
      tenant: {
        id: result.tenant.id,
        name: result.tenant.name,
        slug: result.tenant.slug,
      },
    };
  }

  private async ownerAccount(
    manager: EntityManager,
    email: string,
    dto: SignupDto,
  ): Promise<User> {
    const repo = manager.getRepository(User);
    const existing = await repo.findOne({ where: { email } });
    if (existing) {
      // Adding a store to an existing account is a sign-in: same lockout, and
      // the second factor when it's on (else signup would skip two-factor)
      assertNotLocked(existing);
      if (!(await passwordMatches(existing, dto.password))) {
        await recordFailedAttempt(this.dataSource, existing.id);
        throw new UnauthorizedException(
          'This email and password could not be used. If you already have an account, enter its current password.',
        );
      }
      if (existing.status !== UserStatus.ACTIVE) {
        throw new ForbiddenException('This account is not active');
      }
      if (
        existing.mfaEnabled &&
        !(await consumeTotp(this.dataSource, existing, dto.mfaCode))
      ) {
        await recordFailedAttempt(this.dataSource, existing.id);
        throw new UnauthorizedException({
          message:
            'This account uses two-factor authentication. Enter a current code from your authenticator app.',
          code: 'MFA_REQUIRED',
        });
      }
      return existing;
    }
    return repo.save(
      repo.create({
        email,
        firstName: dto.firstName?.trim() || undefined,
        lastName: dto.lastName?.trim() || undefined,
        passwordHash: await bcrypt.hash(
          dto.password,
          Number(this.config.get('BCRYPT_ROUNDS') ?? 12),
        ),
        status: UserStatus.ACTIVE,
      }),
    );
  }

  private async uniqueSlug(manager: EntityManager, base: string) {
    const repo = manager.getRepository(Tenant);
    if (!(await repo.exists({ where: { slug: base } }))) return base;
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `${base.slice(0, 43)}-${randomBytes(3).toString('hex')}`;
      if (!(await repo.exists({ where: { slug: candidate } })))
        return candidate;
    }
    throw new ConflictException('Could not find a free store address');
  }
}
