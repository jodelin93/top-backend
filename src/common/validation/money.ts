/**
 * Upper bound for money amounts accepted from clients (prices, costs,
 * settlement amounts). Far above any real POS amount, well inside
 * numeric(19,4) and exact double precision.
 */
export const MAX_MONEY = 999_999_999;
