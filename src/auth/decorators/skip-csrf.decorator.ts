import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'skipCsrf';

/**
 * Machine-to-machine endpoints that never see a browser session cookie and
 * authenticate by their own means (payment webhook signatures, the backup
 * script's shared secret) are exempt from the CSRF header check (CsrfGuard).
 */
export const SkipCsrf = () => SetMetadata(SKIP_CSRF_KEY, true);
