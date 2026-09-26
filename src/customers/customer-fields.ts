import { CustomerFieldType } from '../database/entities/customer-field-definition.entity';

/** Minimal shape of a field definition needed for validation */
export interface FieldDefinitionLike {
  key: string;
  label: string;
  fieldType: CustomerFieldType;
  isRequired: boolean;
  isActive: boolean;
  options: string[] | null;
}

export type CustomFieldValue = string | number | boolean;
export type CustomFieldValues = Record<string, CustomFieldValue>;

export const MAX_TEXT_FIELD_LENGTH = 500;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === 'string' && value.trim() === '');

function isValidDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Validate custom field values against the store's field definitions and merge
 * them onto the current values. Empty values (null / '') remove a field.
 * Returns the resulting values and a list of readable errors.
 */
export function applyCustomFields(
  definitions: FieldDefinitionLike[],
  input: Record<string, unknown>,
  current: CustomFieldValues = {},
): { values: CustomFieldValues; errors: string[] } {
  const errors: string[] = [];
  const values: CustomFieldValues = { ...current };
  const active = new Map(
    definitions.filter((d) => d.isActive).map((d) => [d.key, d]),
  );

  for (const [key, raw] of Object.entries(input)) {
    const definition = active.get(key);
    if (!definition) {
      errors.push(`Unknown customer field "${key}"`);
      continue;
    }
    if (isEmpty(raw)) {
      delete values[key];
      continue;
    }
    const { label } = definition;
    switch (definition.fieldType) {
      case CustomerFieldType.TEXT:
        if (typeof raw !== 'string') {
          errors.push(`${label} must be text`);
        } else if (raw.length > MAX_TEXT_FIELD_LENGTH) {
          errors.push(
            `${label} is longer than ${MAX_TEXT_FIELD_LENGTH} characters`,
          );
        } else {
          values[key] = raw.trim();
        }
        break;
      case CustomerFieldType.NUMBER: {
        const number =
          typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())
              ? Number(raw)
              : NaN;
        if (!Number.isFinite(number)) errors.push(`${label} must be a number`);
        else values[key] = number;
        break;
      }
      case CustomerFieldType.DATE:
        if (typeof raw !== 'string' || !isValidDate(raw)) {
          errors.push(`${label} must be a date (YYYY-MM-DD)`);
        } else {
          values[key] = raw;
        }
        break;
      case CustomerFieldType.BOOLEAN:
        if (typeof raw === 'boolean') values[key] = raw;
        else if (raw === 'true' || raw === 'false')
          values[key] = raw === 'true';
        else errors.push(`${label} must be yes or no`);
        break;
      case CustomerFieldType.SELECT:
        if (
          typeof raw !== 'string' ||
          !(definition.options ?? []).includes(raw)
        ) {
          errors.push(
            `${label} must be one of: ${(definition.options ?? []).join(', ')}`,
          );
        } else {
          values[key] = raw;
        }
        break;
    }
  }

  for (const definition of active.values()) {
    if (definition.isRequired && isEmpty(values[definition.key])) {
      errors.push(`${definition.label} is required`);
    }
  }
  return { values, errors };
}
