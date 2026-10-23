import { NotFoundException } from '@nestjs/common';
import { requestContext } from '../common/context/request-context';
import {
  assertSaleAccess,
  ownSalesFilterSql,
  ownSalesOnly,
} from './sales-scope';

const as = <T>(ctx: Parameters<typeof requestContext.run>[0], fn: () => T) =>
  requestContext.run(ctx, fn);

describe('sales scope (sales.view.all)', () => {
  it('a user without sales.view.all sees only the sales they rang up', () => {
    as({ userId: 'cashier', permissions: ['sales.view'] }, () => {
      expect(ownSalesOnly()).toBe('cashier');
      expect(ownSalesFilterSql('sale')).toEqual({
        sql: '"sale"."userId" = :ownSalesUserId',
        params: { ownSalesUserId: 'cashier' },
      });
      expect(() => assertSaleAccess({ userId: 'cashier' })).not.toThrow();
      expect(() => assertSaleAccess({ userId: 'other' })).toThrow(
        NotFoundException,
      );
    });
  });

  it('with sales.view.all: every sale', () => {
    as(
      { userId: 'manager', permissions: ['sales.view', 'sales.view.all'] },
      () => {
        expect(ownSalesOnly()).toBeNull();
        expect(ownSalesFilterSql('sale')).toBeNull();
        expect(() => assertSaleAccess({ userId: 'other' })).not.toThrow();
      },
    );
  });

  it('work outside a request (jobs) is not restricted', () => {
    expect(ownSalesOnly()).toBeNull();
    as({}, () => expect(ownSalesOnly()).toBeNull());
  });
});
