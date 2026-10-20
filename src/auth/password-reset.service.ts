import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import { UserStatus } from '../database/entities/user.entity';
import {
  EMAIL_CHANNEL,
  type EmailChannel,
} from '../notifications/email/email-channel';
import { maskEmailsIn } from '../documents/print-job-rules';
import { returnedRows } from '../sales/special-tenders';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../sessions/sessions.service';
import { AuthService } from './auth.service';
import { passwordResetEmail, resetLanguage } from './password-reset-email';

// A link is valid this long, and works once
export const RESET_LINK_MINUTES = 30;
// At most this many links per account per hour (the endpoint is also limited per IP)
export const MAX_LINKS_PER_HOUR = 3;

const hashToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export const INVALID_RESET_LINK =
  'This link is invalid or has expired. Ask for a new one.';

/**
 * "Forgot password": e-mails a single-use link to choose a new password.
 *
 * - The answer never says whether an account exists (same response, the e-mail
 *   is sent in the background).
 * - Only the SHA-256 of the token is stored; a new link replaces the older ones.
 * - Choosing the new password signs out every session of the account and
 *   clears a lockout; two-factor authentication (if on) is still asked at sign-in.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @InjectDataSource() private dataSource: DataSource,
    @Inject(EMAIL_CHANNEL) private email: EmailChannel,
    private authService: AuthService,
    private sessionsService: SessionsService,
    private auditService: AuditService,
    @Optional() private configService?: ConfigService,
  ) {}

  private appUrl(): string | null {
    const url =
      this.configService?.get<string>('APP_URL') ||
      this.configService?.get<string>('FRONTEND_URL') ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL;
    return url ? url.replace(/\/+$/, '') : null;
  }

  /** Always resolves the same way; the e-mail (if any) goes out in the background */
  async request(
    email: string,
    language: unknown,
    ip: string | null,
  ): Promise<void> {
    const appUrl = this.appUrl();
    if (!this.email.enabled || !appUrl) {
      this.logger.warn(
        'Password reset asked but e-mail (SMTP_HOST) or APP_URL is not configured',
      );
      return;
    }
    const [user] = await this.dataSource.query<
      { id: string; email: string; firstName: string | null }[]
    >(
      `SELECT id, email, "firstName" FROM users
        WHERE email = $1 AND status = $2`,
      [email.trim().toLowerCase(), UserStatus.ACTIVE],
    );
    if (!user) return;

    const [{ recent }] = await this.dataSource.query<{ recent: number }[]>(
      `SELECT count(*)::int AS recent FROM password_reset_tokens
        WHERE "userId" = $1 AND "createdAt" > now() - interval '1 hour'`,
      [user.id],
    );
    if (recent >= MAX_LINKS_PER_HOUR) {
      this.logger.warn(`Password reset: hourly limit reached for ${user.id}`);
      return;
    }

    const token = randomBytes(32).toString('base64url');
    // A new link replaces the unused older ones
    await this.dataSource.query(
      `DELETE FROM password_reset_tokens WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [user.id],
    );
    await this.dataSource.query(
      `INSERT INTO password_reset_tokens ("userId", "tokenHash", "expiresAt", "requestedIp")
       VALUES ($1, $2, now() + make_interval(mins => $3), $4)`,
      [user.id, hashToken(token), RESET_LINK_MINUTES, ip?.slice(0, 64) ?? null],
    );

    const [store] = await this.dataSource.query<{ name: string }[]>(
      `SELECT t.name FROM tenant_memberships m JOIN tenants t ON t.id = m."tenantId"
        WHERE m."userId" = $1 AND m.status = 'active'
        ORDER BY m."joinedAt" LIMIT 1`,
      [user.id],
    );
    const message = passwordResetEmail({
      link: `${appUrl}/auth/reset-password?token=${token}`,
      firstName: user.firstName,
      storeName: store?.name ?? null,
      language: resetLanguage(language),
      minutes: RESET_LINK_MINUTES,
    });
    // Not awaited: the response time doesn't depend on the e-mail being sent
    void this.email
      .send({ to: user.email, ...message })
      .catch((error) =>
        this.logger.warn(
          `Could not e-mail a password reset link: ${maskEmailsIn(error instanceof Error ? error.message : String(error))}`,
        ),
      );
    await this.audit(user.id, 'user.password_reset_requested');
  }

  /** Sets the new password with a link from request(); the link stops working */
  async reset(token: string, newPassword: string): Promise<void> {
    const [row] = returnedRows<{ userId: string }>(
      await this.dataSource.query(
        `UPDATE password_reset_tokens SET "usedAt" = now()
          WHERE "tokenHash" = $1 AND "usedAt" IS NULL AND "expiresAt" > now()
          RETURNING "userId"`,
        [hashToken(token)],
      ),
    );
    if (!row) throw new BadRequestException(INVALID_RESET_LINK);

    const passwordHash = await this.authService.hashPassword(newPassword);
    const updated = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE users SET "passwordHash" = $2, "failedLoginCount" = 0, "lockedUntil" = NULL
          WHERE id = $1 AND status = $3
          RETURNING id`,
        [row.userId, passwordHash, UserStatus.ACTIVE],
      ),
    );
    if (!updated.length) {
      throw new BadRequestException(INVALID_RESET_LINK);
    }
    await this.dataSource.query(
      `DELETE FROM password_reset_tokens WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [row.userId],
    );
    await this.sessionsService.revokeAllForUser(row.userId, 'password_reset');
    await this.audit(row.userId, 'user.password_reset');
  }

  /** In every store the person belongs to (auditing never blocks the reset) */
  private async audit(userId: string, action: string): Promise<void> {
    try {
      const memberships = await this.dataSource.query<{ tenantId: string }[]>(
        `SELECT "tenantId" FROM tenant_memberships WHERE "userId" = $1 AND status = 'active'`,
        [userId],
      );
      for (const m of memberships) {
        await this.auditService.record({
          tenantId: m.tenantId,
          actorId: userId,
          action,
          entityType: 'user',
          entityId: userId,
        });
      }
    } catch (err) {
      this.logger.warn(`Could not audit ${action}: ${String(err)}`);
    }
  }
}
