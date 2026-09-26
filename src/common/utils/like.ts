/**
 * LIKE / ILIKE patterns from user text: % and _ (and the escape character)
 * are matched literally, so a search for "50%" finds "50%" and a string of
 * wildcards can't turn a lookup into an expensive pattern scan.
 */
export const escapeLike = (text: string): string =>
  text.replace(/[%_\\]/g, (c) => `\\${c}`);

/** Pattern matching `text` anywhere */
export const containsPattern = (text: string): string =>
  `%${escapeLike(text.trim())}%`;

/** Pattern matching values that start with `text` */
export const prefixPattern = (text: string): string =>
  `${escapeLike(text.trim())}%`;
