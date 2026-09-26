import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditLog } from '../database/entities/audit-log.entity';
import { requestContext } from '../common/context/request-context';
import { paginate } from '../common/dto/pagination.dto';
import { AuditQueryDto } from './audit.dto';
import { prefixPattern } from '../common/utils/like';

export interface AuditEntry {
  tenantId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  reason?: string | null;
  changes?:
    { before?: unknown; after?: unknown } | Record<string, unknown> | null;
  metadata?: Record<string, unknown>;
  // Defaults to the signed-in user / approver of the current request
  actorId?: string | null;
  approverId?: string | null;
}

// Never store credentials in the audit trail: a key naming a secret (password,
// token, PIN, one-time / MFA code, card number, CVV, API key, offline lease...)
// in any case or spelling (passwordHash, PIN, x-api-key, refresh_token...) is
// left out, at any depth. Keys are split into words (camelCase, snake_case,
// kebab-case) so that e.g. "shipping", "passed" or "released" are kept.
const SECRET_WORD =
  /(^|_)(pass|password|passcode|passphrase|pwd|secret|token|pin|otp|mfa_?code|card_?number|cvv|cvc|authorization|api_?key|lease)(_|$)/;

export function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase();
  return SECRET_WORD.test(words);
}

// Deeper than this, values are not stored (their keys could not be checked)
const MAX_DEPTH = 8;

export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSecretKey(key))
      .map(([key, v]) => [key, scrub(v, depth + 1)]),
  );
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private auditRepository: Repository<AuditLog>,
  ) {}

  /**
   * Append an audit event. Pass the transaction's manager so the event commits
   * (or rolls back) together with the change it describes.
   */
  async record(entry: AuditEntry, manager?: EntityManager): Promise<void> {
    const context = requestContext.get();
    const repo = manager
      ? manager.getRepository(AuditLog)
      : this.auditRepository;
    const log = repo.create({
      tenantId: entry.tenantId,
      actorId:
        entry.actorId !== undefined ? entry.actorId : (context?.userId ?? null),
      approverId:
        entry.approverId !== undefined
          ? entry.approverId
          : (context?.approverId ?? null),
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      reason: entry.reason ?? null,
      changes:
        (scrub(entry.changes ?? null) as Record<string, unknown> | null) ??
        null,
      metadata: (scrub(entry.metadata ?? {}) as Record<string, unknown>) ?? {},
      ip: context?.ip ?? null,
      requestId: context?.requestId ?? null,
    });
    // A new row without an id is always an INSERT (updates are rejected by the trigger)
    await repo.save(log);
    this.logger.debug(
      `${entry.action} ${entry.entityType}:${entry.entityId ?? '-'}`,
    );
  }

  async list(tenantId: string, query: AuditQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.auditRepository
      .createQueryBuilder('log')
      .where('log.tenantId = :tenantId', { tenantId })
      .orderBy('log.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.action)
      qb.andWhere('log.action ILIKE :action', {
        action: prefixPattern(query.action),
      });
    if (query.entityType)
      qb.andWhere('log.entityType = :entityType', {
        entityType: query.entityType,
      });
    if (query.entityId)
      qb.andWhere('log.entityId = :entityId', { entityId: query.entityId });
    if (query.actorId) {
      qb.andWhere('(log.actorId = :actorId OR log.approverId = :actorId)', {
        actorId: query.actorId,
      });
    }
    if (query.from) qb.andWhere('log.createdAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('log.createdAt <= :to', { to: query.to });

    const [rows, total] = await qb.getManyAndCount();

    // Attach display names of the people involved
    const userIds = [
      ...new Set(
        rows.flatMap((r) => [r.actorId, r.approverId]).filter(Boolean),
      ),
    ] as string[];
    const users = userIds.length
      ? await this.auditRepository.manager.query<
          {
            id: string;
            email: string;
            firstName: string | null;
            lastName: string | null;
          }[]
        >(
          `SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [userIds],
        )
      : [];
    const name = (id: string | null) => {
      const user = users.find((u) => u.id === id);
      return user
        ? [user.firstName, user.lastName].filter(Boolean).join(' ') ||
            user.email
        : null;
    };

    return paginate(
      rows.map((row) => ({
        ...row,
        actorName: name(row.actorId),
        approverName: name(row.approverId),
      })),
      total,
      page,
      limit,
    );
  }
}
