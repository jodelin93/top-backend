import { ForbiddenException } from '@nestjs/common';
import { requestContext } from '../common/context/request-context';
import { assertCanSetCreditLimit } from './customers.service';

describe('setting a customer credit limit', () => {
  const as = (permissions: string[], fn: () => void) =>
    requestContext.run({ permissions }, fn);

  it('is refused without customers.finance.view', () => {
    as(['customers.manage'], () => {
      expect(() => assertCanSetCreditLimit({ creditLimit: 500 })).toThrow(
        ForbiddenException,
      );
    });
  });

  it('is allowed with customers.finance.view', () => {
    as(['customers.manage', 'customers.finance.view'], () => {
      expect(() => assertCanSetCreditLimit({ creditLimit: 500 })).not.toThrow();
    });
  });

  it('does not restrict updates that leave the limit alone, or internal calls', () => {
    as(['customers.manage'], () => {
      expect(() => assertCanSetCreditLimit({})).not.toThrow();
    });
    expect(() => assertCanSetCreditLimit({ creditLimit: 500 })).not.toThrow();
  });

  it('needs customers.credit.manage to set a credit hold or payment terms', () => {
    as(['customers.manage', 'customers.finance.view'], () => {
      expect(() => assertCanSetCreditLimit({ creditHold: true })).toThrow(
        ForbiddenException,
      );
      expect(() => assertCanSetCreditLimit({ paymentTermDays: 15 })).toThrow(
        ForbiddenException,
      );
    });
    as(['customers.manage', 'customers.credit.manage'], () => {
      expect(() =>
        assertCanSetCreditLimit({ creditHold: true, paymentTermDays: 15 }),
      ).not.toThrow();
    });
  });
});
