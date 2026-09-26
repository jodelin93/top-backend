import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'crypto';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import { UserSession } from './user-session.entity';
import { SessionStatus, sessionStatus, shouldTouch } from './session-state';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { TenantMembership } from '../database/entities/tenant-membership.entity';

// Revocations on this instance apply at once; on other instances within this delay
const CACHE_TTL_MS = 10_000;
const CACHE_MAX_ENTRIES = 10_000;

interface CachedSession {
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
  lastSeenAt: Date;
  cachedAt: number;
}

export interface SessionView {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  deviceId: string | null;
  authMethod: string;
  tenantId: string | null;
  current: boolean;
}

export interface NewSession {
  userId: string;
  tenantId: string | null;
  expiresAt: Date;
  authMethod: 'password' | 'mfa' | 'signup';
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);
  private readonly cache = new Map<string, CachedSession>();

  constructor(
    @InjectRepository(UserSession)
    private readonly sessionRepository: Repository<UserSession>,
    @InjectRepository(TenantMembership)
    private readonly membershipRepository: Repository<TenantMembership>,
    private readonly auditService: AuditService,
  ) {}

  /** A fresh session id, to embed in the token before the row is written. */
  newId(): string {
    return randomUUID();
  }

  async create(id: string, input: NewSession): Promise<UserSession> {
    const context = requestContext.get();
    const now = new Date();
    const session = await this.sessionRepository.save(
      this.sessionRepository.create({
        id,
        userId: input.userId,
        tenantId: input.tenantId,
        expiresAt: input.expiresAt,
        lastSeenAt: now,
        authMethod: input.authMethod,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
        deviceId: context?.deviceId ?? null,
        revokedAt: null,
        revokedReason: null,
      }),
    );
    if (input.tenantId) {
      await this.auditService.record({
        tenantId: input.tenantId,
        actorId: input.userId,
        action: 'session.created',
        entityType: 'session',
        entityId: id,
        metadata: {
          authMethod: input.authMethod,
          userAgent: session.userAgent,
          deviceId: session.deviceId,
        },
      });
    }
    return session;
  }

  /**
   * Is the session behind a token still usable? Cached briefly; lastSeenAt is
   * refreshed at most every few minutes.
   */
  async check(sessionId: string, userId: string): Promise<SessionStatus> {
    const now = new Date();
    let entry = this.cache.get(sessionId);
    if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) {
      const row = await this.sessionRepository.findOne({
        where: { id: sessionId },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          expiresAt: true,
          lastSeenAt: true,
        },
      });
      if (!row) {
        this.cache.delete(sessionId);
        return 'revoked';
      }
      entry = {
        userId: row.userId,
        revokedAt: row.revokedAt,
        expiresAt: row.expiresAt,
        lastSeenAt: row.lastSeenAt,
        cachedAt: Date.now(),
      };
      this.remember(sessionId, entry);
    }
    if (entry.userId !== userId) return 'revoked';

    const status = sessionStatus(entry, now);
    if (status === 'active' && shouldTouch(entry.lastSeenAt, now)) {
      entry.lastSeenAt = now;
      void this.sessionRepository
        .update({ id: sessionId }, { lastSeenAt: now })
        .catch((err: unknown) =>
          this.logger.warn(`Could not update session activity: ${String(err)}`),
        );
    }
    return status;
  }

  /** Active sessions of a user, newest activity first. */
  async listForUser(
    userId: string,
    currentSessionId: string | null,
    tenantId?: string,
  ): Promise<SessionView[]> {
    const rows = await this.sessionRepository.find({
      where: {
        userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
        ...(tenantId && { tenantId }),
      },
      order: { lastSeenAt: 'DESC' },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      expiresAt: row.expiresAt,
      ip: row.ip,
      userAgent: row.userAgent,
      deviceId: row.deviceId,
      authMethod: row.authMethod,
      tenantId: row.tenantId,
      current: row.id === currentSessionId,
    }));
  }

  /** Sign out one of the user's own sessions. */
  async revokeOwn(
    userId: string,
    sessionId: string,
    reason: string,
    tenantId: string | null,
  ): Promise<void> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId, userId },
    });
    if (!session) throw new NotFoundException('Session not found');
    if (!session.revokedAt) {
      await this.markRevoked([sessionId], reason);
      await this.audit(
        tenantId ?? session.tenantId,
        'session.revoked',
        userId,
        {
          sessionId,
          reason,
        },
      );
    }
  }

  /**
   * Revoke every active session of a user; optionally only those in one store
   * and/or keeping one (the caller's own).
   */
  async revokeAllForUser(
    userId: string,
    reason: string,
    options: { tenantId?: string; exceptSessionId?: string | null } = {},
  ): Promise<number> {
    const rows = await this.sessionRepository.find({
      select: { id: true },
      where: {
        userId,
        revokedAt: IsNull(),
        expiresAt: MoreThan(new Date()),
        ...(options.tenantId && { tenantId: options.tenantId }),
        ...(options.exceptSessionId && { id: Not(options.exceptSessionId) }),
      },
    });
    const ids = rows.map((r) => r.id);
    await this.markRevoked(ids, reason);
    return ids.length;
  }

  /** "Sign out everywhere else": every session except the caller's. */
  async revokeOthers(
    userId: string,
    currentSessionId: string | null,
    tenantId: string | null,
  ): Promise<number> {
    const count = await this.revokeAllForUser(userId, 'signed_out_everywhere', {
      exceptSessionId: currentSessionId,
    });
    await this.audit(tenantId, 'session.revoked_others', userId, { count });
    return count;
  }

  /** Admin: sign a store member out of every session in this store. */
  async revokeMember(
    tenantId: string,
    userId: string,
    reason = 'revoked_by_admin',
  ): Promise<number> {
    const member = await this.membershipRepository.findOne({
      where: { tenantId, userId },
    });
    if (!member) throw new NotFoundException('Member not found');
    const count = await this.revokeAllForUser(userId, reason, { tenantId });
    await this.audit(tenantId, 'user.sessions_revoked', userId, {
      count,
      reason,
    });
    return count;
  }

  async listForMember(tenantId: string, userId: string) {
    const member = await this.membershipRepository.findOne({
      where: { tenantId, userId },
    });
    if (!member) throw new NotFoundException('Member not found');
    return this.listForUser(userId, null, tenantId);
  }

  /** Point a session at another store (store switch). */
  async setTenant(
    sessionId: string,
    userId: string,
    tenantId: string,
    expiresAt?: Date,
  ): Promise<void> {
    const result = await this.sessionRepository.update(
      { id: sessionId, userId, revokedAt: IsNull() },
      { tenantId, ...(expiresAt && { expiresAt }) },
    );
    this.cache.delete(sessionId);
    if (!result.affected) {
      throw new ForbiddenException('This session has been signed out');
    }
  }

  /**
   * A till was revoked or marked lost: sign out every session opened on it, so
   * a stolen till can't keep working on its tokens by leaving the device id out.
   */
  async revokeForDevice(
    tenantId: string,
    deviceId: string,
    reason: string,
  ): Promise<number> {
    const rows = await this.sessionRepository.find({
      select: { id: true },
      where: { deviceId, revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    });
    const ids = rows.map((r) => r.id);
    await this.markRevoked(ids, reason);
    if (ids.length) {
      await this.auditService.record({
        tenantId,
        action: 'device.sessions_revoked',
        entityType: 'device',
        entityId: deviceId,
        metadata: { count: ids.length, reason },
      });
    }
    return ids.length;
  }

  /** Audit + revoke helper used by the users service (suspension, role change...). */
  async revokeForMemberChange(
    tenantId: string,
    userId: string,
    reason: string,
    allStores = false,
  ): Promise<number> {
    const count = await this.revokeAllForUser(
      userId,
      reason,
      allStores ? {} : { tenantId },
    );
    if (count > 0) {
      await this.audit(tenantId, 'user.sessions_revoked', userId, {
        count,
        reason,
      });
    }
    return count;
  }

  private async markRevoked(ids: string[], reason: string): Promise<void> {
    if (ids.length === 0) return;
    const now = new Date();
    await this.sessionRepository
      .createQueryBuilder()
      .update(UserSession)
      .set({ revokedAt: now, revokedReason: reason.slice(0, 50) })
      .whereInIds(ids)
      .andWhere('"revokedAt" IS NULL')
      .execute();
    ids.forEach((id) => this.cache.delete(id));
  }

  private async audit(
    tenantId: string | null,
    action: string,
    userId: string,
    metadata: Record<string, unknown>,
  ) {
    if (!tenantId) return;
    await this.auditService.record({
      tenantId,
      action,
      entityType: metadata.sessionId ? 'session' : 'user',
      entityId: (metadata.sessionId as string | undefined) ?? userId,
      metadata,
    });
  }

  private remember(id: string, entry: CachedSession) {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Drop the oldest entry (Map keeps insertion order)
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(id, entry);
  }
}
