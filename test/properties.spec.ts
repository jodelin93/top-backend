import fc from 'fast-check';
import {
  calculateSale,
  CalcLineInput,
  CalcOptions,
  round2,
} from '../src/sales/sale-calculator';
import {
  allocateToOriginalTenders,
  lineRefund,
  onAccountShare,
} from '../src/returns/return-math';
import {
  amountDueIn,
  changeIn,
  toSaleCurrency,
} from '../src/currency/currency-math';
// The POS keeps its own copy of the calculator for offline totals: it must agree
import { calculateSale as calculateSaleFrontend } from '../../top-frontend/src/lib/pos/sale-calculator';

/**
 * Property-based tests (fast-check) for the money invariants of spec §23:
 * allocation conservation, repeated partial returns, currency conversion,
 * rounding, and calculator totals. Run with `npm run test:properties`.
 *
 * Money is compared in integer cents so a failure shows the exact cent.
 */

const RUNS = Number(process.env.FC_RUNS) || 500;
const cents = (v: number) => Math.round(v * 100);

// ---- Generators ----
// A price with at most 2 decimals, 0.01 – 999.99
const price = fc.integer({ min: 1, max: 99_999 }).map((c) => c / 100);
// Whole units (measured quantities are covered by the calculator's own unit tests)
const quantity = fc.integer({ min: 1, max: 25 });
const taxRate = fc.constantFrom(0, 5, 8.25, 10, 10.5, 15, 20);

const lineArb = fc.record({
  unitPrice: price,
  quantity,
  discountPercent: fc.option(fc.integer({ min: 0, max: 100 }), {
    nil: undefined,
  }),
  taxRate: fc.option(taxRate, { nil: undefined }),
});

const linesArb = fc
  .array(lineArb, { minLength: 1, maxLength: 8 })
  .map((lines) =>
    lines.map((l, i): CalcLineInput => ({
      key: `l${i}`,
      productId: `p${i}`,
      categoryId: i % 2 ? 'c1' : null,
      ...l,
    })),
  );

const cartDiscountArb = fc.oneof(
  fc.record({
    type: fc.constant('percentage' as const),
    value: fc.integer({ min: 1, max: 100 }),
  }),
  fc.record({
    type: fc.constant('fixed' as const),
    value: fc.integer({ min: 1, max: 500_000 }).map((c) => c / 100),
  }),
);

const optionsArb = fc.record({
  taxRate,
  pricesIncludeTax: fc.boolean(),
  cartDiscount: fc.option(cartDiscountArb, { nil: null }),
  discount: fc.option(
    fc.oneof(
      fc.record({
        code: fc.constant('PCT'),
        discountType: fc.constant('percentage' as const),
        scope: fc.constant('cart' as const),
        percentage: fc.integer({ min: 1, max: 100 }),
      }),
      fc.record({
        code: fc.constant('FIX'),
        discountType: fc.constant('fixed_amount' as const),
        scope: fc.constant('cart' as const),
        value: fc.integer({ min: 1, max: 100_000 }).map((c) => c / 100),
      }),
      fc.record({
        code: fc.constant('B2G1'),
        discountType: fc.constant('buy_x_get_y' as const),
        scope: fc.constant('product' as const),
        buyQuantity: fc.constant(2),
        getQuantity: fc.constant(1),
        applicableProductIds: fc.constant(['p0', 'p2']),
      }),
    ),
    { nil: null },
  ),
}) as fc.Arbitrary<CalcOptions>;

/** Split n into k ≥ 1 positive parts (random partial returns of a line) */
const partitionArb = (n: number) =>
  fc
    .array(fc.integer({ min: 1, max: n }), { minLength: 0, maxLength: n - 1 })
    .map((cuts) => {
      const points = [...new Set(cuts.filter((c) => c < n))].sort(
        (a, b) => a - b,
      );
      const parts: number[] = [];
      let prev = 0;
      for (const p of [...points, n]) {
        parts.push(p - prev);
        prev = p;
      }
      return parts;
    });

describe('money properties (fast-check)', () => {
  describe('round2', () => {
    it('is idempotent', () => {
      fc.assert(
        fc.property(
          fc.double({
            min: -1e9,
            max: 1e9,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          (x) => round2(round2(x)) === round2(x),
        ),
        { numRuns: RUNS },
      );
    });

    it('is symmetric around zero (half away from zero)', () => {
      fc.assert(
        fc.property(
          fc.double({
            min: -1e9,
            max: 1e9,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          (x) =>
            round2(-x) === -round2(x) || (round2(x) === 0 && round2(-x) === 0),
        ),
        { numRuns: RUNS },
      );
    });

    it('rounds an exact half cent away from zero', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 10_000_000 }), (k) => {
          // k.005 written as a decimal, e.g. 1.005, 2.675, 1234.565
          const x = Number(
            `${Math.floor(k / 100)}.${String(k % 100).padStart(2, '0')}5`,
          );
          return cents(round2(x)) === k + 1 && cents(round2(-x)) === -(k + 1);
        }),
        { numRuns: RUNS },
      );
    });

    it('never moves a value by more than half a cent', () => {
      fc.assert(
        fc.property(
          fc.double({
            min: -1e7,
            max: 1e7,
            noNaN: true,
            noDefaultInfinity: true,
          }),
          (x) =>
            Math.abs(round2(x) - x) <= 0.005 + 1e-9 * Math.max(1, Math.abs(x)),
        ),
        { numRuns: RUNS },
      );
    });
  });

  describe('calculator', () => {
    it('cart totals equal the sum of the lines, and each line adds up', () => {
      fc.assert(
        fc.property(linesArb, optionsArb, (lines, options) => {
          const r = calculateSale(lines, options);
          const sum = (
            k: 'subtotal' | 'discountAmount' | 'taxAmount' | 'total',
          ) => r.lines.reduce((s, l) => s + cents(l[k]), 0);
          expect(cents(r.subtotal)).toBe(sum('subtotal'));
          expect(cents(r.discountAmount)).toBe(sum('discountAmount'));
          expect(cents(r.taxAmount)).toBe(sum('taxAmount'));
          expect(cents(r.total)).toBe(sum('total'));
          for (const l of r.lines) {
            const net = cents(l.subtotal) - cents(l.discountAmount);
            expect(cents(l.total)).toBe(
              options.pricesIncludeTax ? net : net + cents(l.taxAmount),
            );
            // Every result has at most 2 decimals
            for (const v of [
              l.subtotal,
              l.discountAmount,
              l.taxAmount,
              l.total,
            ]) {
              expect(Math.abs(v * 100 - cents(v))).toBeLessThan(1e-6);
            }
          }
        }),
        { numRuns: RUNS },
      );
    });

    it('allocation conserves the cart discount and never goes negative', () => {
      fc.assert(
        fc.property(
          linesArb,
          taxRate,
          fc.boolean(),
          cartDiscountArb,
          (lines, rate, incl, cart) => {
            // Only the manual cart discount, so its full amount is what gets split
            const plain = calculateSale(lines, {
              taxRate: rate,
              pricesIncludeTax: incl,
            });
            const r = calculateSale(lines, {
              taxRate: rate,
              pricesIncludeTax: incl,
              cartDiscount: cart,
            });
            const base = plain.lines.reduce(
              (s, l) => s + cents(l.subtotal) - cents(l.discountAmount),
              0,
            );
            const requested =
              cart.type === 'percentage'
                ? null // checked through the bounds below
                : cents(cart.value);
            const allocated = r.lines.reduce(
              (s, l, i) =>
                s +
                cents(l.discountAmount) -
                cents(plain.lines[i].discountAmount),
              0,
            );
            if (requested !== null) {
              expect(allocated).toBe(Math.min(requested, base));
            } else {
              const exact = (base * cart.value) / 100;
              expect(Math.abs(allocated - exact)).toBeLessThanOrEqual(
                0.5 + 1e-9,
              );
            }
            for (const l of r.lines) {
              expect(cents(l.discountAmount)).toBeGreaterThanOrEqual(0);
              expect(cents(l.discountAmount)).toBeLessThanOrEqual(
                cents(l.subtotal),
              );
              expect(cents(l.taxAmount)).toBeGreaterThanOrEqual(0);
              expect(cents(l.total)).toBeGreaterThanOrEqual(0);
            }
          },
        ),
        { numRuns: RUNS },
      );
    });

    it('the POS (offline) calculator gives exactly the server result', () => {
      fc.assert(
        fc.property(linesArb, optionsArb, (lines, options) => {
          const server = calculateSale(lines, options);
          const pos = calculateSaleFrontend(lines, options);
          expect({
            subtotal: pos.subtotal,
            discountAmount: pos.discountAmount,
            taxAmount: pos.taxAmount,
            total: pos.total,
            lines: pos.lines.map((l) => [
              l.subtotal,
              l.discountAmount,
              l.taxAmount,
              l.total,
            ]),
          }).toEqual({
            subtotal: server.subtotal,
            discountAmount: server.discountAmount,
            taxAmount: server.taxAmount,
            total: server.total,
            lines: server.lines.map((l) => [
              l.subtotal,
              l.discountAmount,
              l.taxAmount,
              l.total,
            ]),
          });
        }),
        { numRuns: RUNS },
      );
    });
  });

  describe('returns', () => {
    const lineWithParts = linesArb.chain((lines) =>
      optionsArb.chain((options) => {
        const line = calculateSale(lines, options).lines[0];
        return partitionArb(line.quantity).map((parts) => ({ line, parts }));
      }),
    );

    it('repeated partial returns add up exactly to the original line', () => {
      fc.assert(
        fc.property(lineWithParts, ({ line, parts }) => {
          let returned = 0;
          const total = {
            subtotal: 0,
            discountAmount: 0,
            taxAmount: 0,
            total: 0,
          };
          for (const qty of parts) {
            const r = lineRefund(line, returned, qty);
            for (const k of Object.keys(total) as (keyof typeof total)[]) {
              expect(cents(r[k])).toBeGreaterThanOrEqual(0);
              total[k] += cents(r[k]);
            }
            // Each refund is itself consistent
            expect(cents(r.total)).toBeLessThanOrEqual(cents(line.total));
            returned += qty;
          }
          expect(total).toEqual({
            subtotal: cents(line.subtotal),
            discountAmount: cents(line.discountAmount),
            taxAmount: cents(line.taxAmount),
            total: cents(line.total),
          });
        }),
        { numRuns: RUNS },
      );
    });

    it('refuses to return more than was sold', () => {
      fc.assert(
        fc.property(
          lineWithParts,
          fc.integer({ min: 1, max: 5 }),
          ({ line }, extra) => {
            expect(() => lineRefund(line, 0, line.quantity + extra)).toThrow(
              RangeError,
            );
            expect(() => lineRefund(line, line.quantity, extra)).toThrow(
              RangeError,
            );
          },
        ),
        { numRuns: 100 },
      );
    });

    it('refund allocation never exceeds what each tender has left and covers the refund', () => {
      const paymentsArb = fc.array(
        fc.record({
          isCash: fc.boolean(),
          amount: fc.integer({ min: 1, max: 100_000 }),
          refundedShare: fc.integer({ min: 0, max: 100 }),
        }),
        { minLength: 1, maxLength: 5 },
      );
      fc.assert(
        fc.property(
          paymentsArb,
          fc.integer({ min: 0, max: 100 }),
          (ps, pct) => {
            const payments = ps.map((p, i) => ({
              paymentId: `pay${i}`,
              paymentMethodId: p.isCash ? 'cash' : `card${i}`,
              isCash: p.isCash,
              amount: p.amount / 100,
              refunded: Math.floor((p.amount * p.refundedShare) / 100) / 100,
            }));
            const available = payments.reduce(
              (s, p) => s + cents(p.amount) - cents(p.refunded),
              0,
            );
            const refund = Math.floor((available * pct) / 100) / 100;
            const allocations = allocateToOriginalTenders(refund, payments);
            const sum = allocations.reduce((s, a) => s + cents(a.amount), 0);
            expect(sum).toBe(cents(refund));
            for (const a of allocations) {
              const p = payments.find((x) => x.paymentId === a.paymentId)!;
              expect(cents(a.amount)).toBeGreaterThan(0);
              expect(cents(a.amount)).toBeLessThanOrEqual(
                cents(p.amount) - cents(p.refunded),
              );
            }
            // More than is left is refused
            expect(() =>
              allocateToOriginalTenders((available + 1) / 100, payments),
            ).toThrow(RangeError);
          },
        ),
        { numRuns: RUNS },
      );
    });

    it('on-account shares of a fully refunded sale add up to what went on account', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.integer({ min: 0, max: 100 }),
          fc.array(fc.integer({ min: 1, max: 100 }), {
            minLength: 1,
            maxLength: 6,
          }),
          (totalCents, onAccountPct, weights) => {
            const saleTotal = totalCents / 100;
            const paidOnAccount =
              Math.floor((totalCents * onAccountPct) / 100) / 100;
            // Split the sale total into refunds proportional to the weights
            const w = weights.reduce((a, b) => a + b, 0);
            const refundCents = weights.map((x) =>
              Math.floor((totalCents * x) / w),
            );
            refundCents[refundCents.length - 1] +=
              totalCents - refundCents.reduce((a, b) => a + b, 0);
            let credited = 0;
            let refunded = 0;
            for (const rc of refundCents) {
              const share = onAccountShare({
                saleTotal,
                paidOnAccount,
                creditedSoFar: credited / 100,
                refundedSoFar: refunded / 100,
                refund: rc / 100,
              });
              expect(cents(share)).toBeGreaterThanOrEqual(0);
              expect(cents(share)).toBeLessThanOrEqual(rc);
              credited += cents(share);
              refunded += rc;
            }
            expect(credited).toBe(cents(paidOnAccount));
          },
        ),
        { numRuns: RUNS },
      );
    });
  });

  describe('currency conversion', () => {
    // Rates like 132.5 HTG per USD, 0.92 EUR per USD, up to 4 decimals
    const rateArb = fc
      .integer({ min: 1_000, max: 2_000_000 })
      .map((r) => r / 10_000);
    const dueArb = fc.integer({ min: 1, max: 1_000_000 }).map((c) => c / 100);

    it('the amount asked in another currency always covers the sale, by less than a cent', () => {
      fc.assert(
        fc.property(dueArb, rateArb, (due, rate) => {
          const asked = amountDueIn(due, rate);
          // At most 2 decimals
          expect(Math.abs(asked * 100 - Math.round(asked * 100))).toBeLessThan(
            1e-6,
          );
          // Paying what was asked covers the sale once converted back (to the cent)
          expect(round2(toSaleCurrency(asked, rate))).toBeGreaterThanOrEqual(
            due,
          );
          expect(toSaleCurrency(asked, rate)).toBeGreaterThanOrEqual(
            due - 1e-9,
          );
          // …and asks at most one cent (of that currency) more than the exact amount
          expect(asked - due * rate).toBeLessThan(0.01 + 1e-9);
        }),
        { numRuns: RUNS },
      );
    });

    it('change handed back in another currency is never more than owed', () => {
      fc.assert(
        fc.property(dueArb, rateArb, (owed, rate) => {
          const change = changeIn(owed, rate);
          expect(toSaleCurrency(change, rate)).toBeLessThanOrEqual(owed + 1e-9);
          expect(owed * rate - change).toBeLessThan(0.01 + 1e-9);
          expect(change).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: RUNS },
      );
    });
  });
});
