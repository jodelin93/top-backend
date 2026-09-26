import { ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { hiddenFieldsFor, redactFields } from './sensitive-fields';
import { SensitiveFieldsInterceptor } from './sensitive-fields.interceptor';
import { SYSTEM_ROLES } from './permissions';

class Variant {
  constructor(
    public sku: string,
    public price: number,
    public cost: number,
  ) {}
}

describe('sensitive fields', () => {
  const cashier = hiddenFieldsFor(SYSTEM_ROLES.cashier.permissions);

  it('hides costs and customer finances from a cashier, nothing from a manager', () => {
    expect([...cashier]).toEqual(
      expect.arrayContaining([
        'cost',
        'unitCost',
        'currentBalance',
        'creditLimit',
      ]),
    );
    expect(hiddenFieldsFor(SYSTEM_ROLES.manager.permissions).size).toBe(0);
  });

  it('shows costs, but not customer finances, to purchasing staff', () => {
    const buyer = hiddenFieldsFor(['purchasing.manage', 'inventory.receive']);
    expect(buyer.has('unitCost')).toBe(false);
    expect(buyer.has('cost')).toBe(false);
    expect(buyer.has('creditLimit')).toBe(true);
  });

  it('removes the fields at any depth without touching the original', () => {
    const variant = new Variant('A-1', 10, 4);
    const product = {
      name: 'Tea',
      variants: [variant],
      stock: [{ quantityOnHand: 3, cost: 4 }],
    };
    const customer = {
      firstName: 'Ann',
      loyaltyPoints: 12,
      currentBalance: 50,
      creditLimit: 100,
    };
    const result = redactFields({ product, customer }, cashier);

    expect(result.product.variants[0]).toEqual({ sku: 'A-1', price: 10 });
    // Keeps its class (so class-transformer's @Exclude still applies)
    expect(result.product.variants[0]).toBeInstanceOf(Variant);
    expect(result.product.stock[0]).toEqual({ quantityOnHand: 3 });
    expect(result.customer).toEqual({ firstName: 'Ann', loyaltyPoints: 12 });
    // Originals unchanged (they may be cached)
    expect(variant.cost).toBe(4);
    expect(customer.creditLimit).toBe(100);
  });

  it('returns untouched values as they are', () => {
    const date = new Date();
    const body = { name: 'x', at: date, list: [1, 2] };
    expect(redactFields(body, cashier)).toBe(body);
  });

  it('handles cycles', () => {
    const a: Record<string, unknown> = { cost: 1 };
    a.self = a;
    const result = redactFields(a, cashier);
    expect(result).not.toHaveProperty('cost');
  });

  it('is applied to responses by the interceptor for the signed-in user', async () => {
    const interceptor = new SensitiveFieldsInterceptor();
    const context = (user: unknown) =>
      ({
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as unknown as ExecutionContext;
    const body = [{ sku: 'A', cost: 2 }];
    await expect(
      lastValueFrom(
        interceptor.intercept(
          context({ permissions: SYSTEM_ROLES.cashier.permissions }),
          { handle: () => of(body) },
        ),
      ),
    ).resolves.toEqual([{ sku: 'A' }]);
    await expect(
      lastValueFrom(
        interceptor.intercept(
          context({ permissions: ['inventory.cost.view'] }),
          { handle: () => of(body) },
        ),
      ),
    ).resolves.toEqual(body);
    // Public routes (no user) are left alone
    await expect(
      lastValueFrom(
        interceptor.intercept(context(undefined), { handle: () => of(body) }),
      ),
    ).resolves.toBe(body);
  });
});
