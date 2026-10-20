import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import type { SessionsService } from '../sessions/sessions.service';
import type { AuthService } from './auth.service';
import {
  INVALID_RESET_LINK,
  MAX_LINKS_PER_HOUR,
  PasswordResetService,
} from './password-reset.service';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

describe('PasswordResetService', () => {
  let rows: {
    user?: { id: string; email: string; firstName: string | null };
    recent: number;
    tokenOwner?: string;
    updatedUser: boolean;
  };
  type Sent = { to: string; subject: string; text: string };
  let query: jest.Mock<Promise<unknown>, [string, unknown[]?]>;
  let email: { enabled: boolean; send: jest.Mock<Promise<void>, [Sent]> };
  const sessions = { revokeAllForUser: jest.fn() };
  const audit = { record: jest.fn() };
  const auth = {
    hashPassword: jest.fn((p: string) => Promise.resolve(`hash:${p}`)),
  };
  const config = {
    get: jest.fn((k: string) =>
      k === 'APP_URL' ? 'https://pos.example.com/' : undefined,
    ),
  };

  const service = () =>
    new PasswordResetService(
      { query } as unknown as DataSource,
      email,
      auth as unknown as AuthService,
      sessions as unknown as SessionsService,
      audit as unknown as AuditService,
      config as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    rows = { recent: 0, updatedUser: true };
    email = {
      enabled: true,
      send: jest.fn<Promise<void>, [Sent]>().mockResolvedValue(undefined),
    };
    query = jest.fn((sql: string): Promise<unknown> =>
      Promise.resolve(answer(sql)),
    );
  });

  const answer = (sql: string): unknown => {
    if (sql.includes('FROM users')) return rows.user ? [rows.user] : [];
    if (sql.includes('count(*)')) return [{ recent: rows.recent }];
    if (sql.includes('FROM tenant_memberships m JOIN tenants'))
      return [{ name: 'Top Service' }];
    if (sql.includes('SELECT "tenantId" FROM tenant_memberships'))
      return [{ tenantId: 't1' }];
    if (sql.startsWith('UPDATE password_reset_tokens'))
      return [rows.tokenOwner ? [{ userId: rows.tokenOwner }] : [], 0];
    if (sql.trim().startsWith('UPDATE users'))
      return [rows.updatedUser ? [{ id: 'u1' }] : [], 0];
    return [];
  };

  const inserted = () =>
    query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO password_reset_tokens'),
    );

  it('does nothing for an unknown email, with the same (empty) answer', async () => {
    await expect(
      service().request('nobody@x.com', 'en', null),
    ).resolves.toBeUndefined();
    expect(inserted()).toBeUndefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('stores only the hash of the token and e-mails the link in the asked language', async () => {
    rows.user = { id: 'u1', email: 'owner@x.com', firstName: 'Marie' };
    await service().request(' Owner@X.com ', 'fr', '1.2.3.4');

    expect(query.mock.calls[0][1]).toEqual(['owner@x.com', 'active']);
    const message = email.send.mock.calls[0][0];
    expect(message.to).toBe('owner@x.com');
    expect(message.subject).toBe(
      'Top Service: Réinitialiser votre mot de passe',
    );
    const token = /reset-password\?token=([A-Za-z0-9_-]{43})/.exec(
      message.text,
    )![1];
    expect(message.text).toContain(
      'https://pos.example.com/auth/reset-password?token=',
    );
    const params = inserted()![1] as unknown[];
    expect(params[1]).toBe(sha256(token));
    expect(params).not.toContain(token);
    // Older unused links are replaced
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).startsWith('DELETE FROM password_reset_tokens'),
      ),
    ).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_reset_requested',
        tenantId: 't1',
      }),
    );
  });

  it(`stops after ${MAX_LINKS_PER_HOUR} links in an hour`, async () => {
    rows.user = { id: 'u1', email: 'owner@x.com', firstName: null };
    rows.recent = MAX_LINKS_PER_HOUR;
    await service().request('owner@x.com', 'en', null);
    expect(inserted()).toBeUndefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  it('sends nothing when e-mail is not configured', async () => {
    rows.user = { id: 'u1', email: 'owner@x.com', firstName: null };
    email.enabled = false;
    await service().request('owner@x.com', 'en', null);
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses an unknown, used or expired link', async () => {
    await expect(service().reset('a'.repeat(43), 'NewPass123')).rejects.toThrow(
      new BadRequestException(INVALID_RESET_LINK),
    );
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it('sets the new password, clears the lockout and signs out every session', async () => {
    rows.tokenOwner = 'u1';
    const token = 'b'.repeat(43);
    await service().reset(token, 'NewPass123');

    const consume = query.mock.calls.find(([sql]) =>
      String(sql).startsWith('UPDATE password_reset_tokens'),
    )!;
    expect(consume[1]).toEqual([sha256(token)]);
    const update = query.mock.calls.find(([sql]) =>
      String(sql).trim().startsWith('UPDATE users'),
    )!;
    expect(String(update[0])).toContain('"lockedUntil" = NULL');
    expect(update[1]).toEqual(['u1', 'hash:NewPass123', 'active']);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(
      'u1',
      'password_reset',
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password_reset',
        entityId: 'u1',
      }),
    );
  });

  it('refuses the link of an account that was deactivated meanwhile', async () => {
    rows.tokenOwner = 'u1';
    rows.updatedUser = false;
    await expect(service().reset('c'.repeat(43), 'NewPass123')).rejects.toThrow(
      INVALID_RESET_LINK,
    );
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });
});
