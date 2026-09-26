import { round2 } from '../sales/sale-calculator';
import { ReturnDisposition } from '../database/entities/sale-return-item.entity';
import type { CreateReturnDto } from './returns.dto';

/**
 * The parts of a recorded return that tell which request created it
 */
export interface RecordedReturn {
  originalSaleId: string;
  registerId: string;
  reason: string;
  returnType?: string;
  items?: {
    saleItemId: string;
    quantity: number;
    disposition: ReturnDisposition;
    locationId: string | null;
    reason: string | null;
  }[];
  refunds?: {
    paymentMethodId: string;
    originalPaymentId: string | null;
    amount: number | string;
  }[];
}

const byKey = <T>(rows: T[], key: (row: T) => string) =>
  [...rows].sort((a, b) => key(a).localeCompare(key(b)));

// Refund amounts per payment method, in a stable order
const perMethod = (
  rows: { paymentMethodId: string; amount: number | string }[],
) => {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(
      row.paymentMethodId,
      round2((totals.get(row.paymentMethodId) ?? 0) + Number(row.amount)),
    );
  }
  return JSON.stringify(byKey([...totals.entries()], ([id]) => id));
};

/**
 * Canonical form of a return request (sale, register, reason, lines), so a resubmission
 * of the same idempotency key can be told apart from a different request reusing it
 */
export function canonicalReturnRequest(dto: CreateReturnDto): string {
  return JSON.stringify({
    saleId: dto.saleId,
    registerId: dto.registerId,
    reason: dto.reason,
    goodwill: dto.type === 'goodwill',
    items: byKey(dto.items, (i) => i.saleItemId).map((i) => ({
      saleItemId: i.saleItemId,
      quantity: i.quantity,
      disposition: i.disposition,
      reason: i.reason ?? null,
    })),
  });
}

function canonicalRecordedReturn(saleReturn: RecordedReturn): string {
  return JSON.stringify({
    saleId: saleReturn.originalSaleId,
    registerId: saleReturn.registerId,
    reason: saleReturn.reason,
    goodwill: saleReturn.returnType === 'goodwill',
    items: byKey(saleReturn.items ?? [], (i) => i.saleItemId).map((i) => ({
      saleItemId: i.saleItemId,
      quantity: Number(i.quantity),
      disposition: i.disposition,
      reason: i.reason ?? null,
    })),
  });
}

/**
 * Whether a recorded return is what `dto` asks for. The request itself isn't stored,
 * so it is compared with what the return recorded: sale, register, reason, lines
 * (and an explicit restock location), and how the refund was asked to be paid.
 */
export function matchesReturnRequest(
  saleReturn: RecordedReturn,
  dto: CreateReturnDto,
  // false: the refunds were planned by the server (exchange), not asked for
  compareRefunds = true,
): boolean {
  if (canonicalReturnRequest(dto) !== canonicalRecordedReturn(saleReturn)) {
    return false;
  }

  const items = new Map((saleReturn.items ?? []).map((i) => [i.saleItemId, i]));
  const locationsMatch = dto.items.every(
    (input) =>
      !input.locationId ||
      input.disposition !== ReturnDisposition.RESTOCK ||
      items.get(input.saleItemId)?.locationId === input.locationId,
  );
  if (!locationsMatch) return false;

  if (!compareRefunds) return true;
  const refunds = saleReturn.refunds ?? [];
  if (dto.refundToStoreCredit) {
    return refunds.every((r) => !r.originalPaymentId);
  }
  if (dto.refunds?.length) {
    return perMethod(refunds) === perMethod(dto.refunds);
  }
  if (dto.refundMethodId) {
    return refunds.every((r) => r.paymentMethodId === dto.refundMethodId);
  }
  // Default: back to the original payments, so every refund is linked to one
  return refunds.every((r) => !!r.originalPaymentId);
}
