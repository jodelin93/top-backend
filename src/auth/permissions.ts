/**
 * Permission catalog. Roles are sets of these keys (tenant_roles.permissions);
 * endpoints declare what they need with @RequirePermissions().
 * Adding a permission: add it here with a label, and to the default roles that should have it.
 */
export const PERMISSIONS = {
  // Till
  'pos.sell': { group: 'Point of sale', label: 'Sell at the till' },
  'pos.discount': {
    group: 'Point of sale',
    label: 'Give discounts up to the store limit',
  },
  'pos.discount.override': {
    group: 'Point of sale',
    label: 'Give discounts above the store limit',
  },
  'pos.price.override': {
    group: 'Point of sale',
    label: 'Change an item price at the till',
  },
  'pos.hold': { group: 'Point of sale', label: 'Hold and resume carts' },
  // Sales
  'sales.view': { group: 'Sales', label: 'View sales' },
  'sales.reprint': {
    group: 'Sales',
    label: 'Reprint receipts (marked COPY), e-mail or share them',
  },
  'sales.void': { group: 'Sales', label: 'Void sales' },
  'sales.refund': { group: 'Sales', label: 'Process returns and refunds' },
  'sales.refund.any_method': {
    group: 'Sales',
    label: 'Refund to another payment method than the sale was paid with',
  },
  'sales.refund.goodwill': {
    group: 'Sales',
    label: 'Give goodwill refunds (money back without goods)',
  },
  'sales.review': {
    group: 'Sales',
    label:
      'Review and resolve flagged sales (offline oversells, unapproved prices)',
  },
  'payments.reconcile': { group: 'Sales', label: 'Reconcile card settlements' },
  'estimates.manage': {
    group: 'Sales',
    label: 'Create and send estimates (quotes)',
  },
  // Cash
  'shifts.operate': {
    group: 'Cash',
    label: 'Open and close own register shift',
  },
  'shifts.manage': {
    group: 'Cash',
    label: 'Manage all shifts, paid-in/out, safe drops',
  },
  'expenses.create': { group: 'Cash', label: 'Record expenses' },
  'expenses.approve': { group: 'Cash', label: 'Approve expenses' },
  // Customers
  'customers.view': { group: 'Customers', label: 'Look up customers' },
  'customers.create': { group: 'Customers', label: 'Add customers' },
  'customers.manage': {
    group: 'Customers',
    label: 'Edit and delete customers',
  },
  'customers.merge': { group: 'Customers', label: 'Merge duplicate customers' },
  'customers.finance.view': {
    group: 'Customers',
    label: 'See customer balances and credit limits',
  },
  'customers.credit.sell': {
    group: 'Customers',
    label: "Sell on account (charge the customer's account)",
  },
  'customers.credit.override': {
    group: 'Customers',
    label: 'Sell on account above the credit limit',
  },
  'customers.credit.receive': {
    group: 'Customers',
    label: 'Take payments on customer accounts',
  },
  'customers.credit.manage': {
    group: 'Customers',
    label:
      'Adjust customer accounts and stored value, set credit holds and payment terms',
  },
  // Catalog
  'catalog.manage': {
    group: 'Catalog',
    label: 'Manage products and categories',
  },
  'catalog.import': { group: 'Catalog', label: 'Import products from CSV' },
  'pricing.manage': {
    group: 'Catalog',
    label: 'Manage price lists and tax categories',
  },
  'discounts.manage': { group: 'Catalog', label: 'Manage discount codes' },
  // Inventory
  'inventory.view': { group: 'Inventory', label: 'View stock' },
  'inventory.cost.view': {
    group: 'Inventory',
    label: 'See product costs, margins and stock value',
  },
  'inventory.receive': { group: 'Inventory', label: 'Receive stock' },
  'inventory.adjust': { group: 'Inventory', label: 'Adjust stock' },
  'inventory.count': { group: 'Inventory', label: 'Run stock counts' },
  'inventory.count.approve': {
    group: 'Inventory',
    label: 'Approve stock count variances',
  },
  'inventory.transfer': {
    group: 'Inventory',
    label: 'Transfer stock between locations',
  },
  'inventory.transfer.approve': {
    group: 'Inventory',
    label: 'Approve stock transfers and over-receipts',
  },
  // Purchasing
  'purchasing.manage': {
    group: 'Purchasing',
    label: 'Manage suppliers and purchase orders',
  },
  'purchasing.approve': {
    group: 'Purchasing',
    label: 'Approve purchase orders',
  },
  'purchasing.receive.unplanned': {
    group: 'Purchasing',
    label: 'Receive goods from a supplier without a purchase order',
  },
  'purchasing.payables': {
    group: 'Purchasing',
    label: 'Record supplier invoices, credits and payments',
  },
  // Reports & admin
  'reports.view': { group: 'Reports', label: 'View reports and dashboard' },
  'reports.export': { group: 'Reports', label: 'Export reports' },
  'users.manage': { group: 'Administration', label: 'Manage staff accounts' },
  'employees.manage': {
    group: 'Administration',
    label: 'Manage employees, their branches and attendance',
  },
  'roles.manage': {
    group: 'Administration',
    label: 'Manage roles and permissions',
  },
  'settings.manage': {
    group: 'Administration',
    label: 'Manage store settings',
  },
  'devices.manage': {
    group: 'Administration',
    label: 'Manage registered devices',
  },
  'hardware.manage': {
    group: 'Administration',
    label: 'Pair the print bridge, test receipt printers and cash drawers',
  },
  'audit.view': { group: 'Administration', label: 'View the audit log' },
  'platform.operate': {
    group: 'Administration',
    label: 'Monitor system events, background jobs and reconciliation',
  },
} as const;

export type Permission = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const isPermission = (value: string): value is Permission =>
  Object.prototype.hasOwnProperty.call(PERMISSIONS, value);

// Built-in roles every store gets. The owner always has every permission.
export const SYSTEM_ROLES: Record<
  'owner' | 'admin' | 'manager' | 'cashier',
  { name: string; description: string; permissions: Permission[] }
> = {
  owner: {
    name: 'Owner',
    description: 'Full access, including other owners. Cannot be edited.',
    permissions: ALL_PERMISSIONS,
  },
  admin: {
    name: 'Admin',
    description: 'Runs the store and its staff accounts.',
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    name: 'Manager',
    description: 'Runs day-to-day operations; cannot manage staff or roles.',
    permissions: ALL_PERMISSIONS.filter(
      (p) =>
        ![
          'users.manage',
          'roles.manage',
          'devices.manage',
          'platform.operate',
        ].includes(p),
    ),
  },
  cashier: {
    name: 'Cashier',
    description: 'Sells at the till.',
    permissions: [
      'pos.sell',
      'pos.discount',
      'pos.hold',
      'sales.view',
      'sales.reprint',
      'estimates.manage',
      'shifts.operate',
      'expenses.create',
      'customers.view',
      'customers.create',
      'customers.credit.receive',
      'inventory.view',
    ],
  },
};

export const OWNER_ROLE = 'owner';
