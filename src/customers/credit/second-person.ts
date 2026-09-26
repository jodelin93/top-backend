/**
 * Money given to a customer without anything received in the drawer (store
 * credit, stored-value top-ups, non-cash payments that clear account debt)
 * above this amount (store currency) needs a second person: an approval from
 * someone else holding the permission, even when the user holds it too.
 * There is no store setting for it yet.
 */
export const SECOND_PERSON_THRESHOLD = 500;

const cents = (value: number | string) => Math.round(Number(value) * 100);

/** Does this amount need a second person's approval? */
export const needsSecondPerson = (
  amount: number | string,
  threshold = SECOND_PERSON_THRESHOLD,
) => cents(amount) > cents(threshold);
