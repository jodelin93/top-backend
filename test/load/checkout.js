/**
 * k6 load test: cashiers searching the catalog, pricing a cart and completing sales.
 *
 *   k6 run -e BASE_URL=https://staging.example.com/api/v1 \
 *          -e EMAIL=loadtest@example.com -e PASSWORD=... \
 *          -e CONFIRM=yes test/load/checkout.js
 *
 * THIS CREATES REAL SALES (and moves stock) in the target store.
 * Only run it against a staging environment with a dedicated test store —
 * never against production. See README.md in this folder.
 */
import http from 'k6/http';
import { check, fail, group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000/api/v1').replace(
  /\/$/,
  '',
);
const EMAIL = __ENV.EMAIL;
const PASSWORD = __ENV.PASSWORD;
const REGISTER_ID = __ENV.REGISTER_ID; // defaults to the store's first register
const SEARCH_TERMS = (__ENV.SEARCH_TERMS || 'a,e,o,1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const THINK_TIME = Number(__ENV.THINK_TIME || 1); // seconds between cashier actions
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '2m';

const businessErrors = new Rate('business_errors');

export const options = {
  scenarios: {
    cashiers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: VUS }, // ramp up
        { duration: DURATION, target: VUS }, // steady
        { duration: '15s', target: 0 }, // ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'http_req_duration{name:catalog}': ['p(95)<500'],
    'http_req_duration{name:quote}': ['p(95)<500'],
    'http_req_duration{name:sale}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
    business_errors: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
};

const json = (token) => ({
  headers: {
    'Content-Type': 'application/json',
    // API-client mode: token in the login body, bearer auth, CSRF header check satisfied
    'X-Auth-Mode': 'token',
    ...(token && { Authorization: `Bearer ${token}` }),
  },
});

/**
 * Runs once: log in, resolve the register, cash method and a pool of sellable items
 */
export function setup() {
  if (__ENV.CONFIRM !== 'yes') {
    fail(
      'This test creates real sales. Point BASE_URL at staging and pass -e CONFIRM=yes.',
    );
  }
  if (!EMAIL || !PASSWORD) {
    fail('Set EMAIL and PASSWORD (-e EMAIL=... -e PASSWORD=...)');
  }

  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    json(),
  );
  if (login.status !== 200 || !login.json('accessToken')) {
    fail(`Login failed (${login.status}): ${login.body}`);
  }
  if (login.json('requiresMfa')) {
    fail('The load-test user must not have MFA enabled');
  }
  const token = login.json('accessToken');

  const context = http.get(`${BASE_URL}/pos/context`, json(token));
  if (context.status !== 200) {
    fail(`Could not load the POS context (${context.status}): ${context.body}`);
  }
  const registers = context.json('registers') || [];
  const registerId = REGISTER_ID || (registers[0] && registers[0].id);
  const cash = (context.json('paymentMethods') || []).find(
    (m) => m.methodType === 'cash',
  );
  if (!registerId || !cash) {
    fail('The store needs an active register and a cash payment method');
  }

  // Items that can be sold repeatedly without running out of stock
  const catalog = http.get(
    `${BASE_URL}/pos/catalog?registerId=${registerId}&limit=200`,
    json(token),
  );
  const pool = (catalog.json() || []).filter(
    (item) => item.price > 0 && (item.allowBackorder || item.stock >= 1000),
  );
  if (pool.length === 0) {
    fail(
      'No sellable items with plenty of stock (>= 1000 or backorder allowed). Seed the test store first.',
    );
  }

  return {
    token,
    registerId,
    cashId: cash.id,
    variantIds: pool.map((item) => item.variantId),
  };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function (data) {
  const params = (name) => ({ ...json(data.token), tags: { name } });

  // 1. Cashier searches the catalog
  group('catalog search', () => {
    const term = encodeURIComponent(pick(SEARCH_TERMS));
    const res = http.get(
      `${BASE_URL}/pos/catalog?registerId=${data.registerId}&search=${term}&limit=50`,
      params('catalog'),
    );
    check(res, { 'catalog 200': (r) => r.status === 200 });
  });
  sleep(THINK_TIME);

  // 2. Build a cart of 1–3 lines and price it
  const lineCount = 1 + Math.floor(Math.random() * 3);
  const items = [];
  for (let i = 0; i < lineCount; i++) {
    items.push({
      variantId: pick(data.variantIds),
      quantity: 1 + Math.floor(Math.random() * 2),
    });
  }
  const cart = { registerId: data.registerId, items };

  let total;
  group('quote', () => {
    const res = http.post(
      `${BASE_URL}/sales/quote`,
      JSON.stringify(cart),
      params('quote'),
    );
    const ok = check(res, {
      'quote 200/201': (r) => r.status === 200 || r.status === 201,
      'quote has a total': (r) => typeof r.json('total') === 'number',
    });
    businessErrors.add(!ok);
    total = ok ? res.json('total') : undefined;
  });
  if (total === undefined) return;
  sleep(THINK_TIME);

  // 3. Pay cash (rounded up to the next whole unit, so there is change)
  group('create sale', () => {
    const res = http.post(
      `${BASE_URL}/sales`,
      JSON.stringify({
        ...cart,
        payments: [{ paymentMethodId: data.cashId, amount: Math.ceil(total) }],
        // Unique per iteration so every submission is a new sale
        idempotencyKey: `k6-${__VU}-${__ITER}-${Date.now()}`,
        notes: 'k6 load test',
      }),
      params('sale'),
    );
    const ok = check(res, {
      'sale 201': (r) => r.status === 201,
      'sale total matches quote': (r) => r.json('total') === total,
    });
    businessErrors.add(!ok);
  });
  sleep(THINK_TIME);
}
