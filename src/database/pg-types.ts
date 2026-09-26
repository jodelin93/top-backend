import { types } from 'pg';

// Return NUMERIC columns (prices, amounts) as JS numbers instead of strings.
// Values are money with at most 4 decimals, well within double precision.
types.setTypeParser(types.builtins.NUMERIC, (value) => parseFloat(value));
