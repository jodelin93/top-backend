/**
 * Loyalty rules, from the store settings:
 * - earnPercent: customers earn points worth this % of what they pay (e.g. 5 → 5%)
 * - pointValue: what one point is worth when spent (e.g. 0.01 → 100 points = 1.00)
 */
export interface LoyaltyRules {
  enabled: boolean;
  earnPercent: number;
  pointValue: number;
  minRedeemPoints: number;
  // Largest share of a sale that can be paid with points
  maxRedeemPercent: number;
}

/** Points earned on an amount paid (rounded down: no fractional points) */
export function pointsEarned(rules: LoyaltyRules, amount: number): number {
  if (!rules.enabled || amount <= 0 || rules.pointValue <= 0) return 0;
  return Math.floor(
    (amount * rules.earnPercent) / 100 / rules.pointValue + 1e-9,
  );
}

/** Points needed to pay an amount (rounded up: the store never gives value away) */
export function pointsForAmount(rules: LoyaltyRules, amount: number): number {
  if (rules.pointValue <= 0) return Infinity;
  return Math.ceil(amount / rules.pointValue - 1e-9);
}

/** Money value of a number of points */
export function valueOfPoints(rules: LoyaltyRules, points: number): number {
  return Math.floor(points * rules.pointValue * 100 + 1e-9) / 100;
}

/**
 * A change to a points balance that can never go below zero. When a reversal
 * would take more than the customer has left (points already spent), only what
 * is there is removed: `applied` is what the ledger records, so the balance
 * always equals the sum of the ledger, and `shortfall` is what could not be taken.
 */
export function applyPointChange(
  balance: number,
  points: number,
): { applied: number; balanceAfter: number; shortfall: number } {
  // `|| 0` turns -0 (nothing left to take) into a plain 0
  const applied = Math.max(points, -Math.max(balance, 0)) || 0;
  return {
    applied,
    balanceAfter: balance + applied,
    shortfall: applied - points,
  };
}
