import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { from, Observable, switchMap } from 'rxjs';
import type { Request } from 'express';
import { requestContext } from '../common/context/request-context';
import { isLostDevice } from './devices.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Blocks every request made by a till marked lost (X-Device-Id header, or a
 * body `deviceId` such as an uploaded offline sale): its queued sales and any
 * other sync are refused with DEVICE_LOST. Registered globally by DevicesModule.
 */
@Injectable()
export class LostDeviceInterceptor implements NestInterceptor {
  constructor(private dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const body = req.body as { deviceId?: unknown } | undefined;
    const fromBody =
      typeof body?.deviceId === 'string' && UUID.test(body.deviceId)
        ? body.deviceId
        : undefined;
    const ids = [
      ...new Set(
        [requestContext.get()?.deviceId, fromBody].filter(
          (id): id is string => !!id,
        ),
      ),
    ];
    if (ids.length === 0) return next.handle();
    return from(
      Promise.all(ids.map((id) => isLostDevice(this.dataSource, id))),
    ).pipe(
      switchMap((lost) => {
        if (lost.some(Boolean)) {
          throw new ForbiddenException({
            message:
              'This till was marked lost by an administrator; register a new till',
            error: 'Forbidden',
            code: 'DEVICE_LOST',
          });
        }
        return next.handle();
      }),
    );
  }
}
