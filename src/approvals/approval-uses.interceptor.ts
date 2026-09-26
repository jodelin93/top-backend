import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { catchError, from, Observable, switchMap, throwError } from 'rxjs';
import { ApprovalsService } from './approvals.service';
import { currentApprovalScope } from './approval-scope';

/**
 * Global. Approval tokens are used up when the approved action goes through:
 * - a request that fails gives back the tokens it claimed (verify), so the
 *   cashier can retry with the same approval;
 * - a 403 asking for an approval (from PermissionsGuard or a service) carries the
 *   `action` it is for, which the client sends to POST /approvals.
 */
@Injectable()
export class ApprovalUsesInterceptor implements NestInterceptor {
  constructor(private approvalsService: ApprovalsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    return next.handle().pipe(
      catchError((error: unknown) => {
        const scope = currentApprovalScope();
        const claimed = scope?.claimed.splice(0) ?? [];
        return from(
          this.approvalsService.release(claimed).catch(() => undefined),
        ).pipe(
          switchMap(() => throwError(() => withAction(error, scope?.action))),
        );
      }),
    );
  }
}

function withAction(error: unknown, action: string | undefined): unknown {
  if (!action || !(error instanceof ForbiddenException)) return error;
  const body = error.getResponse();
  if (
    typeof body !== 'object' ||
    !(body as { approvable?: boolean }).approvable ||
    (body as { action?: string }).action
  ) {
    return error;
  }
  return new ForbiddenException({ ...body, action });
}
