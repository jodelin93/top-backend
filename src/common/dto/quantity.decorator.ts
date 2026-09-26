import { applyDecorators } from '@nestjs/common';
import { IsNumber, Max, Min } from 'class-validator';

/**
 * A stock or sale quantity: a number with at most 4 decimals (numeric(19,4)).
 * Whole units vs decimals (and the unit's precision) depend on the item's unit,
 * so services check that with assertUnitQuantities() once the variants are known.
 *
 * - min: smallest value (default 0.0001, i.e. > 0); pass 0 to allow zero
 * - max: largest value (default 1,000,000,000)
 * - signed: allow negative values down to −max (stock adjustments by delta)
 */
export function IsQuantity(
  options: { min?: number; max?: number; signed?: boolean } = {},
) {
  const max = options.max ?? 1_000_000_000;
  return applyDecorators(
    IsNumber(
      { maxDecimalPlaces: 4, allowNaN: false, allowInfinity: false },
      { message: '$property must be a number with at most 4 decimals' },
    ),
    Min(options.signed ? -max : (options.min ?? 0.0001)),
    Max(max),
  );
}
