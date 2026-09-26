import type { Branch } from '../database/entities/branch.entity';
import type { StoreSettings } from '../settings/settings.service';

/**
 * The seller identity a receipt was printed with, stored on the sale when it
 * completes (sales.documentSnapshot). Reprints use it instead of the current
 * settings, so a receipt never changes after the fact (new address, new tax id,
 * new footer...). Keys mirror StoreSettings so the POS can lay it over them.
 */
export interface SaleDocumentSnapshot {
  version: 1;
  capturedAt: string;
  storeName: string;
  businessLegalName: string;
  businessAddressLine1: string;
  businessAddressLine2: string;
  businessCity: string;
  businessState: string;
  businessPostalCode: string;
  businessCountry: string;
  businessPhone: string;
  businessEmail: string;
  businessWebsite: string;
  businessTaxId: string;
  businessRegistrationNumber: string;
  businessLogoUrl: string;
  receiptHeader: string;
  receiptFooter: string;
  returnPolicy: string;
  receiptTemplate: StoreSettings['receiptTemplate'];
  receiptFormat: StoreSettings['receiptFormat'];
  pricesIncludeTax: boolean;
  branch: {
    id: string;
    code: string;
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    stateProvince: string | null;
    postalCode: string | null;
    countryCode: string | null;
    phone: string | null;
    email: string | null;
    taxNumber: string | null;
  };
}

export function buildDocumentSnapshot(
  settings: StoreSettings,
  branch: Branch,
  at: Date = new Date(),
): SaleDocumentSnapshot {
  const str = (value: string | null | undefined) => value ?? '';
  const opt = (value: string | null | undefined) => value || null;
  return {
    version: 1,
    capturedAt: at.toISOString(),
    storeName: str(settings.storeName),
    businessLegalName: str(settings.businessLegalName),
    businessAddressLine1: str(settings.businessAddressLine1),
    businessAddressLine2: str(settings.businessAddressLine2),
    businessCity: str(settings.businessCity),
    businessState: str(settings.businessState),
    businessPostalCode: str(settings.businessPostalCode),
    businessCountry: str(settings.businessCountry),
    businessPhone: str(settings.businessPhone),
    businessEmail: str(settings.businessEmail),
    businessWebsite: str(settings.businessWebsite),
    businessTaxId: str(settings.businessTaxId),
    businessRegistrationNumber: str(settings.businessRegistrationNumber),
    businessLogoUrl: str(settings.businessLogoUrl),
    receiptHeader: str(settings.receiptHeader),
    receiptFooter: str(settings.receiptFooter),
    returnPolicy: str(settings.returnPolicy),
    receiptTemplate: settings.receiptTemplate ?? 'classic',
    receiptFormat: settings.receiptFormat ?? '80mm',
    pricesIncludeTax: !!settings.pricesIncludeTax,
    branch: {
      id: branch.id,
      code: branch.code,
      name: branch.name,
      addressLine1: opt(branch.addressLine1),
      addressLine2: opt(branch.addressLine2),
      city: opt(branch.city),
      stateProvince: opt(branch.stateProvince),
      postalCode: opt(branch.postalCode),
      countryCode: opt(branch.countryCode),
      phone: opt(branch.phone),
      email: opt(branch.email),
      taxNumber: opt(branch.taxNumber),
    },
  };
}
