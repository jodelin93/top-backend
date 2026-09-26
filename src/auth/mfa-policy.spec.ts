import { requiresMfaSetup } from './mfa-policy';

describe('requireMfaForAdmins policy', () => {
  const on = { requireMfaForAdmins: true };

  it('requires setup for privileged members without two-factor', () => {
    expect(requiresMfaSetup({ mfaEnabled: false }, ['users.manage'], on)).toBe(
      true,
    );
    expect(requiresMfaSetup({ mfaEnabled: false }, ['audit.view'], on)).toBe(
      true,
    );
  });

  it('leaves cashiers, members with two-factor and stores without the policy alone', () => {
    expect(requiresMfaSetup({ mfaEnabled: false }, ['pos.sell'], on)).toBe(
      false,
    );
    expect(requiresMfaSetup({ mfaEnabled: true }, ['users.manage'], on)).toBe(
      false,
    );
    expect(
      requiresMfaSetup({ mfaEnabled: false }, ['users.manage'], {
        requireMfaForAdmins: false,
      }),
    ).toBe(false);
  });
});
