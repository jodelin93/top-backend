/**
 * Pure rules for merging two customer records (the "merged" one is retired
 * into the "survivor").
 */
export const MERGE_CHOICE_FIELDS = [
  'customerType',
  'firstName',
  'lastName',
  'companyName',
  'email',
  'phone',
  'taxNumber',
  'dateOfBirth',
  'locale',
  'groupId',
  'creditLimit',
] as const;

export type MergeChoiceField = (typeof MERGE_CHOICE_FIELDS)[number];
export type MergeChoices = Partial<
  Record<MergeChoiceField, 'survivor' | 'merged'>
>;

export interface MergeableCustomer {
  customerType: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  taxNumber: string | null;
  dateOfBirth: Date | string | null;
  locale: string | null;
  groupId: string | null;
  creditLimit: number;
  currentBalance: number;
  loyaltyPoints: number;
  metadata: Record<string, unknown> | null;
  marketingEmailConsent: boolean;
  marketingSmsConsent: boolean;
  consentUpdatedAt: Date | null;
  consentSource: string | null;
  lastPurchaseAt: Date | null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;
const time = (value: Date | string | null | undefined) =>
  value ? new Date(value).getTime() : 0;

/**
 * Values of the surviving record after the merge:
 * - chosen fields come from the chosen record; unchosen ones keep the survivor's
 *   value, or take the merged one when the survivor's is empty
 * - loyalty points and balances are added up
 * - the most recent consent decision wins (neither record's is lost: the history is kept)
 * - custom fields: survivor's values win, the merged record fills the gaps
 */
export function resolveMergedCustomer(
  survivor: MergeableCustomer,
  merged: MergeableCustomer,
  choices: MergeChoices = {},
): Partial<MergeableCustomer> {
  const result: Partial<MergeableCustomer> = {};
  for (const field of MERGE_CHOICE_FIELDS) {
    const choice = choices[field];
    const own = survivor[field];
    const other = merged[field];
    const empty = own === null || own === undefined || own === '';
    (result as Record<string, unknown>)[field] =
      choice === 'merged' || (!choice && empty) ? other : own;
  }

  result.loyaltyPoints =
    Number(survivor.loyaltyPoints ?? 0) + Number(merged.loyaltyPoints ?? 0);
  result.currentBalance = round2(
    Number(survivor.currentBalance ?? 0) + Number(merged.currentBalance ?? 0),
  );

  const newerConsent =
    time(merged.consentUpdatedAt) > time(survivor.consentUpdatedAt)
      ? merged
      : survivor;
  result.marketingEmailConsent = newerConsent.marketingEmailConsent;
  result.marketingSmsConsent = newerConsent.marketingSmsConsent;
  result.consentUpdatedAt = newerConsent.consentUpdatedAt;
  result.consentSource = newerConsent.consentSource;

  result.lastPurchaseAt =
    time(merged.lastPurchaseAt) > time(survivor.lastPurchaseAt)
      ? merged.lastPurchaseAt
      : survivor.lastPurchaseAt;

  const survivorMeta = survivor.metadata ?? {};
  const mergedMeta = merged.metadata ?? {};
  const fields = (meta: Record<string, unknown>) =>
    (meta.customFields as Record<string, unknown> | undefined) ?? {};
  result.metadata = {
    ...mergedMeta,
    ...survivorMeta,
    customFields: { ...fields(mergedMeta), ...fields(survivorMeta) },
  };
  return result;
}
