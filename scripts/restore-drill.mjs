#!/usr/bin/env node
/**
 * Backup & restore drill (docs/verification/restore-drill.md).
 *
 *   node scripts/restore-drill.mjs [--base-url http://localhost:3000/api/v1] [--port 5434] [--sales 20]
 *
 * 1. Creates a throwaway store in the database of top-backend/.env and, through the
 *    running API, products, stock, cash sales and one return (restock).
 * 2. Snapshots the store's rows in the source: row count per tenant table, sales
 *    count/sum, stock levels, stock-movement ledger per variant/location.
 * 3. pg_dump (custom format, full database) with the client image matching the
 *    server's major version (docker postgres:<major>-alpine). The password is passed
 *    to docker through the environment (`-e PGPASSWORD`), never on a command line.
 * 4. Starts a separate temporary container (pos-restore-drill, 127.0.0.1:<port>),
 *    pg_restore into a fresh database, and runs the same queries there + a few
 *    integrity checks (migrations, audit-log append-only trigger).
 * 5. Always: deletes the store from the source database, removes the container and
 *    deletes the dump file (it contains every store's data).
 *
 * Needs docker. Writes real rows (then deletes them): never run it against production.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Client,
  apiClient,
  connect,
  createTenant,
  deleteTenant,
  loadEnv,
  setupStore,
  tenantLeftovers,
} from '../test/load/tenant-fixture.mjs';

const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const BASE_URL = opt('base-url', process.env.BASE_URL || 'http://localhost:3000/api/v1');
const PORT = Number(opt('port', 5434));
const SALES = Number(opt('sales', 20));
const CONTAINER = 'pos-restore-drill';
const RESTORE_DB = 'restore_drill';

loadEnv();

const timings = {};
const time = async (name, fn) => {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    timings[name] = (performance.now() - start) / 1000;
    console.log(`[${name}] ${timings[name].toFixed(1)} s`);
  }
};

function docker(argv, { env = {}, allowFail = false } = {}) {
  const r = spawnSync('docker', argv, {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${argv[0]} ${argv[1] ?? ''} failed: ${(r.stderr || '').slice(0, 800)}`);
  }
  return r;
}

/** Everything we compare between source and restore, for one store */
async function snapshot(client, tenantId) {
  const tables = (
    await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name <> 'tenants'
       ORDER BY table_name`,
    )
  ).rows.map((r) => r.table_name);
  const counts = {};
  for (const t of tables) {
    counts[t] = (
      await client.query(`SELECT count(*)::int n FROM "${t}" WHERE "tenantId" = $1`, [tenantId])
    ).rows[0].n;
  }
  const sales = (
    await client.query(
      `SELECT count(*)::int n, coalesce(sum(total),0)::text total,
              coalesce(sum("amountPaid"),0)::text paid, max("saleNumber") last_number
       FROM sales WHERE "tenantId" = $1`,
      [tenantId],
    )
  ).rows[0];
  const stock = (
    await client.query(
      `SELECT "variantId", "locationId", "quantityOnHand"::numeric::text qty
       FROM stock_levels WHERE "tenantId" = $1 ORDER BY 1, 2`,
      [tenantId],
    )
  ).rows;
  // Ledger: net of movements into minus out of each location
  const ledger = (
    await client.query(
      `SELECT "variantId", loc "locationId", sum(q)::numeric::text qty FROM (
         SELECT "variantId", "toLocationId" loc, quantity q FROM stock_movements
          WHERE "tenantId" = $1 AND "toLocationId" IS NOT NULL
         UNION ALL
         SELECT "variantId", "fromLocationId", -quantity FROM stock_movements
          WHERE "tenantId" = $1 AND "fromLocationId" IS NOT NULL
       ) m GROUP BY 1, 2 ORDER BY 1, 2`,
      [tenantId],
    )
  ).rows;
  const tenant = (
    await client.query(`SELECT id, slug, status FROM tenants WHERE id = $1`, [tenantId])
  ).rows[0];
  return { tenant, counts, sales, stock, ledger };
}

const key = (r) => `${r.variantId}/${r.locationId}`;
function ledgerMatchesStock(s) {
  const l = new Map(s.ledger.map((r) => [key(r), r.qty]));
  const mismatches = s.stock.filter((r) => Number(l.get(key(r)) ?? 0) !== Number(r.qty));
  return { ok: mismatches.length === 0 && s.stock.length > 0, mismatches };
}

async function makeData(api, store, db, tenantId) {
  // Cash refunds need an open shift on the register
  await api.expect('POST', '/shifts/open', { registerId: store.registerId, openingFloat: 100 });
  let lastSale;
  for (let i = 0; i < SALES; i++) {
    const items = [
      { variantId: store.variantIds[i % store.variantIds.length], quantity: 1 + (i % 3) },
      ...(i % 2 ? [{ variantId: store.variantIds[(i + 1) % store.variantIds.length], quantity: 1 }] : []),
    ];
    const cart = { registerId: store.registerId, items };
    const q = await api.expect('POST', '/sales/quote', cart);
    lastSale = await api.expect('POST', '/sales', {
      ...cart,
      payments: [{ paymentMethodId: store.cashId, amount: Math.ceil(q.total) }],
      idempotencyKey: `drill-${tenantId}-${i}`,
      notes: 'restore drill',
    });
  }
  // One return (restock) of the first line of the last sale, refunded to the original payment
  const {
    rows: [item],
  } = await db.query(`SELECT id FROM sale_items WHERE "saleId" = $1 ORDER BY id LIMIT 1`, [
    lastSale.id,
  ]);
  const ret = await api.call('POST', '/returns', {
    saleId: lastSale.id,
    registerId: store.registerId,
    reason: 'restore drill',
    items: [{ saleItemId: item.id, quantity: 1, disposition: 'restock' }],
    idempotencyKey: `drill-return-${tenantId}`,
  });
  return { returnStatus: ret.status, returnError: ret.status >= 300 ? ret.body : undefined };
}

async function main() {
  const db = await connect();
  const serverVersion = (await db.query(`SHOW server_version`)).rows[0].server_version;
  const major = serverVersion.split('.')[0];
  const image = `postgres:${major}-alpine`;
  console.log(`source server ${serverVersion}; client image ${image}`);

  const workDir = mkdtempSync(path.join(os.tmpdir(), 'pos-drill-'));
  chmodSync(workDir, 0o700);
  const dumpFile = path.join(workDir, 'drill.dump');
  let fixture;
  let report = { serverVersion, image, timings };
  let restored;
  try {
    if (docker(['ps', '-a', '--format', '{{.Names}}']).stdout.split('\n').includes(CONTAINER)) {
      throw new Error(`container ${CONTAINER} already exists; remove it first`);
    }
    docker(['image', 'inspect', image], { allowFail: true }).status === 0 ||
      docker(['pull', '-q', image]);

    // 1. Throwaway store with data
    fixture = await createTenant(db, 'restoredrill');
    console.log(`throwaway store ${fixture.slug} (${fixture.tenantId})`);
    const api = apiClient(BASE_URL);
    await time('setup', async () => {
      const store = await setupStore(api, fixture.email, { productCount: 4, stockPerProduct: 500 });
      Object.assign(report, await makeData(api, store, db, fixture.tenantId));
    });
    await new Promise((r) => setTimeout(r, 2000)); // let post-commit work settle

    // 2. Source snapshot (right before the dump)
    const source = await snapshot(db, fixture.tenantId);
    const sourceGlobal = (
      await db.query(
        `SELECT (SELECT count(*) FROM tenants)::int tenants, (SELECT count(*) FROM users)::int users,
                (SELECT count(*) FROM sales)::int sales, (SELECT count(*) FROM migrations)::int migrations,
                pg_database_size(current_database())::bigint bytes`,
      )
    ).rows[0];

    // 3. Dump (full database, custom format)
    const pgEnv = { PGPASSWORD: process.env.DB_PASSWORD };
    await time('dump', async () => {
      docker(
        [
          'run', '--rm', '-e', 'PGPASSWORD', '-e', 'PGSSLMODE=require',
          '-v', `${workDir}:/backup`, image,
          'pg_dump', '-h', process.env.DB_HOST, '-p', String(process.env.DB_PORT),
          '-U', process.env.DB_USERNAME, '-d', process.env.DB_DATABASE,
          '--format=custom', '--compress=6', '--no-owner', '--no-privileges',
          '-f', '/backup/drill.dump',
        ],
        { env: pgEnv },
      );
    });
    report.dumpBytes = statSync(dumpFile).size;
    const toc = docker(['run', '--rm', '-v', `${workDir}:/backup`, image, 'pg_restore', '--list', '/backup/drill.dump']);
    report.tocEntries = toc.stdout.split('\n').filter((l) => l && !l.startsWith(';')).length;

    // 4. Temporary server + restore
    await time('container start', async () => {
      docker([
        'run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=drill',
        '-p', `127.0.0.1:${PORT}:5432`, image,
      ]);
      for (let i = 0; i < 60; i++) {
        // pg_isready alone passes during the image's init restart; wait for a real query
        const r = docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1'], { allowFail: true });
        if (r.status === 0 && r.stdout.trim() === '1') {
          await new Promise((res) => setTimeout(res, 1500));
          const again = docker(['exec', CONTAINER, 'psql', '-U', 'postgres', '-tAc', 'SELECT 1'], { allowFail: true });
          if (again.status === 0) break;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    });
    await time('restore', async () => {
      docker(['cp', dumpFile, `${CONTAINER}:/tmp/drill.dump`]);
      docker(['exec', CONTAINER, 'createdb', '-U', 'postgres', RESTORE_DB]);
      const r = docker(
        [
          'exec', CONTAINER, 'pg_restore', '-U', 'postgres', '-d', RESTORE_DB,
          '--no-owner', '--no-privileges', '--exit-on-error', '--jobs=4', '/tmp/drill.dump',
        ],
        { allowFail: true },
      );
      report.restoreExit = r.status;
      report.restoreStderr = (r.stderr || '').trim().slice(0, 2000);
      if (r.status !== 0) throw new Error(`pg_restore failed: ${report.restoreStderr}`);
    });

    // 5. Verify
    await time('verify', async () => {
      restored = new Client({ host: '127.0.0.1', port: PORT, user: 'postgres', password: 'drill', database: RESTORE_DB });
      await restored.connect();
      const copy = await snapshot(restored, fixture.tenantId);
      const copyGlobal = (
        await restored.query(
          `SELECT (SELECT count(*) FROM tenants)::int tenants, (SELECT count(*) FROM users)::int users,
                  (SELECT count(*) FROM sales)::int sales, (SELECT count(*) FROM migrations)::int migrations,
                  pg_database_size(current_database())::bigint bytes`,
        )
      ).rows[0];
      const countDiffs = Object.keys({ ...source.counts, ...copy.counts }).filter(
        (t) => source.counts[t] !== copy.counts[t],
      );
      const lastMigration = (
        await restored.query(`SELECT name FROM migrations ORDER BY id DESC LIMIT 1`)
      ).rows[0]?.name;
      // Append-only audit log: the trigger must still reject UPDATE in the copy
      let auditUpdateRejected = false;
      try {
        await restored.query('BEGIN');
        await restored.query(`UPDATE audit_logs SET action = action WHERE "tenantId" = $1`, [fixture.tenantId]);
      } catch (err) {
        auditUpdateRejected = true;
        report.auditTriggerMessage = String(err.message).slice(0, 200);
      } finally {
        await restored.query('ROLLBACK');
      }
      report.verify = {
        tenantPresent: !!copy.tenant,
        nonEmptyTables: Object.entries(source.counts).filter(([, n]) => n > 0).length,
        rowsCompared: Object.values(source.counts).reduce((a, b) => a + b, 0),
        countDiffs,
        salesSource: source.sales,
        salesCopy: copy.sales,
        salesMatch: JSON.stringify(source.sales) === JSON.stringify(copy.sales),
        stockMatch: JSON.stringify(source.stock) === JSON.stringify(copy.stock),
        stockRows: copy.stock.length,
        stockTotal: copy.stock.reduce((a, r) => a + Number(r.qty), 0),
        ledgerTotal: copy.ledger.reduce((a, r) => a + Number(r.qty), 0),
        ledgerMatch: JSON.stringify(source.ledger) === JSON.stringify(copy.ledger),
        ledgerEqualsStockSource: ledgerMatchesStock(source),
        ledgerEqualsStockCopy: ledgerMatchesStock(copy),
        sourceGlobal,
        copyGlobal,
        lastMigration,
        auditUpdateRejected,
        countsSource: source.counts,
      };
    });
  } finally {
    if (restored) await restored.end().catch(() => {});
    rmSync(workDir, { recursive: true, force: true }); // the dump holds every store's data
    const rm = docker(['rm', '-f', '-v', CONTAINER], { allowFail: true });
    report.containerRemoved = rm.status === 0;
    if (fixture) {
      await time('cleanup', async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await deleteTenant(db, fixture.tenantId, fixture.userIds);
            break;
          } catch (err) {
            report.cleanupError = err.message;
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
      });
      report.leftovers = await tenantLeftovers(db, fixture.tenantId, fixture.userIds);
    }
    await db.end();
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
