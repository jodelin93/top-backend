import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import {
  AllowApproval,
  AnyMember,
  RequireAnyPermission,
  RequirePermissions,
} from '../decorators/permissions.decorator';
import { Public } from '../decorators/public.decorator';
import type { Permission } from '../permissions';
import { ApprovalsService } from '../../approvals/approvals.service';

type Decorator = MethodDecorator & ClassDecorator;

/** A controller class and handler carrying the given decorators */
function route(
  handlerDecorators: Decorator[] = [],
  classDecorators: Decorator[] = [],
) {
  class Controller {
    handle() {
      return undefined;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    Controller.prototype,
    'handle',
  )!;
  for (const decorate of handlerDecorators) {
    decorate(Controller.prototype, 'handle', descriptor);
  }
  for (const decorate of classDecorators) decorate(Controller);
  return { handler: descriptor.value as () => unknown, controller: Controller };
}

function contextFor(
  target: ReturnType<typeof route>,
  user: unknown,
  headers: Record<string, string> = {},
  request: { method?: string; originalUrl?: string } = {},
): ExecutionContext {
  return {
    getHandler: () => target.handler,
    getClass: () => target.controller,
    switchToHttp: () => ({
      getRequest: () => ({
        user,
        headers,
        method: 'POST',
        originalUrl: '/api/v1/sales/s1/void',
        ...request,
      }),
    }),
  } as unknown as ExecutionContext;
}

const member = (permissions: Permission[] = []) => ({
  id: 'u1',
  tenantId: 't1',
  permissions,
});

describe('PermissionsGuard', () => {
  const approvals = { verify: jest.fn() };
  const guard = new PermissionsGuard(
    new Reflector(),
    approvals as unknown as ApprovalsService,
  );
  const run = (ctx: ExecutionContext) =>
    guard.canActivate(ctx).catch((e: unknown) => e);

  beforeEach(() => approvals.verify.mockReset());

  it('denies a route that declares no access rule', async () => {
    const error = await run(contextFor(route(), member(['users.manage'])));
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).message).toMatch(
      /does not declare who may use it/,
    );
  });

  it('allows @Public routes without a user', async () => {
    await expect(
      guard.canActivate(contextFor(route([Public()]), undefined)),
    ).resolves.toBe(true);
  });

  it('allows @AnyMember routes for any signed-in user, not anonymous', async () => {
    await expect(
      guard.canActivate(contextFor(route([AnyMember()]), member())),
    ).resolves.toBe(true);
    expect(
      await run(contextFor(route([AnyMember()]), undefined)),
    ).toBeInstanceOf(ForbiddenException);
  });

  it('allows a user holding every required permission', async () => {
    await expect(
      guard.canActivate(
        contextFor(
          route([RequirePermissions('sales.void')]),
          member(['sales.void']),
        ),
      ),
    ).resolves.toBe(true);
  });

  it('uses the controller rule when the handler has none', async () => {
    const target = route([], [RequirePermissions('users.manage')]);
    expect(await run(contextFor(target, member()))).toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      guard.canActivate(contextFor(target, member(['users.manage']))),
    ).resolves.toBe(true);
  });

  it('lets a handler rule override the controller rule', async () => {
    const target = route([AnyMember()], [RequirePermissions('users.manage')]);
    await expect(guard.canActivate(contextFor(target, member()))).resolves.toBe(
      true,
    );
  });

  it('accepts any one of @RequireAnyPermission', async () => {
    const target = route([
      RequireAnyPermission('pos.sell', 'discounts.manage'),
    ]);
    await expect(
      guard.canActivate(contextFor(target, member(['discounts.manage']))),
    ).resolves.toBe(true);
    const error = (await run(
      contextFor(target, member(['sales.view'])),
    )) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({
      missingPermissions: ['pos.sell', 'discounts.manage'],
      approvable: false,
    });
  });

  it('rejects a user missing a permission, listing it', async () => {
    const error = (await run(
      contextFor(route([RequirePermissions('sales.void')]), member()),
    )) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({
      missingPermissions: ['sales.void'],
      approvable: false,
    });
  });

  it('tells the client which action an approval is for', async () => {
    const error = (await run(
      contextFor(
        route([RequirePermissions('sales.void'), AllowApproval()]),
        member(),
      ),
    )) as ForbiddenException;
    expect(error.getResponse()).toMatchObject({
      approvable: true,
      action: 'POST /sales/s1/void',
    });
  });

  it('accepts a valid approval token on approvable routes', async () => {
    approvals.verify.mockResolvedValue('manager-1');
    const user = member();
    await expect(
      guard.canActivate(
        contextFor(
          route([RequirePermissions('sales.void'), AllowApproval()]),
          user,
          { 'x-approval-token': 'tok' },
        ),
      ),
    ).resolves.toBe(true);
    expect(approvals.verify).toHaveBeenCalledWith('tok', 'sales.void', user);
  });

  it('ignores approval tokens on routes that do not allow approval', async () => {
    approvals.verify.mockResolvedValue('manager-1');
    expect(
      await run(
        contextFor(route([RequirePermissions('users.manage')]), member(), {
          'x-approval-token': 'tok',
        }),
      ),
    ).toBeInstanceOf(ForbiddenException);
    expect(approvals.verify).not.toHaveBeenCalled();
  });

  it('rejects an invalid approval token', async () => {
    approvals.verify.mockResolvedValue(null);
    expect(
      await run(
        contextFor(
          route([RequirePermissions('sales.void'), AllowApproval()]),
          member(),
          { 'x-approval-token': 'bad' },
        ),
      ),
    ).toBeInstanceOf(ForbiddenException);
  });
});
