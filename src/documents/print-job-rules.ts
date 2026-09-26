import type { Permission } from '../auth/permissions';
import type { DocumentType, PrintJobStatus } from './print-job.entity';

/**
 * Print job rules (spec §15), kept free of the database so they are easy to test.
 */

// Jobs that hold the document's original: only one may exist at a time
export const LIVE_STATUSES: PrintJobStatus[] = [
  'queued',
  'sent',
  'printed',
  'unknown',
];

// Where each document lives, and the number printed on it
export const DOCUMENT_SOURCES: Record<
  Exclude<DocumentType, 'label'>,
  { table: string; number: string }
> = {
  receipt: { table: 'sales', number: 'saleNumber' },
  invoice: { table: 'sales', number: 'saleNumber' },
  credit_note: { table: 'sale_returns', number: 'returnNumber' },
  pro_forma: { table: 'estimates', number: 'estimateNumber' },
  z_report: { table: 'shifts', number: 'shiftNumber' },
};

// Sales without a final receipt (the till prints nothing for them)
export const UNPRINTABLE_SALE_STATUSES = [
  'draft',
  'held',
  'payment_pending',
  'cancelled',
];

/**
 * Who may print a document, as "any of" these permissions. Copies of receipts and
 * invoices need sales.reprint (separate from viewing sales).
 */
export function printPermissions(
  documentType: DocumentType,
  copy: boolean,
): Permission[] {
  switch (documentType) {
    case 'receipt':
    case 'invoice':
      return copy ? ['sales.reprint'] : ['pos.sell', 'sales.reprint'];
    case 'credit_note':
      return copy ? ['sales.refund', 'sales.reprint'] : ['sales.refund'];
    case 'pro_forma':
      return ['estimates.manage'];
    case 'z_report':
      return ['shifts.operate', 'shifts.manage'];
    case 'label':
      return ['catalog.manage', 'inventory.receive'];
  }
}

// Every permission that can print something (the route guard; the service checks the type)
export const ANY_PRINT_PERMISSIONS: Permission[] = [
  'pos.sell',
  'sales.reprint',
  'sales.refund',
  'estimates.manage',
  'shifts.operate',
  'shifts.manage',
  'catalog.manage',
  'inventory.receive',
];

const NEXT: Record<PrintJobStatus, PrintJobStatus[]> = {
  queued: ['sent', 'printed', 'failed', 'unknown'],
  sent: ['printed', 'failed', 'unknown'],
  // A late answer from the printer (or the cashier checking the paper) settles it
  unknown: ['printed', 'failed'],
  printed: [],
  failed: [],
};

export function canMoveTo(from: PrintJobStatus, to: PrintJobStatus): boolean {
  return from === to || NEXT[from].includes(to);
}

/**
 * How a job may be retried:
 * - failed: nothing reached the printer, so the retry prints what was asked (an
 *   original stays an original, unless another original is live by then);
 * - queued / sent / unknown: it may have printed, so the retry is always a COPY;
 * - printed: nothing to retry (print a copy instead).
 * A retry re-prints the document only: it never opens the cash drawer again.
 */
export function retryAs(previous: {
  status: PrintJobStatus;
  copy: boolean;
}): { copy: boolean } | null {
  if (previous.status === 'printed') return null;
  if (previous.status === 'failed') return { copy: previous.copy };
  return { copy: true };
}

/** "jo***@example.com", "+509 ****12": enough to recognise, not to reuse */
export function maskRecipient(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf('@');
  if (at > 0) {
    const name = value.slice(0, at);
    return `${name.slice(0, Math.min(2, name.length - 1) || 1)}***${value.slice(at)}`;
  }
  const digits = value.replace(/\D/g, '');
  return digits.length > 2 ? `****${digits.slice(-2)}` : '****';
}

const EMAIL_IN_TEXT = /[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+\.[A-Za-z]{2,}/g;

/**
 * Free text (SMTP / transport errors) with every e-mail address in it masked, so
 * it can go to logs and audit metadata: servers often echo the recipient back
 * ("550 5.1.1 <jo@example.com>: user unknown").
 */
export function maskEmailsIn(text: string): string {
  return text.replace(EMAIL_IN_TEXT, (address) => maskRecipient(address) ?? '');
}
