import { registerDecorator, ValidationOptions } from 'class-validator';

/** Languages the app is translated into (store settings, labels, frontend i18n). */
export const SUPPORTED_LOCALES = ['en', 'fr', 'ht', 'es'] as const;

/** Product / category / variant names. */
export const MAX_NAME_LENGTH = 255;
/** Product / category descriptions. */
export const MAX_DESCRIPTION_LENGTH = 5000;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * A translated text: { en?: string, fr?: string, ht?: string, es?: string }.
 * Only supported locale keys, string values of at most `maxLength` characters.
 * With `requireOne`, at least one non-blank translation is needed (names).
 */
export function isLocalizedText(
  value: unknown,
  maxLength: number,
  requireOne = false,
): boolean {
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  const locales: readonly string[] = SUPPORTED_LOCALES;
  for (const [key, text] of entries) {
    if (!locales.includes(key)) return false;
    if (typeof text !== 'string' || text.length > maxLength) return false;
  }
  return (
    !requireOne || entries.some(([, text]) => (text as string).trim() !== '')
  );
}

export function IsLocalizedText(
  options: { maxLength: number; requireOne?: boolean },
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isLocalizedText',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `$property must be an object with ${SUPPORTED_LOCALES.join(
          ', ',
        )} keys and text values of at most ${options.maxLength} characters`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) =>
          isLocalizedText(value, options.maxLength, options.requireOne),
      },
    });
  };
}

/** Free-form metadata limits: serialized size and nesting depth. */
export const MAX_METADATA_BYTES = 4096;
export const MAX_METADATA_DEPTH = 3;

function depthOf(value: unknown): number {
  if (Array.isArray(value)) {
    return 1 + Math.max(0, ...value.map(depthOf));
  }
  if (typeof value === 'object' && value !== null) {
    return 1 + Math.max(0, ...Object.values(value).map(depthOf));
  }
  return 0;
}

/** A plain JSON object of at most 4 KB, nested at most 3 levels deep. */
export function isBoundedMetadata(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  return (
    Buffer.byteLength(json, 'utf8') <= MAX_METADATA_BYTES &&
    depthOf(value) <= MAX_METADATA_DEPTH
  );
}

export function IsBoundedMetadata(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isBoundedMetadata',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: `$property must be an object of at most ${MAX_METADATA_BYTES} bytes and ${MAX_METADATA_DEPTH} levels deep`,
        ...validationOptions,
      },
      validator: { validate: (value: unknown) => isBoundedMetadata(value) },
    });
  };
}
