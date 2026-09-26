import { ForbiddenException } from '@nestjs/common';
import type { Permission } from '../auth/permissions';
import { calculateSale, CalcLineInput, CalcOptions } from './sale-calculator';

/**
 * Till authorisations (R044): which permissions a cart needs.
 *
 * - Any manual discount (line % or cart discount) needs `pos.discount`.
 * - A line discount above the store's `maxDiscountPercent`, or a cart discount whose
 *   percentage (or, for a fixed amount, its equivalent percentage of the amount it is
 *   taken off) is above it, needs `pos.discount.override`.
 * - Selling a line at a price other than the catalog price needs `pos.price.override`.
 *
 * Each can be granted by a manager approval (X-Approval-Token), checked by the service.
 */
export interface OverrideLine {
  // Catalog price and the price the cart asks for
  catalogPrice: number;
  unitPrice: number;
  discountPercent?: number;
}

export interface OverrideCheck {
  permissions: Permission[];
  // Human-readable reasons (for the audit trail)
  reasons: string[];
  // Largest manual discount in the cart, as a percentage
  maxPercent: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Percentage a manual cart discount represents of the amount it applies to
 * (the cart after line discounts and the discount code)
 */
export function cartDiscountPercent(
  inputs: CalcLineInput[],
  options: CalcOptions,
): number {
  const cart = options.cartDiscount;
  if (!cart || cart.value <= 0) return 0;
  if (cart.type === 'percentage') return cart.value;
  const before = calculateSale(inputs, { ...options, cartDiscount: null });
  const base = before.subtotal - before.discountAmount;
  if (base <= 0) return 0;
  return round((Math.min(cart.value, base) / base) * 100);
}

export function requiredOverrides(
  lines: OverrideLine[],
  cartPercent: number,
  maxDiscountPercent: number,
): OverrideCheck {
  const permissions = new Set<Permission>();
  const reasons: string[] = [];
  let maxPercent = cartPercent;

  lines.forEach((line, index) => {
    const pct = line.discountPercent ?? 0;
    if (pct > 0) {
      permissions.add('pos.discount');
      maxPercent = Math.max(maxPercent, pct);
      if (pct > maxDiscountPercent) {
        permissions.add('pos.discount.override');
        reasons.push(
          `Line ${index + 1}: ${pct}% discount (limit ${maxDiscountPercent}%)`,
        );
      }
    }
    if (round(line.unitPrice) !== round(line.catalogPrice)) {
      permissions.add('pos.price.override');
      reasons.push(
        `Line ${index + 1}: price ${line.catalogPrice.toFixed(2)} → ${line.unitPrice.toFixed(2)}`,
      );
    }
  });

  if (cartPercent > 0) {
    permissions.add('pos.discount');
    if (cartPercent > maxDiscountPercent) {
      permissions.add('pos.discount.override');
      reasons.push(
        `Cart discount of ${cartPercent}% (limit ${maxDiscountPercent}%)`,
      );
    }
  }

  // Being allowed above the limit includes being allowed below it
  if (permissions.has('pos.discount.override')) {
    permissions.delete('pos.discount');
  }
  return { permissions: [...permissions], reasons, maxPercent };
}

/**
 * The same 403 shape PermissionsGuard sends, so the POS's useApproval() can ask
 * a manager and retry with an approval token
 */
export function approvalRequired(permission: Permission, message: string) {
  return new ForbiddenException({
    message,
    error: 'Forbidden',
    missingPermissions: [permission],
    approvable: true,
  });
}
