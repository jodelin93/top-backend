import { Global, Module } from '@nestjs/common';
import { IDEMPOTENCY_STORE, PgIdempotencyStore } from './idempotency.store';
import { IdempotencyInterceptor } from './idempotency.interceptor';

// Global so @Idempotent() works on any controller
@Global()
@Module({
  providers: [
    { provide: IDEMPOTENCY_STORE, useClass: PgIdempotencyStore },
    IdempotencyInterceptor,
  ],
  exports: [IDEMPOTENCY_STORE, IdempotencyInterceptor],
})
export class IdempotencyModule {}
