import { CustomerFieldType } from '../database/entities/customer-field-definition.entity';
import { applyCustomFields, FieldDefinitionLike } from './customer-fields';

const field = (
  key: string,
  fieldType: CustomerFieldType,
  extra: Partial<FieldDefinitionLike> = {},
): FieldDefinitionLike => ({
  key,
  label: key,
  fieldType,
  isRequired: false,
  isActive: true,
  options: null,
  ...extra,
});

const definitions = [
  field('card', CustomerFieldType.TEXT, { isRequired: true }),
  field('visits', CustomerFieldType.NUMBER),
  field('since', CustomerFieldType.DATE),
  field('vip', CustomerFieldType.BOOLEAN),
  field('store', CustomerFieldType.SELECT, { options: ['North', 'South'] }),
  field('old', CustomerFieldType.TEXT, { isActive: false, isRequired: true }),
];

describe('applyCustomFields', () => {
  it('accepts and normalises valid values', () => {
    const { values, errors } = applyCustomFields(definitions, {
      card: ' A-1 ',
      visits: '12',
      since: '2024-02-29',
      vip: 'true',
      store: 'North',
    });
    expect(errors).toEqual([]);
    expect(values).toEqual({
      card: 'A-1',
      visits: 12,
      since: '2024-02-29',
      vip: true,
      store: 'North',
    });
  });

  it('reports every invalid value', () => {
    const { errors } = applyCustomFields(definitions, {
      card: 'x',
      visits: 'many',
      since: '2023-02-30',
      vip: 'maybe',
      store: 'East',
      nope: 1,
    });
    expect(errors).toEqual([
      'visits must be a number',
      'since must be a date (YYYY-MM-DD)',
      'vip must be yes or no',
      'store must be one of: North, South',
      'Unknown customer field "nope"',
    ]);
  });

  it('requires required active fields, ignoring inactive ones', () => {
    expect(applyCustomFields(definitions, {}).errors).toEqual([
      'card is required',
    ]);
    expect(applyCustomFields(definitions, { old: 'x' }).errors).toContain(
      'Unknown customer field "old"',
    );
  });

  it('merges onto current values and clears empty ones', () => {
    const { values, errors } = applyCustomFields(
      definitions,
      { visits: '', vip: false },
      { card: 'A-1', visits: 3 },
    );
    expect(errors).toEqual([]);
    expect(values).toEqual({ card: 'A-1', vip: false });
  });
});
