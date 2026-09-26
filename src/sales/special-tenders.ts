import { EntityManager } from 'typeorm';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';

/**
 * Tenders that move no money through a drawer or terminal, created on first use
 * (like the LOYALTY method): each is recognised by its code, never its type.
 *
 * - ON_ACCOUNT: charged to the customer's account (customer credit ledger)
 * - GIFT_CARD / STORE_CREDIT: paid from a stored value account (never overdrawn)
 * - EXCHANGE_CREDIT: the value of goods returned in an exchange, paying for the
 *   replacement sale (only usable through the exchange flow)
 *
 * None of them is accepted offline: each needs a live balance / limit check.
 */
export const ON_ACCOUNT_CODE = 'ON_ACCOUNT';
export const GIFT_CARD_CODE = 'GIFT_CARD';
export const STORE_CREDIT_CODE = 'STORE_CREDIT';
export const EXCHANGE_CREDIT_CODE = 'EXCHANGE_CREDIT';

export type SpecialTenderCode =
  | typeof ON_ACCOUNT_CODE
  | typeof GIFT_CARD_CODE
  | typeof STORE_CREDIT_CODE
  | typeof EXCHANGE_CREDIT_CODE;

const DEFINITIONS: Record<
  SpecialTenderCode,
  { name: Record<string, string>; methodType: PaymentMethodType }
> = {
  ON_ACCOUNT: {
    name: { en: 'On account', fr: 'En compte' },
    methodType: PaymentMethodType.ON_ACCOUNT,
  },
  GIFT_CARD: {
    name: { en: 'Gift card', fr: 'Carte cadeau' },
    methodType: PaymentMethodType.GIFT_CARD,
  },
  STORE_CREDIT: {
    name: { en: 'Store credit', fr: 'Avoir' },
    methodType: PaymentMethodType.STORE_CREDIT,
  },
  EXCHANGE_CREDIT: {
    name: { en: 'Exchange credit', fr: "Crédit d'échange" },
    methodType: PaymentMethodType.OTHER,
  },
};

export const SPECIAL_TENDER_CODES = Object.keys(
  DEFINITIONS,
) as SpecialTenderCode[];

export const specialTenderOf = (
  method: Pick<PaymentMethod, 'code'> | null | undefined,
): SpecialTenderCode | null =>
  method && (SPECIAL_TENDER_CODES as string[]).includes(method.code)
    ? (method.code as SpecialTenderCode)
    : null;

/**
 * The method for a special tender, created (active) on first use. The exchange
 * credit method stays out of the till's tender list (settings.hidden).
 */
export async function ensureSpecialMethod(
  manager: EntityManager,
  tenantId: string,
  code: SpecialTenderCode,
): Promise<PaymentMethod> {
  const repo = manager.getRepository(PaymentMethod);
  const existing = await repo.findOne({ where: { tenantId, code } });
  if (existing) return existing;
  const definition = DEFINITIONS[code];
  try {
    return await repo.save(
      repo.create({
        tenantId,
        code,
        name: definition.name,
        methodType: definition.methodType,
        requiresReference: false,
        opensDrawer: false,
        provider: 'manual',
        status: PaymentMethodStatus.ACTIVE,
        settings: code === EXCHANGE_CREDIT_CODE ? { hidden: true } : {},
      }),
    );
  } catch (error) {
    // Created by a concurrent request
    if (isPgError(error, PG_UNIQUE_VIOLATION)) {
      return repo.findOneOrFail({ where: { tenantId, code } });
    }
    throw error;
  }
}

/** UPDATE ... RETURNING through TypeORM gives [rows, affected] on Postgres */
export function returnedRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0])) return result[0] as T[];
  return result as T[];
}
