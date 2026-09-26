#!/usr/bin/env node
/**
 * Node equivalent of checkout.js (k6) for machines without k6.
 *
 *   npm run load:checkout -- --duration 60 --concurrency 10
 *   node test/load/checkout-load.mjs --duration 10 --concurrency 2 --base-url http://localhost:3000/api/v1
 *
 * Options (CLI flag or env var):
 *   --base-url     BASE_URL      API base incl. prefix   (default http://localhost:3000/api/v1)
 *   --duration     DURATION      seconds of load          (default 60)
 *   --concurrency  CONCURRENCY   concurrent cashiers      (default 10)
 *   --think-ms     THINK_MS      pause between steps, ms  (default 0 = back-to-back)
 *   --list-every   LIST_EVERY    seconds between GET /sales?limit=50 samples (default 5)
 *   --json-out     JSON_OUT      write the raw summary as JSON to this file
 *
 * What it does:
 *   1. Creates a throwaway store directly in the database of top-backend/.env (owner user +
 *      membership), signs in, POST /settings/initialize, creates 5 products and receives
 *      100,000 units of each.
 *   2. N virtual cashiers loop for DURATION: POST /sales/quote (1–3 random lines), then
 *      POST /sales paying cash rounded up to the next unit, with a unique idempotencyKey.
 *      A management list (GET /sales?limit=50) is sampled every LIST_EVERY seconds.
 *   3. Always deletes the store and its user afterwards (finally), and verifies it is gone.
 *
 * It writes real rows to the database in .env: never run it against production.
 * Authenticated requests are throttled per store (TENANT_THROTTLE_LIMIT, default 3000/60 s);
 * 429s are reported separately in the error breakdown.
 */
import {
  apiClient,
  connect,
  createTenant,
  deleteTenant,
  loadEnv,
  measureDbRtt,
  setupStore,
  summarize,
  tenantLeftovers,
} from './tenant-fixture.mjs';
import { writeFileSync } from 'node:fs';
import os from 'node:os';

const args = process.argv.slice(2);
const opt = (flag, env, fallback) => {
  const i = args.indexOf(`--${flag}`);
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${flag}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return process.env[env] ?? fallback;
};

const BASE_URL = opt('base-url', 'BASE_URL', 'http://localhost:3000/api/v1');
const DURATION_S = Number(opt('duration', 'DURATION', 60));
const CONCURRENCY = Number(opt('concurrency', 'CONCURRENCY', 10));
const THINK_MS = Number(opt('think-ms', 'THINK_MS', 0));
const LIST_EVERY_S = Number(opt('list-every', 'LIST_EVERY', 5));
const JSON_OUT = opt('json-out', 'JSON_OUT', '');

loadEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(0) : '-');

const metrics = {
  sale: [],
  quote: [],
  list: [],
  listIdle: [],
  errors: {}, // "sale 409" -> { count, sample }
  businessErrors: 0,
  salesOk: 0,
};
const recordError = (name, r) => {
  const key = `${name} ${r.status || 'network'}`;
  const e = (metrics.errors[key] ??= { count: 0, sample: '' });
  e.count++;
  if (!e.sample) e.sample = JSON.stringify(r.body ?? '').slice(0, 200);
};

/** Wait until the API answers /health (a `nest start --watch` server restarts on every edit) */
async function waitForApi(api, timeoutS = 180) {
  const until = performance.now() + timeoutS * 1000;
  while (performance.now() < until) {
    const r = await api.call('GET', '/health');
    if (r.status === 200) return;
    await sleep(2000);
  }
  throw new Error(`API at ${BASE_URL} not healthy after ${timeoutS}s`);
}

async function healthUptime(api) {
  // /health only returns { status } to anonymous callers; /health/live carries the uptime
  const r = await api.call('GET', '/health/live');
  return { status: r.status, uptimeSeconds: r.body?.uptimeSeconds, env: r.body?.environment };
}

async function cashier(id, api, store, deadline) {
  let iter = 0;
  while (performance.now() < deadline) {
    iter++;
    const lineCount = 1 + Math.floor(Math.random() * 3);
    const items = [];
    for (let i = 0; i < lineCount; i++) {
      items.push({ variantId: pick(store.variantIds), quantity: 1 + Math.floor(Math.random() * 2) });
    }
    const cart = { registerId: store.registerId, items };

    const q = await api.call('POST', '/sales/quote', cart);
    metrics.quote.push(q.ms);
    if ((q.status !== 200 && q.status !== 201) || typeof q.body?.total !== 'number') {
      recordError('quote', q);
      if (q.status === 429) await sleep(1000);
      continue;
    }
    if (THINK_MS) await sleep(THINK_MS);

    const total = q.body.total;
    const s = await api.call('POST', '/sales', {
      ...cart,
      payments: [{ paymentMethodId: store.cashId, amount: Math.ceil(total) }],
      idempotencyKey: `load-${id}-${iter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      notes: 'node load test',
    });
    metrics.sale.push(s.ms);
    if (s.status !== 201) {
      recordError('sale', s);
      if (s.status === 429) await sleep(1000);
    } else if (s.body?.total !== total) {
      metrics.businessErrors++;
    } else {
      metrics.salesOk++;
    }
    if (THINK_MS) await sleep(THINK_MS);
  }
}

async function listSampler(api, deadline) {
  while (performance.now() < deadline) {
    await sleep(LIST_EVERY_S * 1000);
    if (performance.now() >= deadline) break;
    const r = await api.call('GET', '/sales?limit=50');
    metrics.list.push(r.ms);
    if (r.status !== 200) recordError('list', r);
  }
}

async function main() {
  console.log(
    `checkout load: ${CONCURRENCY} cashiers x ${DURATION_S}s against ${BASE_URL} (think ${THINK_MS} ms)`,
  );
  const db = await connect();
  const rtt = await measureDbRtt(db, 10);
  console.log(`DB round trip (SELECT 1 x10): ${rtt.map((x) => x.toFixed(0)).join(' ')} ms`);

  const api = apiClient(BASE_URL);
  await waitForApi(api);
  const healthBefore = await healthUptime(api);
  const healthLive = [];
  for (let i = 0; i < 5; i++) healthLive.push((await api.call('GET', '/health/live')).ms);

  let fixture;
  let result;
  try {
    fixture = await createTenant(db, 'loadtest');
    console.log(`throwaway store ${fixture.slug} (${fixture.tenantId})`);
    const setupStart = performance.now();
    const store = await setupStore(api, fixture.email);
    console.log(`setup done in ${fmt(performance.now() - setupStart)} ms`);

    // Warm-up: one sale so first-request costs (JIT, caches) aren't in the numbers
    await cashier('warm', api, store, performance.now() + 1);
    Object.assign(metrics, { sale: [], quote: [], errors: {}, businessErrors: 0, salesOk: 0 });

    const start = performance.now();
    const deadline = start + DURATION_S * 1000;
    await Promise.all([
      ...Array.from({ length: CONCURRENCY }, (_, i) => cashier(i + 1, api, store, deadline)),
      listSampler(api, deadline),
    ]);
    const elapsedS = (performance.now() - start) / 1000;

    // Management list with no concurrent load
    for (let i = 0; i < 5; i++) {
      const r = await api.call('GET', '/sales?limit=50');
      metrics.listIdle.push(r.ms);
      if (r.status !== 200) recordError('list-idle', r);
    }
    const healthAfter = await healthUptime(api);

    const saleErrors = Object.entries(metrics.errors)
      .filter(([k]) => k.startsWith('sale '))
      .reduce((a, [, v]) => a + v.count, 0);
    const quoteErrors = Object.entries(metrics.errors)
      .filter(([k]) => k.startsWith('quote '))
      .reduce((a, [, v]) => a + v.count, 0);
    const requests = metrics.sale.length + metrics.quote.length + metrics.list.length;
    const allErrors = Object.entries(metrics.errors)
      .filter(([k]) => !k.startsWith('list-idle'))
      .reduce((a, [, v]) => a + v.count, 0);

    const { rows: [counts] } = await db.query(
      `SELECT count(*)::int sales, coalesce(sum(total),0)::float total FROM sales WHERE "tenantId" = $1`,
      [fixture.tenantId],
    );

    result = {
      date: new Date().toISOString(),
      baseUrl: BASE_URL,
      durationS: DURATION_S,
      elapsedS,
      concurrency: CONCURRENCY,
      thinkMs: THINK_MS,
      host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGb: os.totalmem() / 2 ** 30, node: process.version },
      dbRttMs: summarize(rtt),
      healthLiveMs: summarize(healthLive),
      healthBefore,
      healthAfter,
      serverRestartedDuringRun:
        typeof healthAfter.uptimeSeconds === 'number' &&
        healthAfter.uptimeSeconds < elapsedS + 5,
      sale: { ...summarize(metrics.sale), ok: metrics.salesOk, errors: saleErrors, throughputPerS: metrics.salesOk / elapsedS },
      quote: { ...summarize(metrics.quote), errors: quoteErrors },
      listUnderLoad: summarize(metrics.list),
      listIdle: summarize(metrics.listIdle),
      totalRequests: requests,
      requestsPerS: requests / elapsedS,
      errorRate: requests ? allErrors / requests : 0,
      saleErrorRate: metrics.sale.length ? saleErrors / metrics.sale.length : 0,
      businessErrors: metrics.businessErrors,
      errors: metrics.errors,
      salesInDb: counts,
    };
  } finally {
    if (fixture) {
      await sleep(2000); // let post-commit work (outbox, events) settle before purging
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await deleteTenant(db, fixture.tenantId, fixture.userIds);
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          await sleep(3000);
        }
      }
      const left = await tenantLeftovers(db, fixture.tenantId, fixture.userIds);
      console.log(
        `cleanup: tenant rows left=${left.tenantRows}, tenant=${left.tenant}, users=${left.users}` +
          (lastErr ? ` (last error: ${lastErr.message})` : ''),
      );
      if (result) result.cleanup = left;
    }
    await db.end();
  }

  const r = result;
  const row = (name, m) =>
    `${name.padEnd(22)} n=${String(m.n).padStart(5)}  p50=${fmt(m.p50).padStart(5)}  p95=${fmt(m.p95).padStart(5)}  p99=${fmt(m.p99).padStart(5)}  max=${fmt(m.max).padStart(5)} ms`;
  console.log('\n--- results ---');
  console.log(row('POST /sales', r.sale));
  console.log(row('POST /sales/quote', r.quote));
  console.log(row('GET /sales (load)', r.listUnderLoad));
  console.log(row('GET /sales (idle)', r.listIdle));
  console.log(row('DB SELECT 1', r.dbRttMs));
  console.log(
    `sales ok=${r.sale.ok} (${r.sale.throughputPerS.toFixed(2)}/s), requests=${r.totalRequests} (${r.requestsPerS.toFixed(2)}/s), error rate=${(r.errorRate * 100).toFixed(2)}%, sale error rate=${(r.saleErrorRate * 100).toFixed(2)}%, business errors=${r.businessErrors}`,
  );
  console.log('errors:', JSON.stringify(r.errors));
  console.log(`sales in DB: ${r.salesInDb.sales} (sum total ${r.salesInDb.total})`);
  console.log(
    `server uptime before/after: ${r.healthBefore.uptimeSeconds}s / ${r.healthAfter.uptimeSeconds}s (restarted during run: ${r.serverRestartedDuringRun})`,
  );
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(r, null, 2));
  if (r.cleanup && (r.cleanup.tenant || r.cleanup.tenantRows || r.cleanup.users)) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
