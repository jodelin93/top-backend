/**
 * Domain events (spec §17). Each event is written to the transactional outbox
 * (OutboxService.record) inside the transaction that made the change, then
 * delivered by the outbox publisher to in-process consumers.
 *
 * Adding an event: add its payload to DomainEventPayloads and its aggregate to
 * EVENT_AGGREGATES. Changing a payload incompatibly: bump its schema version in
 * EVENT_SCHEMA_VERSIONS (consumers read `schemaVersion` to handle old rows).
 *
 * Payloads carry ids and amounts, never card data or customer contact details.
 */

type Money = number;

export interface DomainEventPayloads {
  // ----- Emitted by the platform modules (shifts, expenses, stock operations, settings, users)
  'shift.opened': {
    shiftId: string;
    shiftNumber: string;
    registerId: string;
    openingFloat: Money;
    openedById: string;
  };
  'shift.closed': {
    shiftId: string;
    shiftNumber: string;
    registerId: string;
    expected: Money | null;
    counted: Money | null;
    variance: Money | null;
    tolerance: Money;
    overTolerance: boolean;
    forceClosed: boolean;
    closedById: string;
  };
  'cash.movement': {
    movementId: string;
    shiftId: string;
    registerId: string;
    type: string;
    amount: Money;
    expenseId: string | null;
    sourceType: string | null;
    sourceId: string | null;
  };
  'expense.paid': {
    expenseId: string;
    expenseNumber: string;
    amount: Money;
    currencyCode: string;
    paymentMethod: string;
    registerId: string | null;
    shiftId: string | null;
  };
  'stock.count.posted': {
    countId: string;
    countNumber: string;
    locationId: string;
    approverId: string | null;
    adjustments: { variantId: string; variance: number }[];
  };
  'transfer.dispatched': {
    transferId: string;
    transferNumber: string;
    fromLocationId: string;
    toLocationId: string;
    lines: { variantId: string; quantity: number }[];
  };
  'transfer.received': {
    transferId: string;
    transferNumber: string;
    fromLocationId: string;
    toLocationId: string;
    status: string;
    lines: { variantId: string; quantity: number }[];
  };
  'settings.changed': {
    version: number;
    changedKeys: string[];
    scheduled: boolean;
    effectiveFrom: string;
  };
  'user.role_changed': {
    userId: string;
    previousRole: string;
    newRole: string;
  };

  // ----- For other modules to emit (sales, returns, payments, inventory, purchasing, customers)
  'sale.completed': {
    saleId: string;
    saleNumber: string;
    registerId: string | null;
    shiftId: string | null;
    total: Money;
    currencyCode: string;
    lines: { variantId: string; locationId: string | null; quantity: number }[];
  };
  'sale.voided': {
    saleId: string;
    saleNumber: string;
    reason: string | null;
  };
  'return.completed': {
    returnId: string;
    returnNumber: string;
    originalSaleId: string;
    total: Money;
    currencyCode: string;
  };
  'payment.captured': {
    paymentId: string;
    saleId: string;
    amount: Money;
    currencyCode: string;
    provider: string | null;
  };
  'stock.adjusted': {
    variantId: string;
    locationId: string;
    delta: number;
    movementType: string;
    // Quantities after the change, so consumers (low stock alerts) need no read
    quantityOnHand: number;
    quantityAvailable: number;
    referenceType: string | null;
    referenceId: string | null;
  };
  'goods.received': {
    receiptId: string;
    purchaseOrderId: string | null;
    locationId: string;
    lines: { variantId: string; quantity: number; unitCost: Money | null }[];
  };
  'customer.credit_changed': {
    customerId: string;
    previousBalance: Money;
    newBalance: Money;
    creditLimit: Money | null;
    reason: string | null;
  };
  'stored_value.changed': {
    accountId: string;
    accountType: string;
    customerId: string | null;
    entryId: string;
    entryType: string;
    amount: Money;
    previousBalance: Money;
    newBalance: Money;
    saleId: string | null;
    returnId: string | null;
  };
}

export type DomainEventType = keyof DomainEventPayloads;

/**
 * Payload fields that reveal customer balances (customer accounts, gift cards,
 * store credit): left out of event payloads shown to users without
 * customers.finance.view (System events page).
 */
export const BALANCE_PAYLOAD_KEYS: readonly string[] = [
  'previousBalance',
  'newBalance',
  'creditLimit',
];

/** Aggregate each event belongs to (its aggregateId is the id of that record) */
export const EVENT_AGGREGATES: Record<DomainEventType, string> = {
  'shift.opened': 'shift',
  'shift.closed': 'shift',
  'cash.movement': 'shift',
  'expense.paid': 'expense',
  'stock.count.posted': 'stock_count',
  'transfer.dispatched': 'stock_transfer',
  'transfer.received': 'stock_transfer',
  'settings.changed': 'settings',
  'user.role_changed': 'user',
  'sale.completed': 'sale',
  'sale.voided': 'sale',
  'return.completed': 'sale_return',
  'payment.captured': 'payment',
  'stock.adjusted': 'stock_level',
  'goods.received': 'goods_receipt',
  'customer.credit_changed': 'customer',
  'stored_value.changed': 'stored_value_account',
};

/** Payload schema version per event type (1 unless bumped) */
export const EVENT_SCHEMA_VERSIONS: Partial<Record<DomainEventType, number>> =
  {};

export const schemaVersionOf = (type: string): number =>
  EVENT_SCHEMA_VERSIONS[type as DomainEventType] ?? 1;

export const isDomainEventType = (value: string): value is DomainEventType =>
  Object.prototype.hasOwnProperty.call(EVENT_AGGREGATES, value);

/** What a module hands to OutboxService.record() */
export interface DomainEventInput<K extends DomainEventType = DomainEventType> {
  tenantId: string;
  type: K;
  aggregateId: string;
  payload: DomainEventPayloads[K];
  // Defaults to EVENT_AGGREGATES[type]
  aggregateType?: string;
  // Version of the aggregate after the change (e.g. the entity's @VersionColumn)
  aggregateVersion?: number | null;
  // Defaults to the current request id
  correlationId?: string | null;
  occurredAt?: Date;
}

/** An event as delivered to consumers */
export interface DeliveredEvent<K extends DomainEventType = DomainEventType> {
  id: string;
  tenantId: string;
  eventType: K;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number | null;
  schemaVersion: number;
  payload: DomainEventPayloads[K];
  correlationId: string | null;
  actorId: string | null;
  occurredAt: Date;
  attempts: number;
}
