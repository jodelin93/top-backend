/**
 * Pure helpers for generating the variants of a variable product from
 * attribute values (e.g. Size: S, M × Colour: Red, Blue → 4 variants).
 */
export interface AttributeSelection {
  attributeId: string;
  values: string[];
}

export interface CombinationPart {
  attributeId: string;
  value: string;
}

export const MAX_GENERATED_VARIANTS = 200;

/** Cartesian product, in the order the attributes and values were given */
export function cartesian(
  selections: AttributeSelection[],
): CombinationPart[][] {
  return selections.reduce<CombinationPart[][]>(
    (combos, selection) =>
      combos.flatMap((combo) =>
        selection.values.map((value) => [
          ...combo,
          { attributeId: selection.attributeId, value },
        ]),
      ),
    [[]],
  );
}

/** SKU fragment for a value: "Extra Large" → "EXTRALARGE", "Café" → "CAFE" */
export function skuPart(value: string): string {
  const part = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 20);
  return part || 'X';
}

/** Stable identity of a combination, independent of attribute order */
export function combinationKey(parts: CombinationPart[]): string {
  return [...parts]
    .sort((a, b) => a.attributeId.localeCompare(b.attributeId))
    .map((p) => `${p.attributeId}=${p.value.trim().toLowerCase()}`)
    .join('|');
}

/**
 * First free SKU: base, then base-2, base-3, ... (taken holds existing SKUs, upper-cased)
 */
export function uniqueSku(base: string, taken: Set<string>): string {
  let candidate = base.slice(0, 100);
  for (let n = 2; taken.has(candidate.toUpperCase()); n++) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, 100 - suffix.length)}${suffix}`;
  }
  taken.add(candidate.toUpperCase());
  return candidate;
}

/** Trim, drop empty and duplicate (case-insensitive) values */
export function cleanValues(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}
