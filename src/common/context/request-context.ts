import { AsyncLocalStorage } from 'async_hooks';
import { NextFunction, Request, Response } from 'express';

/**
 * Per-request context available anywhere in the call chain (e.g. to the audit log)
 * without passing it through every service method.
 * Filled by requestContextMiddleware, then by JwtStrategy / PermissionsGuard.
 */
export interface RequestContext {
  requestId?: string;
  ip?: string;
  userAgent?: string;
  // POS device id sent by the till (X-Device-Id header), when it is a UUID
  deviceId?: string;
  userId?: string;
  // Session (JWT sid claim) of the signed-in user
  sessionId?: string;
  tenantId?: string | null;
  // User who approved an action the requester lacked permission for
  approverId?: string;
  // Permissions of the signed-in user (for field-level checks deep in services)
  permissions?: readonly string[];
  // Branches the signed-in user may work in: null = every branch (see auth/branch-scope)
  branchIds?: readonly string[] | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  get: (): RequestContext | undefined => storage.getStore(),
  set: (values: Partial<RequestContext>) => {
    const store = storage.getStore();
    if (store) Object.assign(store, values);
  },
  run: <T>(context: RequestContext, fn: () => T): T => storage.run(context, fn),
};

export const DEVICE_ID_HEADER = 'x-device-id';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const deviceId = req.header(DEVICE_ID_HEADER);
  storage.run(
    {
      requestId: (req as Request & { requestId?: string }).requestId,
      ip: req.ip,
      userAgent: req.header('user-agent')?.slice(0, 500),
      deviceId: deviceId && UUID_PATTERN.test(deviceId) ? deviceId : undefined,
    },
    next,
  );
}
