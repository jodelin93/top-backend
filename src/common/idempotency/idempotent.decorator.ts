import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import {
  IdempotencyInterceptor,
  IDEMPOTENT_METADATA,
  IdempotentOptions,
} from './idempotency.interceptor';

/**
 * Makes a command route idempotent with the `Idempotency-Key` header
 * (see IdempotencyInterceptor). `commandType` names the command, e.g.
 * 'expense.pay'; it is part of the request fingerprint.
 */
export const Idempotent = (commandType: string) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_METADATA, {
      commandType,
    } satisfies IdempotentOptions),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description:
        'Unique key per command (e.g. a UUID). Retrying with the same key returns the first response instead of running the command again.',
    }),
  );
