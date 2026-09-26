import { formatQuantity } from '../common/utils/quantity';
import type { SaleDocumentSnapshot } from '../sales/document-snapshot';

/**
 * Server-side receipt / invoice (spec §15), for e-mailed receipts and the public
 * receipt link. Built only from what the sale stored when it completed: its
 * documentSnapshot (seller identity, header/footer) and its lines and payments, so
 * it matches the printed receipt and never changes with later settings.
 * Every value is HTML-escaped; the page has no scripts.
 */
export interface ReceiptView {
  kind: 'receipt' | 'invoice';
  saleNumber: string;
  saleDate: Date | string;
  status: string;
  currencyCode: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  changeAmount: number;
  seller: Pick<
    SaleDocumentSnapshot,
    | 'storeName'
    | 'businessLegalName'
    | 'businessAddressLine1'
    | 'businessAddressLine2'
    | 'businessCity'
    | 'businessPostalCode'
    | 'businessState'
    | 'businessCountry'
    | 'businessPhone'
    | 'businessEmail'
    | 'businessWebsite'
    | 'businessTaxId'
    | 'businessRegistrationNumber'
    | 'businessLogoUrl'
    | 'receiptHeader'
    | 'receiptFooter'
    | 'returnPolicy'
    | 'pricesIncludeTax'
  >;
  items: {
    productName: string;
    variantName: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: number;
    subtotal: number;
    discountAmount: number;
    taxRate: number | null;
    // Measured items (sold by weight / length / volume): unit code and decimals
    unit?: string | null;
    unitPrecision?: number | null;
  }[];
  payments: { name: string; amount: number; reference: string | null }[];
  customer: {
    name: string;
    email: string | null;
    taxNumber: string | null;
    address: string | null;
  } | null;
  cashier: string | null;
  // A copy sent after the fact (the e-mail itself is never "the original")
  copyNumber?: number | null;
  lang: 'en' | 'fr';
}

const LABELS = {
  en: {
    receipt: 'Receipt',
    invoice: 'Invoice',
    number: 'No.',
    date: 'Date',
    cashier: 'Cashier',
    billTo: 'Bill to',
    taxNo: 'Tax no.',
    regNo: 'Reg. no.',
    item: 'Item',
    qty: 'Qty',
    unitPrice: 'Unit price',
    amount: 'Amount',
    discount: 'Discount',
    subtotal: 'Subtotal',
    discounts: 'Discounts',
    tax: 'Tax',
    taxIncluded: 'Tax (included)',
    total: 'TOTAL',
    change: 'Change',
    copy: 'COPY — NOT AN ORIGINAL',
    voided: 'VOIDED',
    refunded: 'REFUNDED',
    subject: 'Your receipt {number} from {store}',
  },
  fr: {
    receipt: 'Ticket de caisse',
    invoice: 'Facture',
    number: 'N°',
    date: 'Date',
    cashier: 'Caissier',
    billTo: 'Facturé à',
    taxNo: 'N° fiscal',
    regNo: 'N° d’immatriculation',
    item: 'Article',
    qty: 'Qté',
    unitPrice: 'Prix unitaire',
    amount: 'Montant',
    discount: 'Remise',
    subtotal: 'Sous-total',
    discounts: 'Remises',
    tax: 'Taxe',
    taxIncluded: 'Taxe (incluse)',
    total: 'TOTAL',
    change: 'Monnaie rendue',
    copy: 'COPIE — NON ORIGINAL',
    voided: 'ANNULÉE',
    refunded: 'REMBOURSÉE',
    subject: 'Votre ticket {number} de {store}',
  },
} as const;

export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function moneyFormatter(view: ReceiptView) {
  const locale = view.lang === 'fr' ? 'fr-FR' : 'en-US';
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: view.currencyCode,
    });
  } catch {
    format = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 });
  }
  return (value: number) => format.format(Number(value) || 0);
}

function sellerAddress(seller: ReceiptView['seller']): string[] {
  return [
    seller.businessAddressLine1,
    seller.businessAddressLine2,
    [seller.businessPostalCode, seller.businessCity].filter(Boolean).join(' '),
    [seller.businessState, seller.businessCountry].filter(Boolean).join(', '),
  ].filter(Boolean);
}

const dateText = (view: ReceiptView) =>
  new Date(view.saleDate).toLocaleString(
    view.lang === 'fr' ? 'fr-FR' : 'en-US',
    { dateStyle: 'medium', timeStyle: 'short' },
  );

export function receiptSubject(view: ReceiptView): string {
  return LABELS[view.lang].subject
    .replace('{number}', view.saleNumber)
    .replace('{store}', view.seller.storeName || 'POS');
}

/** Full HTML document (e-mail body and public receipt page) */
export function renderReceiptHtml(view: ReceiptView): string {
  const L = LABELS[view.lang];
  const money = moneyFormatter(view);
  const s = view.seller;
  const e = escapeHtml;
  const title = view.kind === 'invoice' ? L.invoice : L.receipt;
  const logo = /^https:\/\//i.test(s.businessLogoUrl ?? '')
    ? `<img src="${e(s.businessLogoUrl)}" alt="" style="max-height:64px;max-width:200px">`
    : '';
  const banner = view.copyNumber
    ? `<p style="border:1px solid #000;text-align:center;font-weight:bold;padding:4px">*** ${e(L.copy)}${view.copyNumber > 1 ? ` #${view.copyNumber}` : ''} ***</p>`
    : '';
  const status =
    view.status === 'voided'
      ? L.voided
      : view.status === 'refunded'
        ? L.refunded
        : null;
  const row = (label: string, value: string, bold = false) =>
    `<tr${bold ? ' style="font-weight:bold;font-size:1.1em"' : ''}><td style="padding:2px 8px 2px 0">${e(label)}</td><td style="text-align:right;padding:2px 0">${e(value)}</td></tr>`;

  const lines = view.items
    .map(
      (i) =>
        `<tr style="border-bottom:1px solid #ddd;vertical-align:top">
<td style="padding:4px 8px 4px 0">${e(i.productName)}${i.variantName ? ` (${e(i.variantName)})` : ''}${view.kind === 'invoice' && i.sku ? `<div style="color:#666;font-size:12px">${e(i.sku)}</div>` : ''}</td>
<td style="text-align:right;padding:4px 8px 4px 0">${e(lineQuantity(i))}</td>
<td style="text-align:right;padding:4px 8px 4px 0">${e(money(i.unitPrice))}${i.unit ? `/${e(i.unit)}` : ''}</td>
<td style="text-align:right;padding:4px 8px 4px 0">${i.discountAmount > 0 ? `-${e(money(i.discountAmount))}` : '—'}</td>
<td style="text-align:right;padding:4px 0">${e(money(Number(i.subtotal) - Number(i.discountAmount)))}</td>
</tr>`,
    )
    .join('');

  const buyer =
    view.kind === 'invoice' && view.customer
      ? `<div style="margin-top:16px"><div style="font-size:12px;text-transform:uppercase;color:#666">${e(L.billTo)}</div>
<div style="font-weight:bold">${e(view.customer.name)}</div>
${view.customer.address ? `<div style="white-space:pre-line">${e(view.customer.address)}</div>` : ''}
${view.customer.email ? `<div>${e(view.customer.email)}</div>` : ''}
${view.customer.taxNumber ? `<div>${e(L.taxNo)} ${e(view.customer.taxNumber)}</div>` : ''}</div>`
      : '';

  return `<!DOCTYPE html>
<html lang="${view.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(title)} ${e(view.saleNumber)}</title>
</head>
<body style="margin:0;padding:16px;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<div style="max-width:640px;margin:0 auto;background:#fff;padding:24px;border-radius:8px">
<div style="text-align:center">${logo}
<div style="font-size:20px;font-weight:bold">${e(s.storeName)}</div>
${s.businessLegalName && s.businessLegalName !== s.storeName ? `<div>${e(s.businessLegalName)}</div>` : ''}
${sellerAddress(s)
  .map((l) => `<div>${e(l)}</div>`)
  .join('')}
${[s.businessPhone, s.businessEmail, s.businessWebsite].filter(Boolean).length ? `<div>${[s.businessPhone, s.businessEmail, s.businessWebsite].filter(Boolean).map(e).join(' · ')}</div>` : ''}
${s.businessTaxId ? `<div>${e(L.taxNo)} ${e(s.businessTaxId)}</div>` : ''}
${s.businessRegistrationNumber ? `<div>${e(L.regNo)} ${e(s.businessRegistrationNumber)}</div>` : ''}
${s.receiptHeader ? `<div style="margin-top:8px;white-space:pre-line">${e(s.receiptHeader)}</div>` : ''}
</div>
<h1 style="font-size:18px;text-transform:uppercase;letter-spacing:1px;margin:16px 0 4px">${e(title)}</h1>
<div>${e(L.number)} ${e(view.saleNumber)} · ${e(L.date)} ${e(dateText(view))}</div>
${view.cashier ? `<div>${e(L.cashier)}: ${e(view.cashier)}</div>` : ''}
${banner}
${status ? `<p style="text-align:center;font-weight:bold">*** ${e(status)} ***</p>` : ''}
${buyer}
<table style="width:100%;border-collapse:collapse;margin-top:16px;font-size:14px">
<thead><tr style="border-bottom:2px solid #000;text-align:left">
<th style="padding:4px 8px 4px 0">${e(L.item)}</th><th style="text-align:right;padding:4px 8px 4px 0">${e(L.qty)}</th>
<th style="text-align:right;padding:4px 8px 4px 0">${e(L.unitPrice)}</th><th style="text-align:right;padding:4px 8px 4px 0">${e(L.discount)}</th>
<th style="text-align:right;padding:4px 0">${e(L.amount)}</th></tr></thead>
<tbody>${lines}</tbody>
</table>
<table style="margin:16px 0 0 auto;font-size:14px">
${row(L.subtotal, money(view.subtotal))}
${view.discountAmount > 0 ? row(L.discounts, `-${money(view.discountAmount)}`) : ''}
${row(s.pricesIncludeTax ? L.taxIncluded : L.tax, money(view.taxAmount))}
${row(L.total, money(view.total), true)}
${view.payments.map((p) => row(`${p.name}${p.reference ? ` #${p.reference}` : ''}`, money(p.amount))).join('')}
${view.changeAmount > 0 ? row(L.change, money(view.changeAmount)) : ''}
</table>
${s.returnPolicy ? `<p style="margin-top:16px;font-size:12px;color:#444;white-space:pre-line">${e(s.returnPolicy)}</p>` : ''}
${s.receiptFooter ? `<p style="margin-top:16px;text-align:center;white-space:pre-line">${e(s.receiptFooter)}</p>` : ''}
</div>
</body>
</html>`;
}

/** Plain-text alternative of the e-mail */
export function renderReceiptText(view: ReceiptView): string {
  const L = LABELS[view.lang];
  const money = moneyFormatter(view);
  const s = view.seller;
  return [
    s.storeName,
    ...sellerAddress(s),
    s.businessTaxId ? `${L.taxNo} ${s.businessTaxId}` : '',
    '',
    `${view.kind === 'invoice' ? L.invoice : L.receipt} ${view.saleNumber}`,
    dateText(view),
    view.copyNumber ? `*** ${L.copy} ***` : '',
    '',
    ...view.items.map((i) =>
      i.unitPrecision
        ? // Measured: "1.250 kg × 3.99/kg Apples  4.99"
          `${lineQuantity(i)} x ${money(i.unitPrice)}${i.unit ? `/${i.unit}` : ''} ${i.productName}${i.variantName ? ` (${i.variantName})` : ''}  ${money(Number(i.subtotal) - Number(i.discountAmount))}`
        : `${i.quantity} x ${i.productName}${i.variantName ? ` (${i.variantName})` : ''}  ${money(Number(i.subtotal) - Number(i.discountAmount))}`,
    ),
    '',
    `${L.subtotal}: ${money(view.subtotal)}`,
    view.discountAmount > 0
      ? `${L.discounts}: -${money(view.discountAmount)}`
      : '',
    `${s.pricesIncludeTax ? L.taxIncluded : L.tax}: ${money(view.taxAmount)}`,
    `${L.total}: ${money(view.total)}`,
    ...view.payments.map((p) => `${p.name}: ${money(p.amount)}`),
    '',
    s.receiptFooter,
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n');
}

/** Quantity of a receipt line: "1.250 kg" for measured items, "2" otherwise */
export function lineQuantity(item: {
  quantity: number;
  unit?: string | null;
  unitPrecision?: number | null;
}): string {
  if (!item.unitPrecision) return String(Number(item.quantity));
  return formatQuantity(Number(item.quantity), {
    code: item.unit ?? null,
    allowsDecimals: true,
    precision: item.unitPrecision,
  });
}
