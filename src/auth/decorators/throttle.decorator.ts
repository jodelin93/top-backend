import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { authThrottle, signupThrottle } from '../../config/throttle.config';

export const IP_THROTTLE_KEY = 'throttle:perIp';

/**
 * Strict per-IP limit for credential and one-time-code endpoints. Counted per client
 * IP even when the request carries a token (unlike the normal per-store limit).
 */
export const AuthThrottle = () =>
  applyDecorators(
    Throttle({ default: authThrottle }),
    SetMetadata(IP_THROTTLE_KEY, true),
  );

/** Per-IP limit for creating stores. */
export const SignupThrottle = () =>
  applyDecorators(
    Throttle({ default: signupThrottle }),
    SetMetadata(IP_THROTTLE_KEY, true),
  );
