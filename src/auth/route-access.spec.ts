import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { Reflector } from '@nestjs/core';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { PermissionsGuard, routeAccess } from './guards/permissions.guard';

/**
 * Deny by default: every route of every controller must say who may call it
 * (@RequirePermissions / @RequireAnyPermission / @AnyMember / @Public), and every
 * non-public route must go through PermissionsGuard, which enforces it.
 */

// Routes of controllers owned by other work streams that still lack a declaration.
// PermissionsGuard denies them until they get one; remove entries as they are fixed.
// Routes still waiting for an access declaration (none left)
const PENDING: string[] = [];

type Constructor = abstract new (...args: never[]) => unknown;

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return controllerFiles(path);
    return name.endsWith('.controller.ts') ? [path] : [];
  });
}

function routesOf(controller: Constructor) {
  const routes: { name: string; handler: object }[] = [];
  const seen = new Set<string>();
  for (
    let proto = controller.prototype as object | null;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor' || seen.has(name)) continue;
      seen.add(name);
      const handler = Object.getOwnPropertyDescriptor(proto, name)?.value as
        object | undefined;
      if (
        typeof handler === 'function' &&
        Reflect.getMetadata(METHOD_METADATA, handler) !== undefined
      ) {
        routes.push({ name, handler });
      }
    }
  }
  return routes;
}

describe('route access declarations', () => {
  const reflector = new Reflector();
  const srcDir = join(__dirname, '..');
  type Route = {
    id: string;
    where: string;
    controller: Constructor;
    handler: object;
  };
  let controllers: { controller: Constructor; file: string }[] = [];
  let routes: Route[] = [];

  beforeAll(async () => {
    const modules = await Promise.all(
      controllerFiles(srcDir).map(async (file) => ({
        file,
        exports: (await import(file)) as Record<string, unknown>,
      })),
    );
    controllers = modules.flatMap(({ file, exports }) =>
      Object.values(exports)
        .filter(
          (value): value is Constructor =>
            typeof value === 'function' &&
            Reflect.getMetadata(PATH_METADATA, value) !== undefined,
        )
        .map((controller) => ({ controller, file: relative(srcDir, file) })),
    );
    routes = controllers.flatMap(({ controller, file }) =>
      routesOf(controller).map(({ name, handler }) => {
        const method =
          RequestMethod[
            Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod
          ];
        const base = String(Reflect.getMetadata(PATH_METADATA, controller));
        const path = String(Reflect.getMetadata(PATH_METADATA, handler));
        return {
          id: `${method} /${[base, path].filter((p) => p && p !== '/').join('/')}`,
          where: `${file} ${controller.name}.${name}`,
          controller,
          handler,
        };
      }),
    );
  });

  it('finds the application routes', () => {
    expect(controllers.length).toBeGreaterThan(30);
    expect(routes.length).toBeGreaterThan(150);
  });

  it('every route declares its access (permissions, @AnyMember or @Public)', () => {
    const undeclared = routes
      .filter(
        (r) =>
          routeAccess(reflector, r.handler, r.controller).kind === 'undeclared',
      )
      .map((r) => `${r.id} (${r.where})`);
    expect(
      undeclared.filter((r) => !PENDING.some((p) => r.startsWith(`${p} `))),
    ).toEqual([]);
  });

  it('every non-public route is checked by PermissionsGuard', () => {
    const unguarded = routes
      .filter(
        (r) =>
          routeAccess(reflector, r.handler, r.controller).kind !== 'public',
      )
      .filter((r) => {
        const guards = [
          ...((Reflect.getMetadata(GUARDS_METADATA, r.handler) as
            unknown[] | undefined) ?? []),
          ...((Reflect.getMetadata(GUARDS_METADATA, r.controller) as
            unknown[] | undefined) ?? []),
        ];
        return !guards.includes(PermissionsGuard);
      })
      .map((r) => `${r.id} (${r.where})`);
    expect(unguarded).toEqual([]);
  });

  it('keeps the pending list honest', () => {
    for (const pending of PENDING) {
      const route = routes.find((r) => r.id === pending);
      expect(route).toBeDefined();
      expect(
        routeAccess(reflector, route!.handler, route!.controller).kind,
      ).toBe('undeclared');
    }
  });
});
