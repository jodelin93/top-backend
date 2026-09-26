#!/usr/bin/env node
/**
 * Demo data for manual testing: fills a store with a realistic catalog, staff with
 * different roles, customers, suppliers, stock, ~60 days of sales history, returns,
 * shifts, expenses, estimates and more.
 *
 * Everything is created through the running API (so stock ledgers, totals, loyalty
 * and audit trails are consistent), then the history is moved back in time in the
 * database so dashboards and reports have something to show.
 *
 * Usage (backend running on API_URL, default http://localhost:3000/api/v1):
 *   npm run seed:demo                         # seeds the store of admin@test.com
 *   npm run seed:demo -- --reset              # wipes that store's data first
 *   OWNER_EMAIL=x@y.com OWNER_PASSWORD=... npm run seed:demo
 *
 * Refuses to run in production, and on a store that already has products unless --reset.
 */
import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}/api/v1`;
const OWNER_EMAIL = (process.env.OWNER_EMAIL ?? 'admin@test.com').toLowerCase();
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? process.env.ADMIN_PASSWORD ?? 'Password123!';
const STAFF_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo1234!';
const RESET = process.argv.includes('--reset');
const HISTORY_DAYS = 60;
const DAY = 86_400_000;

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production');
  process.exit(1);
}

// ---------- deterministic randomness (same data on every run) ----------
let seed = 20260924;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;
const round2 = (n) => Math.round(n * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API helpers ----------
const tokens = {};
const credentials = {};
// Accounts that can no longer sign in (password changed meanwhile) act through a stand-in
const standIn = { jean: 'lina', lina: 'jean', stock: 'owner', accounts: 'owner', manager: 'owner', admin: 'owner' };
let current = 'owner';

async function request(method, path, body, { as = current, headers = {}, allow = [] } = {}) {
  let relogged = false;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(tokens[as] ? { Authorization: `Bearer ${tokens[as]}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (res.status === 429 && attempt < 8) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    // Session ended (e.g. the password was reset in the admin while seeding): sign in again
    if (res.status === 401 && credentials[as] && !relogged) {
      relogged = true;
      try {
        await login(as, ...credentials[as]);
      } catch {
        const fallback = standIn[as] ?? 'owner';
        console.log(`  ${credentials[as][0]} can no longer sign in; continuing as ${fallback}`);
        tokens[as] = tokens[fallback];
        delete credentials[as];
      }
      continue;
    }
    if (res.ok || allow.includes(res.status)) return data;
    const message = Array.isArray(data?.message) ? data.message.join('; ') : (data?.message ?? text);
    throw new Error(`${method} ${path} → ${res.status}: ${message}`);
  }
}
const get = (path, opts) => request('GET', path, undefined, opts);
const post = (path, body, opts) => request('POST', path, body ?? {}, opts);
const patch = (path, body, opts) => request('PATCH', path, body, opts);
const put = (path, body, opts) => request('PUT', path, body, opts);

async function login(key, email, password) {
  const data = await request('POST', '/auth/login', { email, password }, { as: '__none' });
  if (!data?.accessToken) throw new Error(`Login for ${email} did not return a token (MFA enabled?)`);
  tokens[key] = data.accessToken;
  credentials[key] = [email, password];
}

/** Run tasks with limited concurrency */
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

const step = (label) => console.log(`\n▸ ${label}`);
const list = (data) => (Array.isArray(data) ? data : (data?.data ?? []));

// EAN-13 with a valid check digit
let eanCounter = 1000;
function ean13() {
  const body = `200${String(eanCounter++).padStart(9, '0')}`;
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return body + ((10 - (sum % 10)) % 10);
}

// ---------- database ----------
const newClient = () => {
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  });
  // An idle connection dropped by the server must not crash the run; the next step reconnects
  client.on('error', () => {});
  return client;
};
let db = newClient();

/** Fresh connection: the seed runs long and hosted databases drop idle connections */
async function reconnect() {
  await db.end().catch(() => {});
  db = newClient();
  await db.connect();
}

// ---------- demo content ----------
const STAFF = [
  { key: 'admin', email: 'sophie.admin@test.com', firstName: 'Sophie', lastName: 'Laurent', role: 'admin' },
  { key: 'manager', email: 'marc.manager@test.com', firstName: 'Marc', lastName: 'Etienne', role: 'manager' },
  { key: 'lina', email: 'lina.cashier@test.com', firstName: 'Lina', lastName: 'Joseph', role: 'cashier' },
  { key: 'jean', email: 'jean.cashier@test.com', firstName: 'Jean', lastName: 'Pierre', role: 'cashier' },
  { key: 'stock', email: 'paul.stock@test.com', firstName: 'Paul', lastName: 'Desir', role: 'inventory-clerk' },
  { key: 'accounts', email: 'nadia.accounts@test.com', firstName: 'Nadia', lastName: 'Charles', role: 'accountant' },
];

const CUSTOM_ROLES = [
  {
    key: 'inventory-clerk',
    name: 'Inventory clerk',
    description: 'Receives deliveries, counts and moves stock. No selling.',
    permissions: [
      'inventory.view', 'inventory.receive', 'inventory.adjust', 'inventory.count', 'inventory.transfer',
      'purchasing.manage', 'catalog.manage',
    ],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Reports, expenses and payment reconciliation. Read-only on sales.',
    permissions: [
      'reports.view', 'reports.export', 'sales.view', 'expenses.create', 'expenses.approve',
      'payments.reconcile', 'audit.view', 'customers.view',
    ],
  },
];

// Categories: [code, name, parent code, tax category]
const CATEGORIES = [
  ['FOOD', 'Food & Grocery', null],
  ['BEV', 'Beverages', 'FOOD'],
  ['SNACK', 'Snacks & Sweets', 'FOOD'],
  ['DAIRY', 'Dairy & Eggs', 'FOOD'],
  ['BAKERY', 'Bakery', 'FOOD'],
  ['PANTRY', 'Pantry Staples', 'FOOD'],
  ['ELEC', 'Electronics', null],
  ['PHONE', 'Phones & Accessories', 'ELEC'],
  ['AUDIO', 'Audio', 'ELEC'],
  ['APPAREL', 'Clothing & Shoes', null],
  ['MEN', 'Men', 'APPAREL'],
  ['WOMEN', 'Women', 'APPAREL'],
  ['SHOES', 'Shoes', 'APPAREL'],
  ['HOME', 'Home & Kitchen', null],
  ['BEAUTY', 'Health & Beauty', null],
  ['STATION', 'Stationery & Office', null],
  ['TOYS', 'Toys & Games', null],
  ['GIFT', 'Gift Sets', null],
];

// Simple products: [sku, name, category, price, cost, brand, tax, extras]
// tax: 'std' 10%, 'food' 5%, 'zero' 0%
const SIMPLE = [
  ['BEV-WAT-500', 'Spring Water 500ml', 'BEV', 0.75, 0.25, 'Crystal', 'food'],
  ['BEV-WAT-15L', 'Spring Water 1.5L', 'BEV', 1.5, 0.55, 'Crystal', 'food'],
  ['BEV-COLA-355', 'Cola Can 355ml', 'BEV', 1.25, 0.5, 'Fizz', 'std'],
  ['BEV-OJ-1L', 'Orange Juice 1L', 'BEV', 3.49, 1.8, 'SunGrove', 'food'],
  ['BEV-COF-250', 'Ground Coffee 250g', 'BEV', 6.99, 3.5, 'Rebo', 'food'],
  ['BEV-TEA-25', 'Green Tea (25 bags)', 'BEV', 3.29, 1.4, 'Leafy', 'food'],
  ['BEV-ENRG-250', 'Energy Drink 250ml', 'BEV', 2.49, 1.05, 'Volt', 'std'],
  ['SNK-CHIP-150', 'Potato Chips 150g', 'SNACK', 2.29, 0.9, 'Crunchy', 'std'],
  ['SNK-CHOC-100', 'Dark Chocolate Bar 100g', 'SNACK', 2.99, 1.2, 'Cacao+', 'std'],
  ['SNK-NUTS-200', 'Roasted Peanuts 200g', 'SNACK', 2.49, 1.0, 'Crunchy', 'food'],
  ['SNK-COOK-300', 'Butter Cookies 300g', 'SNACK', 3.99, 1.7, 'Maison', 'std'],
  ['DRY-MILK-1L', 'Whole Milk 1L', 'DAIRY', 1.89, 1.1, 'Farmhouse', 'zero'],
  ['DRY-EGG-12', 'Eggs (dozen)', 'DAIRY', 3.49, 2.1, 'Farmhouse', 'zero'],
  ['DRY-YOG-500', 'Plain Yogurt 500g', 'DAIRY', 2.79, 1.4, 'Farmhouse', 'zero'],
  ['DRY-CHS-200', 'Cheddar Cheese 200g', 'DAIRY', 4.49, 2.6, 'Farmhouse', 'food'],
  ['BAK-BRD-WHT', 'White Bread Loaf', 'BAKERY', 2.49, 0.95, 'Maison', 'zero'],
  ['BAK-CROIS-4', 'Croissants (4 pack)', 'BAKERY', 4.29, 1.8, 'Maison', 'food'],
  ['PAN-RICE-5KG', 'Long Grain Rice 5kg', 'PANTRY', 8.99, 5.4, 'Golden', 'zero'],
  ['PAN-BEAN-1KG', 'Black Beans 1kg', 'PANTRY', 3.19, 1.6, 'Golden', 'zero'],
  ['PAN-OIL-1L', 'Vegetable Oil 1L', 'PANTRY', 4.49, 2.5, 'Golden', 'food'],
  ['PAN-SUGAR-2KG', 'Cane Sugar 2kg', 'PANTRY', 3.79, 2.0, 'Golden', 'zero'],
  ['PAN-PASTA-500', 'Spaghetti 500g', 'PANTRY', 1.69, 0.7, 'Nonna', 'zero'],
  ['PAN-TOM-400', 'Crushed Tomatoes 400g', 'PANTRY', 1.49, 0.6, 'Nonna', 'food'],
  ['ELC-CHG-20W', 'USB-C Fast Charger 20W', 'PHONE', 19.99, 7.5, 'Voltix', 'std'],
  ['ELC-CBL-1M', 'USB-C Cable 1m', 'PHONE', 9.99, 2.5, 'Voltix', 'std'],
  ['ELC-PWR-10K', 'Power Bank 10000mAh', 'PHONE', 29.99, 13.0, 'Voltix', 'std', { serialized: false }],
  ['ELC-PHN-A15', 'Smartphone A15 128GB', 'PHONE', 219.0, 160.0, 'Nova', 'std', { serialized: true }],
  ['ELC-EAR-BT', 'Wireless Earbuds', 'AUDIO', 49.99, 21.0, 'Soundly', 'std'],
  ['ELC-SPK-BT', 'Bluetooth Speaker', 'AUDIO', 39.99, 17.0, 'Soundly', 'std'],
  ['ELC-HP-OVR', 'Over-Ear Headphones', 'AUDIO', 79.99, 38.0, 'Soundly', 'std'],
  ['HOM-MUG-CER', 'Ceramic Mug 350ml', 'HOME', 7.99, 2.5, 'Casa', 'std'],
  ['HOM-PAN-28', 'Non-stick Frying Pan 28cm', 'HOME', 24.99, 11.0, 'Casa', 'std'],
  ['HOM-KNF-SET', 'Kitchen Knife Set (5)', 'HOME', 34.99, 15.0, 'Casa', 'std'],
  ['HOM-TWL-BTH', 'Bath Towel', 'HOME', 12.99, 5.0, 'Casa', 'std'],
  ['HOM-CNDL-VAN', 'Scented Candle Vanilla', 'HOME', 9.49, 3.2, 'Glow', 'std'],
  ['HOM-BULB-LED', 'LED Bulb 9W (2 pack)', 'HOME', 6.49, 2.4, 'Brite', 'std'],
  ['BTY-SHMP-400', 'Shampoo 400ml', 'BEAUTY', 5.99, 2.3, 'Pure', 'std'],
  ['BTY-SOAP-3', 'Bar Soap (3 pack)', 'BEAUTY', 3.49, 1.2, 'Pure', 'std'],
  ['BTY-TOOTH-100', 'Toothpaste 100ml', 'BEAUTY', 2.99, 1.1, 'Smile', 'std'],
  ['BTY-LOTN-250', 'Body Lotion 250ml', 'BEAUTY', 7.49, 3.0, 'Pure', 'std'],
  ['BTY-SUN-SPF50', 'Sunscreen SPF50', 'BEAUTY', 11.99, 5.2, 'Pure', 'std'],
  ['STA-NB-A5', 'Notebook A5 (ruled)', 'STATION', 3.99, 1.2, 'Scribe', 'std'],
  ['STA-PEN-10', 'Ballpoint Pens (10 pack)', 'STATION', 4.49, 1.5, 'Scribe', 'std'],
  ['STA-PAPER-500', 'Printer Paper A4 (500)', 'STATION', 6.99, 3.8, 'Scribe', 'std'],
  ['STA-CALC-SCI', 'Scientific Calculator', 'STATION', 17.99, 8.0, 'Scribe', 'std'],
  ['TOY-PUZ-1000', 'Jigsaw Puzzle 1000pc', 'TOYS', 14.99, 6.0, 'Playtime', 'std'],
  ['TOY-CAR-RC', 'Remote Control Car', 'TOYS', 34.99, 16.0, 'Playtime', 'std'],
  ['TOY-BALL-SOC', 'Soccer Ball', 'TOYS', 19.99, 8.0, 'Playtime', 'std'],
  ['TOY-CARD-UNO', 'Card Game', 'TOYS', 8.99, 3.5, 'Playtime', 'std'],
];

// Variable products: [sku, name, category, price, cost, brand, {attribute: values}]
const VARIABLE = [
  ['APP-TEE-BASIC', 'Basic Cotton T-Shirt', 'MEN', 14.99, 5.0, 'Urban', { size: ['S', 'M', 'L', 'XL'], color: ['Black', 'White', 'Navy'] }],
  ['APP-JEAN-SLIM', 'Slim Fit Jeans', 'MEN', 39.99, 17.0, 'Urban', { size: ['S', 'M', 'L', 'XL'] }],
  ['APP-DRS-SUM', 'Summer Dress', 'WOMEN', 44.99, 18.0, 'Belle', { size: ['S', 'M', 'L'], color: ['Red', 'Blue'] }],
  ['APP-HOOD-ZIP', 'Zip Hoodie', 'WOMEN', 34.99, 14.0, 'Urban', { size: ['S', 'M', 'L'], color: ['Grey', 'Black'] }],
  ['SHO-RUN-PRO', 'Running Shoes', 'SHOES', 69.99, 31.0, 'Stride', { 'shoe-size': ['39', '40', '41', '42', '43'] }],
  ['SHO-SAND', 'Beach Sandals', 'SHOES', 12.99, 4.5, 'Stride', { 'shoe-size': ['38', '40', '42'], color: ['Black', 'Blue'] }],
  ['ELC-CASE-A15', 'Phone Case A15', 'PHONE', 12.99, 3.0, 'Nova', { color: ['Black', 'Red', 'Blue'] }],
];

// Composite products (bundles): [sku, name, price, cost, contents]
const COMPOSITE = [
  ['GFT-BREAKFAST', 'Breakfast Basket', 24.99, 12.0, 'Coffee, croissants, orange juice, jam'],
  ['GFT-SPA', 'Spa Gift Set', 29.99, 12.5, 'Shampoo, lotion, soap, candle'],
  ['GFT-BACK2SCH', 'Back-to-School Kit', 19.99, 8.0, 'Notebooks, pens, calculator'],
];

const FIRST = ['Marie', 'Jean', 'Rose', 'Pierre', 'Nadine', 'Luc', 'Carline', 'Samuel', 'Esther', 'Daniel', 'Fabiola', 'Ricardo', 'Mirlande', 'Kevin', 'Judith', 'Wilson', 'Guerline', 'Patrick', 'Sandra', 'Emmanuel', 'Nathalie', 'Stanley', 'Claudette', 'Marvin'];
const LAST = ['Joseph', 'Pierre', 'Louis', 'Jean-Baptiste', 'Charles', 'Francois', 'Paul', 'Michel', 'Augustin', 'Etienne', 'Desir', 'Dorval', 'Celestin', 'Noel', 'Alexis', 'Baptiste'];
const BUSINESSES = ['Café Soleil', 'Hotel Belvedere', 'Ecole Saint-Marc', 'Resto Chez Lolo', 'Bureau Lumière'];

// ---------- main ----------
const created = { sales: [], returns: [] }; // backdating plan
const log = (msg) => console.log(`  ${msg}`);

async function main() {
  await db.connect();
  const owner = (
    await db.query(
      `SELECT m."tenantId", u.id AS "userId" FROM users u
       JOIN tenant_memberships m ON m."userId" = u.id AND m.role = 'owner'
       WHERE lower(u.email) = $1 LIMIT 1`,
      [OWNER_EMAIL],
    )
  ).rows[0];
  if (!owner) throw new Error(`No store owned by ${OWNER_EMAIL}. Run "npm run seed" first to create it.`);
  const tenantId = owner.tenantId;

  const existing = Number(
    (await db.query(`SELECT count(*) FROM products WHERE "tenantId" = $1`, [tenantId])).rows[0].count,
  );
  if (existing > 0 && !RESET) {
    throw new Error(`The store already has ${existing} products. Re-run with --reset to wipe it and seed again.`);
  }
  if (RESET) await wipe(tenantId, owner.userId);

  await login('owner', OWNER_EMAIL, OWNER_PASSWORD);
  const setupStart = new Date();

  // ===== Store setup =====
  step('Store settings, branches, registers, payment methods');
  const init = await post('/settings/initialize');
  const settings = await get('/settings');
  const currency = settings.currencyCode ?? 'USD';
  const originalRequireShift = settings.requireOpenShift;

  const taxStd = await post('/tax-rates', { code: 'VAT10', name: { en: 'Standard 10%' }, rate: 10 });
  const taxFood = await post('/tax-rates', { code: 'VAT5', name: { en: 'Reduced 5% (food)' }, rate: 5 });
  const taxZero = await post('/tax-rates', { code: 'VAT0', name: { en: 'Zero-rated' }, rate: 0 });

  await patch('/settings', {
    storeName: 'Top Service Market',
    businessLegalName: 'Top Service Market S.A.',
    businessAddressLine1: '25 Rue Capois',
    businessCity: 'Port-au-Prince',
    businessCountry: 'Haiti',
    businessPhone: '+509 2940 1122',
    businessEmail: 'hello@topservice.test',
    businessWebsite: 'www.topservice.test',
    businessTaxId: 'NIF 001-234-567-8',
    businessRegistrationNumber: 'RC 2019-0457',
    returnPolicy: 'Returns accepted within 30 days with receipt. Electronics must be unopened.',
    receiptHeader: 'Welcome to Top Service Market!',
    receiptFooter: 'Thank you for shopping with us — see you soon!',
    receiptTemplate: 'classic',
    receiptShowBarcode: true,
    receiptShowLoyalty: true,
    defaultTaxRateId: taxStd.id,
    maxDiscountPercent: 15,
    returnWindowDays: 30,
    purchaseApprovalThreshold: 1500,
    loyaltyEnabled: true,
    loyaltyEarnPercent: 2,
    loyaltyPointValue: 0.01,
    loyaltyMinRedeemPoints: 100,
    loyaltyMaxRedeemPercent: 50,
    // Customers pay in US dollars or Haitian gourdes
    exchangeRates: { HTG: 131.75 },
    // Historical sales are recorded without shifts; restored at the end
    requireOpenShift: false,
  });

  // A rate change, so the rate history has entries
  await patch('/settings', { exchangeRates: { HTG: 132.5 }, note: 'Exchange rate update' });
  const HTG_RATE = 132.5;

  const branch1 = init.branch ?? list(await get('/branches'))[0];
  const register1 = init.register;
  const floor1 = init.location;
  await patch(`/branches/${branch1.id}`, {
    name: 'Main Store — Capois',
    addressLine1: '25 Rue Capois',
    city: 'Port-au-Prince',
    phone: '+509 2940 1122',
  }).catch(() => {});

  const branch2 = await post('/branches', {
    code: 'DT',
    name: 'Downtown Branch — Pétion-Ville',
    addressLine1: '12 Rue Grégoire',
    city: 'Pétion-Ville',
    countryCode: 'HT',
    phone: '+509 2811 3344',
    currencyCode: currency,
  });
  const whBack = await post('/warehouses', { code: 'BACK', name: 'Backstore Warehouse', city: 'Port-au-Prince' });
  const backLoc = await post('/locations', { warehouseId: whBack.id, code: 'BACK-A1', name: 'Backstore aisle A', locationType: 'aisle', isSellable: false });
  const whDt = await post('/warehouses', { code: 'DT', name: 'Downtown Store', city: 'Pétion-Ville' });
  const floor2 = await post('/locations', { warehouseId: whDt.id, code: 'DT-FLOOR', name: 'Downtown sales floor', locationType: 'zone', isSellable: true });
  const register2 = await post('/registers', { branchId: branch1.id, code: 'REG-2', name: 'Register 2 (express)', defaultLocationId: floor1.id });
  const register3 = await post('/registers', { branchId: branch2.id, code: 'DT-1', name: 'Downtown Register', defaultLocationId: floor2.id });
  log(`branches: 2, registers: 3, stock locations: 3, tax rates: 3`);

  await post('/payment-methods', { code: 'MONCASH', name: { en: 'MonCash' }, methodType: 'mobile', requiresReference: true });
  await post('/payment-methods', { code: 'BANK', name: { en: 'Bank transfer' }, methodType: 'bank_transfer', requiresReference: true });
  const ctx = await get('/pos/context');
  const method = Object.fromEntries(ctx.paymentMethods.map((m) => [m.code, m.id]));

  await put('/shifts/denominations', { currencyCode: currency, denominations: [1000, 500, 250, 100, 50, 25, 10, 5, 1, 0.25, 0.1, 0.05] }).catch(() => {});

  // ===== Staff =====
  step('Roles and staff accounts');
  for (const role of CUSTOM_ROLES) await post('/roles', role);
  for (const s of STAFF) {
    await post('/users', { email: s.email, firstName: s.firstName, lastName: s.lastName, password: STAFF_PASSWORD, role: s.role });
  }
  for (const s of STAFF) await login(s.key, s.email, STAFF_PASSWORD);
  log(STAFF.map((s) => `${s.email} (${s.role})`).join('\n  '));

  // ===== Catalog =====
  step('Tax categories, categories, attributes');
  const taxCat = {
    std: await post('/tax-categories', { code: 'STANDARD', name: { en: 'Standard goods' }, taxRateId: taxStd.id }),
    food: await post('/tax-categories', { code: 'FOOD', name: { en: 'Food & beverages' }, taxRateId: taxFood.id }),
    zero: await post('/tax-categories', { code: 'BASIC', name: { en: 'Basic necessities' }, taxRateId: taxZero.id }),
  };
  const cat = {};
  for (const [i, [code, name, parent]] of CATEGORIES.entries()) {
    cat[code] = await post('/categories', { code, name: { en: name }, parentId: parent ? cat[parent].id : undefined, sortOrder: i });
  }
  const attr = {
    size: await post('/attributes', { code: 'size', name: { en: 'Size' }, attributeType: 'select', options: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], isVariantDefining: true, sortOrder: 1 }),
    color: await post('/attributes', { code: 'color', name: { en: 'Color' }, attributeType: 'color', options: ['Black', 'White', 'Navy', 'Red', 'Blue', 'Grey'], isVariantDefining: true, sortOrder: 2 }),
    'shoe-size': await post('/attributes', { code: 'shoe-size', name: { en: 'Shoe size' }, attributeType: 'select', options: ['37', '38', '39', '40', '41', '42', '43', '44'], isVariantDefining: true, sortOrder: 3 }),
    material: await post('/attributes', { code: 'material', name: { en: 'Material' }, attributeType: 'text', sortOrder: 4 }),
  };

  step('Products');
  const variants = []; // { id, sku, price, cost, categoryCode, productId, name }
  const lowStockSkus = new Set(['ELC-PHN-A15', 'BTY-SUN-SPF50', 'HOM-KNF-SET', 'TOY-CAR-RC']);
  const inactiveSkus = new Set(['TOY-CARD-UNO']);

  await pool(SIMPLE, 4, async ([sku, name, catCode, price, cost, brand, tax, extras = {}]) => {
    const product = await post('/products', {
      sku,
      name: { en: name },
      description: { en: `${name} by ${brand}.` },
      productType: 'simple',
      categoryId: cat[catCode].id,
      taxCategoryId: taxCat[tax].id,
      brand,
      barcode: ean13(),
      price,
      cost,
      isSerialized: !!extras.serialized,
      reorderPoint: lowStockSkus.has(sku) ? 10 : 5,
      reorderQuantity: 24,
      minStockLevel: 3,
    });
    const v = product.variants[0];
    variants.push({ id: v.id, sku, price, cost, categoryCode: catCode, productId: product.id, name, tax });
  });

  for (const [sku, name, catCode, price, cost, brand, options] of VARIABLE) {
    const product = await post('/products', {
      sku,
      name: { en: name },
      description: { en: `${name} by ${brand}. Available in several ${Object.keys(options).join(' and ')}s.` },
      productType: 'variable',
      categoryId: cat[catCode].id,
      taxCategoryId: taxCat.std.id,
      brand,
    });
    await post(`/products/${product.id}/variants/generate`, {
      attributes: Object.entries(options).map(([code, values]) => ({ attributeId: attr[code].id, values })),
      price,
      cost,
    });
    const full = await get(`/products/${product.id}`);
    for (const v of full.variants) {
      await post(`/products/${product.id}/variants/${v.id}/barcodes`, { barcode: ean13() }).catch(() => {});
      variants.push({ id: v.id, sku: v.sku, price, cost, categoryCode: catCode, productId: product.id, name: `${name} ${v.name?.en ?? ''}`.trim(), tax: 'std' });
    }
  }

  for (const [sku, name, price, cost, contents] of COMPOSITE) {
    const product = await post('/products', {
      sku,
      name: { en: name },
      description: { en: `Bundle: ${contents}.` },
      productType: 'composite',
      categoryId: cat.GIFT.id,
      taxCategoryId: taxCat.std.id,
      brand: 'Top Service',
      metadata: { contents },
    });
    const v = await post(`/products/${product.id}/variants`, { sku: `${sku}-STD`, name: { en: 'Standard' }, price, cost, barcode: ean13() });
    const variant = v.variants ? v.variants.find((x) => x.sku === `${sku}-STD`) : v;
    variants.push({ id: variant.id, sku: `${sku}-STD`, price, cost, categoryCode: 'GIFT', productId: product.id, name, tax: 'std' });
  }

  for (const v of variants.filter((x) => inactiveSkus.has(x.sku))) {
    await patch(`/products/${v.productId}`, { status: 'inactive' }).catch(() => {});
  }
  const products = SIMPLE.length + VARIABLE.length + COMPOSITE.length;
  log(`${products} products (${SIMPLE.length} simple, ${VARIABLE.length} with variants, ${COMPOSITE.length} bundles), ${variants.length} sellable variants`);
  const bySku = Object.fromEntries(variants.map((v) => [v.sku, v]));

  // ===== Pricing =====
  step('Price lists and discounts');
  const wholesale = await post('/price-lists', { code: 'WHOLESALE', name: { en: 'Wholesale' }, priceListType: 'wholesale', currencyCode: currency, priority: 10 });
  await put(`/price-lists/${wholesale.id}/entries`, {
    entries: variants
      .filter((v) => ['BEV', 'SNACK', 'PANTRY', 'DAIRY'].includes(v.categoryCode))
      .map((v) => ({ variantId: v.id, price: round2(v.price * 0.85), minQuantity: 6 })),
  });
  const promo = await post('/price-lists', {
    code: 'SUMMER',
    name: { en: 'Summer promotion' },
    priceListType: 'promotional',
    currencyCode: currency,
    priority: 20,
    validFrom: new Date(Date.now() - 10 * DAY).toISOString(),
    validTo: new Date(Date.now() + 20 * DAY).toISOString(),
  });
  await put(`/price-lists/${promo.id}/entries`, {
    entries: ['BTY-SUN-SPF50', 'TOY-BALL-SOC', 'SHO-SAND-38-BLACK']
      .map((sku) => bySku[sku])
      .filter(Boolean)
      .map((v) => ({ variantId: v.id, price: round2(v.price * 0.8), compareAtPrice: v.price })),
  });
  const discounts = [
    { code: 'WELCOME10', name: { en: 'Welcome 10% off' }, discountType: 'percentage', scope: 'cart', percentage: 10, minPurchaseAmount: 20 },
    { code: 'SAVE5', name: { en: '5 off orders over 50' }, discountType: 'fixed_amount', scope: 'cart', value: 5, minPurchaseAmount: 50 },
    { code: 'DRINKS15', name: { en: '15% off beverages' }, discountType: 'percentage', scope: 'category', percentage: 15, applicableCategoryIds: [cat.BEV.id] },
    { code: 'AUDIO20', name: { en: 'Audio week: 20% off' }, discountType: 'percentage', scope: 'category', percentage: 20, applicableCategoryIds: [cat.AUDIO.id], maxDiscountAmount: 30, validTo: new Date(Date.now() + 7 * DAY).toISOString() },
    { code: 'EXPIRED5', name: { en: 'Old spring promo' }, discountType: 'percentage', scope: 'cart', percentage: 5, validFrom: new Date(Date.now() - 90 * DAY).toISOString(), validTo: new Date(Date.now() - 30 * DAY).toISOString() },
  ];
  for (const d of discounts) await post('/discounts', d);
  log(`2 price lists, ${discounts.length} discount codes`);

  // ===== Customers =====
  step('Customer groups and customers');
  const groups = {
    retail: await post('/customer-groups', { code: 'RETAIL', name: 'Retail' }),
    vip: await post('/customer-groups', { code: 'VIP', name: 'VIP', description: 'Top customers', discountPercent: 5 }),
    wholesale: await post('/customer-groups', { code: 'WHOLESALE', name: 'Wholesale', description: 'Restaurants and resellers', priceListId: wholesale.id }),
  };
  await post('/customer-fields', { key: 'preferred_contact', label: 'Preferred contact', fieldType: 'select', options: ['Phone', 'Email', 'WhatsApp'] }).catch(() => {});
  await post('/customer-fields', { key: 'birthday_club', label: 'Birthday club', fieldType: 'boolean' }).catch(() => {});

  const customers = [];
  for (let i = 0; i < 32; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    const group = i < 5 ? groups.vip : i < 8 ? groups.wholesale : groups.retail;
    const business = group === groups.wholesale;
    const c = await post('/customers', {
      customerType: business ? 'business' : 'individual',
      firstName: business ? null : first,
      lastName: business ? null : last,
      companyName: business ? BUSINESSES[i % BUSINESSES.length] : null,
      email: chance(0.8) ? `${(business ? BUSINESSES[i % BUSINESSES.length] : `${first}.${last}`).toLowerCase().replace(/[^a-z.]/g, '')}${i}@example.com` : null,
      phone: `+509 3${int(1, 9)}${int(10, 99)} ${int(1000, 9999)}`,
      groupId: group.id,
      dateOfBirth: business ? null : `19${int(60, 99)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`,
      creditLimit: business ? 2000 : 0,
      marketingEmailConsent: chance(0.5),
      marketingSmsConsent: chance(0.3),
      consentSource: 'in_store',
      customFields: { preferred_contact: pick(['Phone', 'Email', 'WhatsApp']), birthday_club: chance(0.4) },
    });
    customers.push({ ...c, groupCode: group === groups.vip ? 'VIP' : business ? 'WHOLESALE' : 'RETAIL' });
  }
  // A likely duplicate for the duplicates screen
  await post('/customers', { firstName: customers[10].firstName, lastName: customers[10].lastName, phone: customers[10].phone, consentSource: 'in_store' });
  // Starting loyalty balances so points can be spent right away
  for (const c of customers.slice(0, 10)) {
    await post(`/loyalty/customers/${c.id}/adjust`, { points: int(800, 3000), note: 'Points carried over from the old loyalty card' }).catch((e) => log(`loyalty adjust skipped: ${e.message}`));
  }
  log(`${customers.length + 1} customers in 3 groups`);

  // ===== Suppliers & initial stock =====
  step('Suppliers, purchase orders and opening stock');
  const suppliers = [];
  const SUPPLIERS = [
    ['SUP-FOOD', 'Caribbean Foods Distribution', 'Rose Augustin', ['FOOD', 'BEV', 'SNACK', 'DAIRY', 'BAKERY', 'PANTRY']],
    ['SUP-ELEC', 'Voltix Electronics Import', 'Kevin Paul', ['ELEC', 'PHONE', 'AUDIO']],
    ['SUP-FASH', 'Urban Style Wholesale', 'Sandra Michel', ['APPAREL', 'MEN', 'WOMEN', 'SHOES']],
    ['SUP-HOME', 'Casa Home Goods', 'Wilson Noel', ['HOME', 'BEAUTY', 'GIFT']],
    ['SUP-OFFICE', 'Scribe Office & Toys', 'Judith Alexis', ['STATION', 'TOYS']],
  ];
  for (const [code, name, contact, cats] of SUPPLIERS) {
    const s = await post('/suppliers', {
      code,
      name,
      contactPerson: contact,
      email: `orders@${code.toLowerCase().replace('sup-', '')}.example.com`,
      phone: `+509 22${int(10, 99)} ${int(1000, 9999)}`,
      city: 'Port-au-Prince',
      countryCode: 'HT',
      paymentTermDays: pick([15, 30, 45]),
      currencyCode: currency,
      contacts: [{ name: contact, role: 'Sales rep', email: `${contact.split(' ')[0].toLowerCase()}@example.com` }],
    });
    suppliers.push({ ...s, cats });
  }
  const supplierFor = (v) => suppliers.find((s) => s.cats.includes(v.categoryCode)) ?? suppliers[3];

  // Opening stock: one received purchase order per supplier (owner approves when needed)
  const stockQty = (v) => (lowStockSkus.has(v.sku) ? int(2, 6) : v.price > 100 ? int(8, 15) : v.price > 30 ? int(20, 40) : int(60, 140));
  for (const supplier of suppliers) {
    const lines = variants.filter((v) => supplierFor(v) === supplier);
    if (!lines.length) continue;
    const po = await post('/purchase-orders', {
      supplierId: supplier.id,
      locationId: floor1.id,
      notes: 'Opening stock',
      items: lines.map((v) => ({ variantId: v.id, quantityOrdered: stockQty(v), unitCost: v.cost })),
    }, { as: 'stock' });
    await receiveWholePo(po.id);
  }
  // Backstore reserve for the popular groceries
  await post('/inventory/receive', {
    locationId: backLoc.id,
    reference: 'Opening count',
    items: variants.filter((v) => ['BEV', 'PANTRY', 'SNACK'].includes(v.categoryCode)).map((v) => ({ variantId: v.id, quantity: int(30, 80), cost: v.cost })),
  }, { as: 'stock' });
  // Downtown branch stock (received directly)
  const downtownRange = variants.filter((v) => ['BEV', 'SNACK', 'PHONE', 'AUDIO', 'BEAUTY', 'MEN'].includes(v.categoryCode) && !lowStockSkus.has(v.sku));
  await post('/inventory/receive', {
    locationId: floor2.id,
    reference: 'Opening stock Downtown',
    items: downtownRange.map((v) => ({ variantId: v.id, quantity: v.price > 100 ? 4 : int(15, 40), cost: v.cost })),
  }, { as: 'stock' });
  log(`${suppliers.length} suppliers, stock received in 3 locations`);

  const setupEnd = new Date();

  // ===== Sales history =====
  step(`Sales history (${HISTORY_DAYS} days)`);
  const sellable = variants.filter((v) => !inactiveSkus.has(v.sku) && !lowStockSkus.has(v.sku));
  const weights = sellable.map((v) => (['BEV', 'SNACK', 'DAIRY', 'BAKERY', 'PANTRY'].includes(v.categoryCode) ? 6 : v.price > 100 ? 0.3 : v.price > 30 ? 1 : 2));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const weightedPick = (pool = sellable, w = weights, total = totalWeight) => {
    let r = rand() * total;
    for (let i = 0; i < pool.length; i++) if ((r -= w[i]) <= 0) return pool[i];
    return pool[pool.length - 1];
  };
  const downtownSellable = downtownRange.filter((v) => !inactiveSkus.has(v.sku));
  const loyaltyBalance = new Map(); // customerId -> points (approximate, to pay with points)

  const plans = [];
  for (let d = HISTORY_DAYS; d >= 1; d--) {
    const date = new Date(Date.now() - d * DAY);
    const weekend = [0, 6].includes(date.getDay());
    const trend = 1 + (HISTORY_DAYS - d) / HISTORY_DAYS / 2; // business is growing
    const count = Math.round(int(4, 8) * (weekend ? 1.5 : 1) * trend);
    for (let i = 0; i < count; i++) {
      const at = new Date(date);
      at.setHours(int(8, 19), int(0, 59), int(0, 59), 0);
      plans.push({ at, downtown: chance(0.25) });
    }
  }

  const buildSale = (plan) => {
    const downtown = plan.downtown;
    const pool = downtown ? downtownSellable : sellable;
    const lines = new Map();
    const lineCount = chance(0.3) ? 1 : int(2, 5);
    for (let i = 0; i < lineCount; i++) {
      const v = downtown ? pick(pool) : weightedPick();
      const qty = v.price > 30 ? 1 : int(1, 3);
      lines.set(v.id, { variantId: v.id, quantity: (lines.get(v.id)?.quantity ?? 0) + qty });
    }
    const items = [...lines.values()];
    if (chance(0.08)) items[0].discountPercent = pick([5, 10]);
    const customer = chance(0.55) ? pick(customers) : null;
    const seller = pick(['lina', 'jean', 'lina', 'jean', 'manager']);
    const register = downtown ? register3 : chance(0.7) ? register1 : register2;
    return { items, customer, seller, register, discountCode: chance(0.06) ? pick(['WELCOME10', 'DRINKS15', 'SAVE5']) : undefined };
  };

  let failures = 0;
  const completeSale = async (plan, draft, { extraPayments } = {}) => {
    const body = {
      registerId: draft.register.id,
      customerId: draft.customer?.id,
      discountCode: draft.discountCode,
      items: draft.items,
      priceListId: draft.priceListId,
      estimateId: draft.estimateId,
    };
    let quote;
    try {
      quote = await post('/sales/quote', body, { as: draft.seller });
    } catch {
      delete body.discountCode;
      quote = await post('/sales/quote', body, { as: draft.seller });
    }
    const total = Number(quote.total ?? quote.totals?.total);
    const tender = extraPayments ? { payments: extraPayments(total) } : choosePayments(total, draft.customer);
    const sale = await post(
      '/sales',
      { ...body, payments: tender.payments, changeCurrency: tender.changeCurrency, idempotencyKey: randomUUID(), notes: draft.notes },
      { as: draft.seller },
    );
    if (draft.customer) {
      const earned = Math.floor((total * 2) / 100 / 0.01);
      loyaltyBalance.set(draft.customer.id, (loyaltyBalance.get(draft.customer.id) ?? 0) + earned);
    }
    return sale;
  };

  // Returns { payments, changeCurrency? }. About a third of cash sales are paid in gourdes.
  const choosePayments = (total, customer) => {
    const r = rand();
    const points = customer ? (loyaltyBalance.get(customer.id) ?? 0) : 0;
    if (customer && method.LOYALTY && points >= 300 && r < 0.12) {
      const usePoints = Math.min(points, Math.floor(total * 0.5 * 100));
      if (usePoints >= 100) {
        const pointsAmount = round2(usePoints / 100);
        loyaltyBalance.set(customer.id, points - usePoints);
        return {
          payments: [
            { paymentMethodId: method.LOYALTY, amount: pointsAmount },
            { paymentMethodId: method.CASH, amount: round2(total - pointsAmount) },
          ],
        };
      }
    }
    if (r < 0.35) {
      const tendered = total < 5 ? 5 : total < 10 ? 10 : total < 20 ? 20 : Math.ceil(total / 50) * 50;
      return { payments: [{ paymentMethodId: method.CASH, amount: chance(0.5) ? round2(total) : tendered }] };
    }
    if (r < 0.55) {
      // Gourdes: exact, or rounded up to the next 250 HTG note with change in HTG
      const due = Math.ceil(total * HTG_RATE * 100) / 100;
      const tendered = chance(0.4) ? due : Math.ceil(due / 250) * 250;
      return {
        payments: [{ paymentMethodId: method.CASH, amount: round2(tendered / HTG_RATE), currencyCode: 'HTG', tenderedAmount: tendered }],
        changeCurrency: tendered > due ? 'HTG' : undefined,
      };
    }
    if (r < 0.82) return { payments: [{ paymentMethodId: method.CARD, amount: round2(total), reference: `AUTH${int(100000, 999999)}` }] };
    if (r < 0.93) {
      // MonCash is charged in gourdes
      const due = Math.ceil(total * HTG_RATE * 100) / 100;
      return {
        payments: [{ paymentMethodId: method.MONCASH, amount: round2(total), currencyCode: 'HTG', tenderedAmount: due, reference: `MC${int(10000000, 99999999)}` }],
      };
    }
    const cash = round2(Math.floor(total / 2));
    return {
      payments: [
        { paymentMethodId: method.CASH, amount: cash },
        { paymentMethodId: method.CARD, amount: round2(total - cash), reference: `AUTH${int(100000, 999999)}` },
      ],
    };
  };

  // Seeded sequentially per day order (loyalty balances depend on order), in small batches
  let done = 0;
  const drafts = plans.map((plan) => ({ plan, draft: buildSale(plan) }));
  // Wholesale customers occasionally buy in bulk at the wholesale price list
  for (const { draft } of drafts) {
    if (draft.customer?.groupCode === 'WHOLESALE' && chance(0.6)) {
      const bulk = pick(variants.filter((v) => ['BEV', 'PANTRY'].includes(v.categoryCode)));
      draft.items = [{ variantId: bulk.id, quantity: 12 }];
      draft.priceListId = wholesale.id;
      draft.register = register1;
    }
  }
  await pool(drafts, 3, async ({ plan, draft }) => {
    try {
      const sale = await completeSale(plan, draft);
      created.sales.push({ id: sale.id, at: plan.at, sale });
    } catch (e) {
      failures++;
      if (failures <= 10) log(`sale skipped: ${e.message}`);
    }
    if (++done % 50 === 0) log(`${done}/${drafts.length} sales`);
  });
  log(`${created.sales.length} historical sales (${failures} skipped)`);

  // ===== Today: shifts, live sales, held carts =====
  step('Shifts and today\'s activity');
  await patch('/settings', { requireOpenShift: originalRequireShift ?? true });
  // Morning shift on Register 2, already closed
  const morning = await post('/shifts/open', { registerId: register2.id, openingFloat: 100, notes: 'Morning shift' }, { as: 'jean' });
  for (let i = 0; i < 6; i++) {
    const draft = { ...buildSale({ downtown: false }), register: register2, seller: 'jean' };
    await completeSale({}, draft).catch((e) => log(`sale skipped: ${e.message}`));
  }
  await post(`/shifts/${morning.id}/movements`, { type: 'paid_out', amount: 15, reason: 'Bought cleaning supplies' }, { as: 'jean' }).catch(() => {});
  await post(`/shifts/${morning.id}/movements`, { type: 'safe_drop', amount: 150, reason: 'Midday safe drop' }, { as: 'jean' }).catch(() => {});
  try {
    await post(`/shifts/${morning.id}/start-close`, {}, { as: 'jean' });
    const detail = await get(`/shifts/${morning.id}`, { as: 'manager' });
    const expected = Number(detail.cash?.expected ?? 0);
    await post(`/shifts/${morning.id}/close`, {
      countedCash: round2(Math.max(0, expected - 2.5)),
      foreignCounts: (detail.cash?.foreign ?? []).map((f) => ({ currencyCode: f.currencyCode, countedCash: f.expected })),
      varianceReason: 'Short 2.50, probably wrong change given',
      idempotencyKey: randomUUID(),
    }, { as: 'jean' });
  } catch (e) {
    log(`closing the morning shift skipped: ${e.message}`);
  }
  // Open shifts: Register 1 (Lina) and Downtown (manager)
  await post('/shifts/open', { registerId: register1.id, openingFloat: 150, notes: 'Afternoon shift' }, { as: 'lina' });
  await post('/shifts/open', { registerId: register3.id, openingFloat: 100 }, { as: 'manager' });
  for (let i = 0; i < 8; i++) {
    const draft = { ...buildSale({ downtown: false }), register: register1, seller: 'lina' };
    await completeSale({}, draft).catch((e) => log(`sale skipped: ${e.message}`));
  }
  for (let i = 0; i < 4; i++) {
    const draft = { ...buildSale({ downtown: true }), register: register3, seller: 'manager' };
    await completeSale({}, draft).catch((e) => log(`sale skipped: ${e.message}`));
  }
  // Parked carts at the till
  for (const [i, label] of ['Customer went to get wallet', 'Waiting for price check'].entries()) {
    const draft = buildSale({ downtown: false });
    await post('/sales/hold', { registerId: register1.id, customerId: i === 0 ? customers[3].id : undefined, items: draft.items, label }, { as: 'lina' })
      .catch((e) => log(`held cart skipped: ${e.message}`));
  }
  log('1 closed shift, 2 open shifts, today\'s sales, 2 held carts');

  // ===== Voids and returns on historical sales (created now, dated after the sale) =====
  step('Voids and returns');
  const history = [...created.sales].sort((a, b) => a.at - b.at);
  const recent = history.filter((s) => s.at > Date.now() - 25 * DAY);
  for (const s of recent.filter((_, i) => i % 97 === 5).slice(0, 3)) {
    await post(`/sales/${s.id}/void`, { reason: pick(['Rung up twice', 'Customer changed their mind at the till', 'Wrong items scanned']) }, { as: 'manager' })
      .then(() => (s.voided = true))
      .catch((e) => log(`void skipped: ${e.message}`));
  }
  const returnable = recent.filter((s) => !s.voided && s.sale.items?.length);
  for (const [i, s] of returnable.filter((_, i) => i % 41 === 7).slice(0, 7).entries()) {
    const full = await get(`/sales/${s.id}`);
    const item = full.items[0];
    const partial = full.items.length > 1 && i % 2 === 0;
    try {
      const ret = await post('/returns', {
        saleId: s.id,
        // Refunded at a till with an open shift (cash refunds come out of its drawer)
        registerId: full.registerId === register3.id ? register3.id : register1.id,
        reason: pick(['Defective item', 'Wrong size', 'Customer not satisfied', 'Damaged packaging', 'Changed mind']),
        items: (partial ? [item] : full.items).map((it, j) => ({
          saleItemId: it.id,
          quantity: j === 0 && partial ? 1 : it.quantity,
          disposition: i % 3 === 0 ? 'dispose' : 'restock',
        })),
        idempotencyKey: randomUUID(),
      }, { as: 'manager' });
      created.returns.push({ id: ret.id, at: new Date(s.at.getTime() + int(1, 4) * DAY) });
    } catch (e) {
      log(`return skipped: ${e.message}`);
    }
  }
  log(`${history.filter((s) => s.voided).length} voided sales, ${created.returns.length} returns`);


  // ===== Estimates =====
  step('Estimates');
  const quote = (lines) => lines.map(([sku, quantity, extra = {}]) => ({ variantId: bySku[sku].id, quantity, ...extra }));
  const estimates = [];
  const ESTIMATES = [
    { customer: customers[5], items: quote([['PAN-RICE-5KG', 20], ['PAN-OIL-1L', 24], ['PAN-BEAN-1KG', 30]]), notes: 'Monthly restaurant supply', terms: 'Delivery within 3 days. Payment on delivery.', action: 'accept' },
    { customer: customers[1], items: quote([['ELC-PHN-A15', 3, { discountPercent: 5 }], ['ELC-CASE-A15-BLACK', 3], ['ELC-CHG-20W', 3]]), notes: 'Phones for the office team', action: 'send' },
    { customerName: 'Hotel Karibe (prospect)', items: quote([['HOM-TWL-BTH', 50, { discountPercent: 10 }], ['BTY-SOAP-3', 100, { discountPercent: 10 }]]), terms: '50% deposit on acceptance.', action: 'send' },
    { customer: customers[12], items: quote([['TOY-PUZ-1000', 2], ['TOY-BALL-SOC', 1]]), action: null },
    { customer: customers[7], items: quote([['BEV-WAT-15L', 48], ['BEV-COLA-355', 72]]), cartDiscount: { type: 'percentage', value: 5 }, action: 'decline' },
    { customer: customers[2], items: quote([['ELC-HP-OVR', 1], ['ELC-EAR-BT', 1]]), action: 'accept', sell: true },
    { customer: customers[20], items: quote([['HOM-PAN-28', 2], ['HOM-KNF-SET', 1], ['HOM-MUG-CER', 6]]), validUntil: new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10), action: 'send' },
    { customer: customers[0], items: quote([['APP-TEE-BASIC-M-BLACK', 10], ['APP-HOOD-ZIP-M-GREY', 5]]), notes: 'Staff uniforms', action: null },
  ];
  for (const e of ESTIMATES) {
    const items = e.items.filter((i) => i.variantId);
    if (!items.length) continue;
    try {
      const est = await post('/estimates', {
        customerId: e.customer?.id,
        customerName: e.customerName,
        items,
        notes: e.notes,
        terms: e.terms,
        cartDiscount: e.cartDiscount,
        validUntil: e.validUntil,
      }, { as: 'manager' });
      if (e.action === 'accept') await post(`/estimates/${est.id}/send`, {}, { as: 'manager' });
      if (e.action) await post(`/estimates/${est.id}/${e.action}`, {}, { as: 'manager' }).catch(() => {});
      estimates.push(est);
      if (e.sell) {
        await completeSale({}, {
          register: register1,
          seller: 'lina',
          customer: e.customer,
          estimateId: est.id,
          items: est.items.map((i) => ({ variantId: i.variantId, quantity: i.quantity, unitPrice: Number(i.unitPrice), discountPercent: Number(i.discountPercent) || undefined })),
        }).catch((err) => log(`estimate sale skipped: ${err.message}`));
      }
    } catch (err) {
      log(`estimate skipped: ${err.message}`);
    }
  }
  log(`${estimates.length} estimates (draft, sent, accepted, declined, expired, sold)`);

  // ===== Purchasing in progress =====
  step('Purchase orders in progress');
  const reorder = (supplier, n) =>
    variants.filter((v) => supplierFor(v) === supplier).slice(0, n).map((v) => ({ variantId: v.id, quantityOrdered: int(10, 30), unitCost: v.cost }));
  const inFuture = (days) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
  // Draft
  await post('/purchase-orders', { supplierId: suppliers[4].id, locationId: floor1.id, expectedDeliveryDate: inFuture(10), notes: 'Back-to-school restock', items: reorder(suppliers[4], 5) }, { as: 'stock' });
  // Pending approval (above the threshold)
  const big = await post('/purchase-orders', {
    supplierId: suppliers[1].id,
    locationId: floor1.id,
    expectedDeliveryDate: inFuture(14),
    shippingCost: 45,
    notes: 'Phones restock',
    items: [{ variantId: bySku['ELC-PHN-A15'].id, quantityOrdered: 12, unitCost: 160 }, { variantId: bySku['ELC-EAR-BT'].id, quantityOrdered: 20, unitCost: 21 }],
  }, { as: 'stock' });
  await post(`/purchase-orders/${big.id}/submit`, {}, { as: 'stock' }).catch((e) => log(e.message));
  // Issued, waiting for delivery
  const issued = await post('/purchase-orders', { supplierId: suppliers[2].id, locationId: floor1.id, expectedDeliveryDate: inFuture(5), items: reorder(suppliers[2], 6) }, { as: 'stock' });
  await approveAndIssue(issued.id);
  // Partially received
  const partial = await post('/purchase-orders', { supplierId: suppliers[0].id, locationId: floor1.id, expectedDeliveryDate: inFuture(1), items: reorder(suppliers[0], 6) }, { as: 'stock' });
  await approveAndIssue(partial.id);
  {
    const po = await get(`/purchase-orders/${partial.id}`);
    await post(`/purchase-orders/${partial.id}/receipts`, {
      idempotencyKey: randomUUID(),
      reference: `DN-${int(1000, 9999)}`,
      notes: 'First delivery; rest on back order',
      items: po.items.slice(0, 3).map((it) => ({ purchaseOrderItemId: it.id, quantity: it.quantityOrdered })),
    }, { as: 'stock' }).catch((e) => log(e.message));
  }
  // Cancelled
  const cancelled = await post('/purchase-orders', { supplierId: suppliers[3].id, locationId: floor1.id, items: reorder(suppliers[3], 3) }, { as: 'stock' });
  await post(`/purchase-orders/${cancelled.id}/cancel`, { reason: 'Supplier out of stock' }, { as: 'owner' }).catch((e) => log(e.message));
  log('draft, pending approval, issued, partially received and cancelled orders');

  // ===== Inventory operations =====
  step('Transfers, adjustments and stock counts');
  const groceries = variants.filter((v) => ['BEV', 'SNACK'].includes(v.categoryCode));
  const t1 = await post('/inventory/transfers', { fromLocationId: backLoc.id, toLocationId: floor1.id, notes: 'Weekly shelf refill', items: groceries.slice(0, 6).map((v) => ({ variantId: v.id, quantity: 12 })) }, { as: 'stock' });
  await post(`/inventory/transfers/${t1.id}/dispatch`, {}, { as: 'stock' }).then(() => post(`/inventory/transfers/${t1.id}/receive`, {}, { as: 'stock' })).catch((e) => log(e.message));
  const t2 = await post('/inventory/transfers', { fromLocationId: floor1.id, toLocationId: floor2.id, notes: 'Stock for Downtown', items: groceries.slice(6, 10).map((v) => ({ variantId: v.id, quantity: 6 })) }, { as: 'stock' });
  await post(`/inventory/transfers/${t2.id}/dispatch`, {}, { as: 'stock' }).catch((e) => log(e.message));
  await post('/inventory/transfers', { fromLocationId: backLoc.id, toLocationId: floor2.id, notes: 'Planned', items: groceries.slice(10, 12).map((v) => ({ variantId: v.id, quantity: 10 })) }, { as: 'stock' });

  await post('/inventory/adjustments', { locationId: floor1.id, reason: 'damage', mode: 'delta', notes: 'Dropped during shelving', items: [{ variantId: bySku['HOM-MUG-CER'].id, quantity: -2 }] }, { as: 'stock' }).catch((e) => log(e.message));
  await post('/inventory/adjustments', { locationId: floor1.id, reason: 'expiry', mode: 'delta', notes: 'Past best-before date', items: [{ variantId: bySku['DRY-YOG-500'].id, quantity: -4 }, { variantId: bySku['BAK-CROIS-4'].id, quantity: -3 }] }, { as: 'stock' }).catch((e) => log(e.message));
  await post('/inventory/adjustments', { locationId: floor1.id, reason: 'theft', mode: 'delta', notes: 'Missing after inventory walk', items: [{ variantId: bySku['ELC-CBL-1M'].id, quantity: -1 }] }, { as: 'stock' }).catch((e) => log(e.message));

  try {
    const count = await post('/inventory/counts', { locationId: floor1.id, categoryId: cat.BEAUTY.id, notes: 'Monthly beauty aisle count' }, { as: 'stock' });
    const full = await get(`/inventory/counts/${count.id}`);
    await put(`/inventory/counts/${count.id}/items`, {
      items: full.items.map((it, i) => ({ variantId: it.variantId, countedQuantity: Math.max(0, Number(it.expectedQuantity ?? it.systemQuantity ?? 0) - (i === 1 ? 2 : 0)) })),
    }, { as: 'stock' });
    await post(`/inventory/counts/${count.id}/submit`, {}, { as: 'stock' });
    await post(`/inventory/counts/${count.id}/approve`, {}, { as: 'manager' }).catch((e) => log(`count left pending approval: ${e.message}`));
    await post('/inventory/counts', { locationId: floor1.id, categoryId: cat.STATION.id, blind: true, notes: 'Stationery count in progress' }, { as: 'stock' });
  } catch (e) {
    log(`stock count skipped: ${e.message}`);
  }
  log('3 transfers, 3 adjustments, 2 stock counts');

  // ===== Expenses =====
  step('Expenses');
  const expCats = {};
  for (const [code, name] of [['RENT', 'Rent'], ['UTIL', 'Electricity & water'], ['SUPPLIES', 'Store supplies'], ['WAGES', 'Casual wages'], ['MKTG', 'Marketing'], ['MAINT', 'Repairs & maintenance'], ['TRANSPORT', 'Transport & fuel']]) {
    expCats[code] = await post('/expense-categories', { code, name });
  }
  const dateAgo = (d) => new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
  const EXPENSES = [
    ['RENT', 1800, 'Store rent — last month', 'Immobilier Capois', 'bank', 55, 'paid'],
    ['RENT', 1800, 'Store rent — this month', 'Immobilier Capois', 'bank', 25, 'paid'],
    ['UTIL', 312.4, 'Electricity bill (EDH)', 'EDH', 'bank', 40, 'paid'],
    ['UTIL', 287.9, 'Electricity bill (EDH)', 'EDH', 'bank', 10, 'approved'],
    ['UTIL', 64.5, 'Water delivery', 'Aqua Pure', 'cash', 20, 'paid'],
    ['SUPPLIES', 48.75, 'Receipt paper rolls (20)', 'Scribe Office', 'card', 33, 'paid'],
    ['SUPPLIES', 22.3, 'Cleaning products', 'Casa Home Goods', 'cash', 12, 'paid'],
    ['WAGES', 250, 'Weekend helper — inventory', 'Frantz L.', 'cash', 18, 'paid'],
    ['MKTG', 150, 'Flyers for the summer promotion', 'PrintExpress', 'card', 15, 'approved'],
    ['MKTG', 90, 'Facebook ads', 'Meta', 'card', 3, 'submitted'],
    ['MAINT', 420, 'Air conditioning repair', 'FroidTech', 'bank', 8, 'submitted'],
    ['MAINT', 35, 'Replace door lock', 'Quincaillerie Centrale', 'cash', 5, 'rejected'],
    ['TRANSPORT', 60, 'Generator diesel', 'Total Station', 'cash', 2, 'draft'],
    ['TRANSPORT', 25, 'Delivery moto — hotel order', 'Moto express', 'cash', 1, 'draft'],
  ];
  for (const [catCode, amount, description, payee, paymentMethod, daysAgo, status] of EXPENSES) {
    try {
      const exp = await post('/expenses', {
        expenseDate: dateAgo(daysAgo),
        categoryId: expCats[catCode].id,
        amount,
        description,
        payee,
        paymentMethod: paymentMethod === 'cash' && status === 'paid' ? 'other' : paymentMethod,
        receiptReference: `INV-${int(1000, 9999)}`,
        submit: status !== 'draft',
      }, { as: 'accounts' });
      if (status === 'rejected') await post(`/expenses/${exp.id}/reject`, { reason: 'Not approved: landlord pays for repairs' }, { as: 'owner' });
      if (['approved', 'paid'].includes(status)) await post(`/expenses/${exp.id}/approve`, {}, { as: 'owner' });
      if (status === 'paid') await post(`/expenses/${exp.id}/pay`, { reference: `PAY-${int(1000, 9999)}` }, { as: 'owner' });
    } catch (e) {
      log(`expense skipped: ${e.message}`);
    }
  }
  // Paid in cash from the open till
  await post('/expenses', { categoryId: expCats.SUPPLIES.id, amount: 12.5, description: 'Plastic bags', payee: 'Marché Salomon', paymentMethod: 'cash', registerId: register1.id, submit: true }, { as: 'lina' })
    .catch((e) => log(`till expense skipped: ${e.message}`));
  log(`${Object.keys(expCats).length} categories, ${EXPENSES.length + 1} expenses in every status`);

  // ===== Move history back in time =====
  step('Dating the history');
  await reconnect();
  await backdate(tenantId, setupStart, setupEnd);
  log('done');

  printSummary();
}

// ---------- helpers using the API ----------
async function approveAndIssue(poId) {
  await post(`/purchase-orders/${poId}/submit`, {}, { as: 'stock' });
  let po = await get(`/purchase-orders/${poId}`);
  if (po.status === 'pending_approval') {
    await post(`/purchase-orders/${poId}/approve`, {}, { as: 'owner' });
    po = await get(`/purchase-orders/${poId}`);
  }
  if (po.status === 'approved') await post(`/purchase-orders/${poId}/issue`, {}, { as: 'stock' });
}

async function receiveWholePo(poId) {
  await approveAndIssue(poId);
  const po = await get(`/purchase-orders/${poId}`);
  await post(`/purchase-orders/${poId}/receipts`, {
    idempotencyKey: randomUUID(),
    reference: `DN-${int(1000, 9999)}`,
    items: po.items.map((it) => ({ purchaseOrderItemId: it.id, quantity: it.quantityOrdered })),
  }, { as: 'stock' });
}

// ---------- database: backdating and reset ----------
async function tenantTables() {
  return (
    await db.query(
      `SELECT c.table_name, array_agg(t.column_name::text) FILTER (WHERE t.column_name IS NOT NULL) AS stamps
       FROM information_schema.columns c
       LEFT JOIN information_schema.columns t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.data_type LIKE 'timestamp%'
       WHERE c.table_schema = 'public' AND c.column_name = 'tenantId'
         AND c.table_name NOT IN ('tenants', 'audit_logs')
       GROUP BY c.table_name`,
    )
  ).rows;
}

async function backdate(tenantId, setupStart, setupEnd) {
  const setupShift = `${HISTORY_DAYS + 30} days`;
  await db.query('BEGIN');
  try {
    // 1. The store existed before the history starts: move set-up rows (catalog, customers,
    //    opening stock...) back
    for (const { table_name: table, stamps } of await tenantTables()) {
      // Append-only history (a trigger rejects updates): keeps its real timestamps
      if (table === 'customer_consent_events') continue;
      if (!stamps?.includes('created_at')) continue;
      const sets = stamps.map((c) => `"${c}" = "${c}" - interval '${setupShift}'`).join(', ');
      await db.query(
        `UPDATE "${table}" SET ${sets} WHERE "tenantId" = $1 AND created_at >= $2 AND created_at <= $3`,
        [tenantId, setupStart, setupEnd],
      );
    }

    // 2. Each historical sale to its planned time, with everything it wrote
    const moves = [
      ...created.sales.map((s) => ({ id: s.id, at: s.at, kind: 'sale' })),
      ...created.returns.map((r) => ({ id: r.id, at: r.at, kind: 'return' })),
    ];
    const ids = moves.map((m) => m.id);
    const ats = moves.map((m) => m.at.toISOString());
    const kinds = moves.map((m) => m.kind);
    await db.query(`CREATE TEMP TABLE seed_dates (id uuid, at timestamptz, kind text) ON COMMIT DROP`);
    await db.query(`INSERT INTO seed_dates SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[])`, [ids, ats, kinds]);

    const q = (sql) => db.query(sql, [tenantId]);
    await q(`UPDATE sales s SET "saleDate" = d.at, created_at = d.at, updated_at = d.at
             FROM seed_dates d WHERE d.kind = 'sale' AND s.id = d.id AND s."tenantId" = $1`);
    await q(`UPDATE sale_items i SET created_at = d.at, updated_at = d.at
             FROM seed_dates d WHERE d.kind = 'sale' AND i."saleId" = d.id AND i."tenantId" = $1`);
    await q(`UPDATE payments p SET "paymentDate" = d.at, created_at = d.at, updated_at = d.at,
               "capturedAt" = CASE WHEN p."capturedAt" IS NULL THEN NULL ELSE d.at END,
               "authorizedAt" = CASE WHEN p."authorizedAt" IS NULL THEN NULL ELSE d.at END
             FROM seed_dates d WHERE d.kind = 'sale' AND p."saleId" = d.id AND p."tenantId" = $1`);
    await q(`UPDATE sale_returns r SET created_at = d.at, updated_at = d.at
             FROM seed_dates d WHERE d.kind = 'return' AND r.id = d.id AND r."tenantId" = $1`);
    await q(`UPDATE sale_return_items i SET created_at = d.at, updated_at = d.at
             FROM seed_dates d WHERE d.kind = 'return' AND i."returnId" = d.id AND i."tenantId" = $1`).catch(() => {});
    await q(`UPDATE stock_movements m SET "movementDate" = d.at, created_at = d.at, updated_at = d.at
             FROM seed_dates d WHERE m."referenceId" = d.id AND m."tenantId" = $1`);
    await q(`UPDATE loyalty_transactions l SET created_at = d.at
             FROM seed_dates d WHERE (l."saleId" = d.id AND d.kind = 'sale' AND l."returnId" IS NULL AND l.type IN ('earn','redeem'))
               AND l."tenantId" = $1`);
    await q(`UPDATE loyalty_transactions l SET created_at = d.at
             FROM seed_dates d WHERE l."returnId" = d.id AND d.kind = 'return' AND l."tenantId" = $1`);
    // Voids happened the day of the sale
    await q(`UPDATE loyalty_transactions l SET created_at = d.at + interval '2 hours'
             FROM seed_dates d WHERE l."saleId" = d.id AND l.type = 'reversal' AND l."returnId" IS NULL AND l."tenantId" = $1`);

    await q(`UPDATE customers c SET "lastPurchaseAt" = x.last
             FROM (SELECT "customerId", max("saleDate") AS last FROM sales
                   WHERE "tenantId" = $1 AND "customerId" IS NOT NULL GROUP BY 1) x
             WHERE c.id = x."customerId" AND c."tenantId" = $1`);
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  }
}

/** Remove the store's data (keeps the store, its owner and the built-in roles) */
async function wipe(tenantId, ownerId) {
  step('Wiping existing store data (--reset)');
  const staffIds = (
    await db.query(`SELECT "userId" FROM tenant_memberships WHERE "tenantId" = $1 AND "userId" <> $2`, [tenantId, ownerId])
  ).rows.map((r) => r.userId);
  const keep = new Set(['tenant_memberships', 'tenant_roles']);
  const tables = (await tenantTables()).map((t) => t.table_name).filter((t) => !keep.has(t));

  // The audit log and the stock, customer-credit and stored-value ledgers are
  // append-only: their triggers allow DELETE only under this purge flag, set for
  // this one connection and cleared once the store is emptied
  await db.query(`SELECT set_config('app.audit_purge', 'on', false)`);
  try {
    await wipeTables(tenantId, ownerId, tables, staffIds);
  } finally {
    await db.query(`SELECT set_config('app.audit_purge', '', false)`);
  }
  log('store emptied');
}

async function wipeTables(tenantId, ownerId, tables, staffIds) {
  await db.query(`DELETE FROM audit_logs WHERE "tenantId" = $1`, [tenantId]);
  await db.query(`UPDATE categories SET "parentId" = NULL WHERE "tenantId" = $1`, [tenantId]);
  await db.query(`DELETE FROM tenant_memberships WHERE "tenantId" = $1 AND "userId" <> $2`, [tenantId, ownerId]);
  let remaining = tables;
  for (let pass = 0; pass < 15 && remaining.length; pass++) {
    const blocked = [];
    for (const table of remaining) {
      try {
        await db.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [tenantId]);
      } catch {
        blocked.push(table);
      }
    }
    remaining = blocked;
  }
  if (remaining.length) throw new Error(`Could not empty: ${remaining.join(', ')}`);
  await db.query(`DELETE FROM tenant_roles WHERE "tenantId" = $1 AND "isSystem" IS NOT TRUE`, [tenantId]).catch(() => {});
  await db.query(
    `DELETE FROM users WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m."userId" = users.id)`,
    [staffIds],
  ).catch(() => {});
  // Settings (stored on the tenant) back to defaults, keeping nothing seeded
  await db.query(`UPDATE tenants SET settings = '{}'::jsonb WHERE id = $1`, [tenantId]).catch(() => {});
}

function printSummary() {
  console.log(`
✅ Demo data ready

Sign in at the admin (all staff passwords: ${STAFF_PASSWORD})
  Owner            ${OWNER_EMAIL}  (your existing password)
${STAFF.map((s) => `  ${s.role.padEnd(16)} ${s.email}`).join('\n')}
`);
}

main()
  .catch((e) => {
    console.error(`\n❌ ${e.message}`);
    process.exitCode = 1;
  })
  .finally(() => db.end().catch(() => {}));
