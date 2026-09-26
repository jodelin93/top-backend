import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateSaleDto, ListSalesQueryDto } from './sales.dto';

const VARIANT = '33333333-3333-4333-8333-333333333333';
const METHOD = '44444444-4444-4444-8444-444444444444';
const REGISTER = '22222222-2222-4222-8222-222222222222';

const errorsOf = (body: Record<string, unknown>) =>
  validateSync(
    plainToInstance(CreateSaleDto, {
      registerId: REGISTER,
      items: [{ variantId: VARIANT, quantity: 1 }],
      payments: [{ paymentMethodId: METHOD, amount: 10 }],
      ...body,
    }),
  );

describe('sale request bounds', () => {
  it('accepts ordinary amounts', () => {
    expect(
      errorsOf({
        items: [{ variantId: VARIANT, quantity: 1, unitPrice: 0.1234 }],
        cartDiscount: { type: 'fixed', value: 1.5 },
      }),
    ).toEqual([]);
  });

  it.each([
    [
      'a huge unit price',
      { items: [{ variantId: VARIANT, quantity: 1, unitPrice: 1e12 }] },
    ],
    ['a huge cart discount', { cartDiscount: { type: 'fixed', value: 1e12 } }],
    [
      'a payment with sub-cent digits',
      { payments: [{ paymentMethodId: METHOD, amount: 10.001 }] },
    ],
    [
      'a huge tendered amount',
      {
        payments: [
          {
            paymentMethodId: METHOD,
            amount: 10,
            currencyCode: 'HTG',
            tenderedAmount: 1e12,
          },
        ],
      },
    ],
  ])('refuses %s', (_case, body) => {
    expect(errorsOf(body)).not.toEqual([]);
  });

  it('limits the search text of the sales list', () => {
    const query = plainToInstance(ListSalesQueryDto, {
      search: 'x'.repeat(101),
    });
    expect(validateSync(query)).toHaveLength(1);
  });
});
