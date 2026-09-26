import { SetMetadata } from '@nestjs/common';

export const ALLOW_MFA_SETUP_KEY = 'allowDuringMfaSetup';

/**
 * Reachable by a user who must set up two-factor authentication first (store policy
 * "requireMfaForAdmins"). Every other authenticated route answers 403 MFA_SETUP_REQUIRED.
 */
export const AllowDuringMfaSetup = () => SetMetadata(ALLOW_MFA_SETUP_KEY, true);
