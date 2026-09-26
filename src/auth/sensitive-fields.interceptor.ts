import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { map, Observable } from 'rxjs';
import type { AuthUser } from './strategies/jwt.strategy';
import { hiddenFieldsFor, redactFields } from './sensitive-fields';

/**
 * Global. Leaves costs (without inventory.cost.view) and customer balances / credit
 * limits (without customers.finance.view) out of every response, see SENSITIVE_FIELDS.
 * Public routes (no signed-in user) are not touched.
 */
@Injectable()
export class SensitiveFieldsInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const { user } = context
      .switchToHttp()
      .getRequest<{ user?: Partial<AuthUser> }>();
    if (!user) return next.handle();
    const hidden = hiddenFieldsFor(user.permissions);
    if (!hidden.size) return next.handle();
    return next
      .handle()
      .pipe(map((body: unknown) => redactFields(body, hidden)));
  }
}
