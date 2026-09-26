import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { requestContext } from '../common/context/request-context';
import {
  accessibleLocationIds,
  assertAllBranches,
  assertBranchAccess,
  assertLocationAccess,
  assertRegisterAccess,
  branchFilterSql,
  branchScope,
  branchWhere,
  canAccessBranch,
  hasAllBranches,
  isBranchSubset,
  locationFilterSql,
  membershipBranchIds,
  registerFilterSql,
  scopedBranchIds,
} from './branch-scope';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const asBranchA = <T>(fn: () => T) =>
  requestContext.run({ userId: 'u', branchIds: [A] }, fn);

describe('branch scope helpers', () => {
  describe('membershipBranchIds', () => {
    it('gives owners and members without a list every branch', () => {
      expect(membershipBranchIds(null)).toBeNull();
      expect(membershipBranchIds({ role: 'owner', branchIds: [A] })).toBeNull();
      expect(
        membershipBranchIds({ role: 'cashier', branchIds: null }),
      ).toBeNull();
    });

    it('keeps the list of a limited member, without duplicates', () => {
      expect(
        membershipBranchIds({ role: 'cashier', branchIds: [A, A, B] }),
      ).toEqual([A, B]);
      expect(membershipBranchIds({ role: 'cashier', branchIds: [] })).toEqual(
        [],
      );
    });
  });

  describe('branchScope', () => {
    it('is unrestricted outside a request (system work)', () => {
      expect(branchScope()).toBeNull();
      expect(hasAllBranches()).toBe(true);
    });

    it("reads the signed-in user's branches from the request context", () => {
      asBranchA(() => {
        expect(branchScope()).toEqual([A]);
        expect(hasAllBranches()).toBe(false);
      });
    });

    it("prefers the user's resolved scope, else falls back to the context", () => {
      asBranchA(() => {
        expect(branchScope({ branchIds: null })).toBeNull();
        expect(branchScope({ branchIds: [B] })).toEqual([B]);
        // A bare User entity (no scope resolved): the request's
        expect(branchScope({})).toEqual([A]);
      });
    });
  });

  describe('access checks', () => {
    it('lets every-branch users see anything, limited users their branches', () => {
      expect(canAccessBranch(B, null)).toBe(true);
      expect(canAccessBranch(A, [A])).toBe(true);
      expect(canAccessBranch(B, [A])).toBe(false);
      // A record without a branch: every-branch users only
      expect(canAccessBranch(null, [A])).toBe(false);
      expect(canAccessBranch(null, null)).toBe(true);
    });

    it('reports another branch as not found (404), never forbidden', () => {
      expect(() =>
        assertBranchAccess({ branchIds: [A] }, B, 'Sale not found'),
      ).toThrow(new NotFoundException('Sale not found'));
      expect(() =>
        assertBranchAccess({ branchIds: [A] }, A, 'Sale not found'),
      ).not.toThrow();
      asBranchA(() => {
        expect(() => assertBranchAccess(null, B)).toThrow(NotFoundException);
      });
    });

    it('refuses store-wide work to branch-limited users', () => {
      expect(() => assertAllBranches({ branchIds: [A] })).toThrow(
        ForbiddenException,
      );
      expect(() => assertAllBranches({ branchIds: null })).not.toThrow();
    });
  });

  describe('SQL fragments', () => {
    it('adds no condition for every-branch users', () => {
      expect(branchFilterSql('sale', 'branchId', null)).toBeNull();
      expect(locationFilterSql('"l"."id"', null)).toBeNull();
      expect(registerFilterSql('"e"."registerId"', null)).toBeNull();
      expect(branchWhere(null)).toEqual({});
      expect(scopedBranchIds(null)).toBeNull();
    });

    it('limits a branch column to the scope', () => {
      expect(branchFilterSql('sale', 'branchId', [A])).toEqual({
        sql: '"sale"."branchId" = ANY(:branchScopeIds)',
        params: { branchScopeIds: [A] },
      });
      // No branch at all: matches nothing
      expect(branchFilterSql('sale', 'branchId', [])?.params).toEqual({
        branchScopeIds: [],
      });
      expect(scopedBranchIds([A])).toEqual([A]);
    });

    it("limits locations to the branches' warehouses and tills' locations", () => {
      const filter = locationFilterSql('"level"."locationId"', [A]);
      expect(filter?.sql).toContain('"level"."locationId" IN');
      expect(filter?.sql).toContain('branch_warehouses');
      expect(filter?.sql).toContain('"defaultLocationId"');
      expect(filter?.params).toEqual({ branchScopeIds: [A] });
    });
  });

  describe('isBranchSubset (no escalation)', () => {
    it('only every-branch users can give every branch', () => {
      expect(isBranchSubset(null, null)).toBe(true);
      expect(isBranchSubset(null, [A])).toBe(false);
    });

    it('limited users only give branches they have', () => {
      expect(isBranchSubset([A], [A, B])).toBe(true);
      expect(isBranchSubset([A, B], [A])).toBe(false);
      expect(isBranchSubset([], [A])).toBe(true);
      expect(isBranchSubset([B], null)).toBe(true);
    });
  });

  describe('locations and registers', () => {
    const managerWith = (rows: unknown[]) => {
      const query = jest.fn().mockResolvedValue(rows);
      return { manager: { query } as unknown as EntityManager, query };
    };

    it('lists the locations of the scope (null = all, no query)', async () => {
      const { manager, query } = managerWith([{ id: 'loc-a' }]);
      await expect(accessibleLocationIds(manager, 't', null)).resolves.toBe(
        null,
      );
      expect(query).not.toHaveBeenCalled();
      await expect(accessibleLocationIds(manager, 't', [A])).resolves.toEqual([
        'loc-a',
      ]);
      expect(query).toHaveBeenCalledWith(expect.any(String), ['t', [A]]);
      await expect(accessibleLocationIds(manager, 't', [])).resolves.toEqual(
        [],
      );
    });

    it("404s a location outside the user's branches", async () => {
      const outside = managerWith([]);
      await expect(
        assertLocationAccess(outside.manager, 't', 'loc-b', 'Not here', [A]),
      ).rejects.toThrow(new NotFoundException('Not here'));
      const inside = managerWith([{ '?column?': 1 }]);
      await expect(
        assertLocationAccess(inside.manager, 't', 'loc-a', 'Not here', [A]),
      ).resolves.toBeUndefined();
    });

    it('404s a register of another branch', async () => {
      const { manager } = managerWith([{ branchId: B }]);
      await expect(
        assertRegisterAccess(manager, 't', 'reg-b', 'Register not found', [A]),
      ).rejects.toThrow(NotFoundException);
      const own = managerWith([{ branchId: A }]);
      await expect(
        assertRegisterAccess(own.manager, 't', 'reg-a', undefined, [A]),
      ).resolves.toBeUndefined();
    });
  });
});
