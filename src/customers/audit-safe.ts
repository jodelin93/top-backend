/**
 * Audit rows are append-only and can never be erased, so they must not carry
 * personal data (a customer's right to erasure could not be honoured otherwise).
 *
 * - Customer-like records (people): only ids and the NAMES of the fields that
 *   changed are kept, never values.
 * - Everything else keeps its before/after diff (a product's price change stays
 *   readable) with personal fields masked at any depth.
 */

export const REDACTED = '[redacted]';

// Personal fields, masked on every resource
const PII_KEYS = new Set([
  'email',
  'phone',
  'mobile',
  'dateOfBirth',
  'taxNumber',
  'address',
  'addressLine1',
  'addressLine2',
  'line1',
  'line2',
  'postalCode',
  'firstName',
  'lastName',
  'contactPerson',
  'contactName',
  'contactEmail',
  'contactPhone',
]);

// Resources that describe a person (or may): their name and free-form data too
const PERSON_RESOURCES = new Set(['customer', 'supplier']);
const PERSON_KEYS = new Set(['name', 'companyName', 'metadata', 'notes']);

// Resources whose audit rows keep ids and field names only
const IDS_ONLY_RESOURCES = new Set(['customer']);

type AuditOperation = 'created' | 'updated' | 'deleted';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  !(value instanceof Date);

/** A copy of `value` with personal fields masked, at any depth */
export function maskPersonalData(
  value: unknown,
  entityType?: string,
  depth = 0,
): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map((v) => maskPersonalData(v, entityType, depth + 1));
  }
  const person = !!entityType && PERSON_RESOURCES.has(entityType);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      PII_KEYS.has(key) || (person && PERSON_KEYS.has(key))
        ? v === null || v === undefined
          ? v
          : REDACTED
        : maskPersonalData(v, entityType, depth + 1),
    ]),
  );
}

const same = (a: unknown, b: unknown) => {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  if (
    a !== null &&
    b !== null &&
    (typeof a === 'object' || typeof b === 'object')
  ) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  if ((a ?? null) === (b ?? null)) return true;
  // numeric columns come back as strings: '10.0000' vs 10
  const numeric = (v: unknown) =>
    typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');
  return numeric(a) && numeric(b) && Number(a) === Number(b);
};

/** Names of the top-level fields whose value differs between before and after */
export function changedFieldNames(before: unknown, after: unknown): string[] {
  const b = isPlainObject(before) ? before : {};
  const a = isPlainObject(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  return [...keys]
    .filter((key) => key !== 'updatedAt' && key !== 'version')
    .filter((key) => !same(b[key], a[key]))
    .sort();
}

/** Names of the fields that hold a value (for a created record) */
const filledFieldNames = (value: unknown) =>
  isPlainObject(value)
    ? Object.keys(value)
        .filter((key) => value[key] !== null && value[key] !== undefined)
        .sort()
    : [];

const idOf = (value: unknown) =>
  isPlainObject(value) && typeof value.id === 'string' ? value.id : null;

/**
 * The `changes` of a generic CRUD audit row. Customers: ids and field names
 * only; other resources: the diff with personal fields masked.
 */
export function crudAuditChanges(
  entityType: string,
  operation: AuditOperation,
  before?: unknown,
  after?: unknown,
): Record<string, unknown> {
  if (IDS_ONLY_RESOURCES.has(entityType)) {
    const id = idOf(after) ?? idOf(before);
    if (operation === 'created') {
      return { after: { id }, fields: filledFieldNames(after) };
    }
    if (operation === 'updated') {
      return { changedFields: changedFieldNames(before, after) };
    }
    return { before: { id } };
  }
  const changes: Record<string, unknown> = {};
  if (before !== undefined)
    changes.before = maskPersonalData(before, entityType);
  if (after !== undefined) changes.after = maskPersonalData(after, entityType);
  if (operation === 'updated') {
    changes.changedFields = changedFieldNames(before, after);
  }
  return changes;
}
