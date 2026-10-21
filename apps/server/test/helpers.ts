import pino from 'pino';
import request from 'supertest';
import { computeBill, uuidv7, type SalePayload } from '@store/shared';
import { createApp } from '../src/app.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { TokenService } from '../src/auth/tokens.js';
import { hashPassword } from '../src/auth/password.js';
import { loadConfig } from '../src/config.js';
import type { AppContext } from '../src/context.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://store:store@localhost:5432/store_test';
export const PASSWORD = 'Passw0rd!';

export interface TestEnv {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  db: Db;
  ids: Awaited<ReturnType<typeof seed>>;
  close: () => Promise<void>;
}

export async function resetDatabase(db: Db): Promise<void> {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

export async function createTestEnv(): Promise<TestEnv> {
  const db = createPool(TEST_DB, 10);
  await resetDatabase(db);
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: TEST_DB, JWT_SECRET: 'test-secret-0123456789-0123456789-abcdef' });
  const ctx: AppContext = { db, config, log: pino({ level: 'silent' }), tokens: new TokenService(config.JWT_SECRET, 60) };
  const app = createApp(ctx);
  const ids = await seed(db);
  return { ctx, app, db, ids, close: () => db.end() };
}

export async function seed(db: Db) {
  const hash = await hashPassword(PASSWORD);
  const id = () => uuidv7();
  const ids = {
    wA: id(), wB: id(), b1: id(), b2: id(),
    admin: id(), whMgr: id(), b1Mgr: id(), b1Cashier: id(), b2Cashier: id(), purchase: id(), accounts: id(),
    rice: id(), soap: id(), oil: id(),
    supplier: id(),
  };
  await db.query(`INSERT INTO company (id, name, state_code) VALUES ($1, 'Test Co', '36')`, [id()]);
  const loc = (lid: string, code: string, type: string) =>
    db.query(`INSERT INTO locations (id, code, name, type, state_code, invoice_prefix, can_receive_purchases) VALUES ($1,$2,$3,$4,'36',$2,$5)`, [
      lid, code, `${code} name`, type, type === 'WAREHOUSE',
    ]);
  await loc(ids.wA, 'WA', 'WAREHOUSE');
  await loc(ids.wB, 'WB', 'WAREHOUSE');
  await loc(ids.b1, 'B1', 'BRANCH');
  await loc(ids.b2, 'B2', 'BRANCH');
  const user = async (uid: string, username: string, role: string, locs: string[], all = false) => {
    await db.query(`INSERT INTO users (id, username, full_name, password_hash, role, all_locations) VALUES ($1,$2,$2,$3,$4,$5)`, [uid, username, hash, role, all]);
    for (const l of locs) await db.query('INSERT INTO user_locations VALUES ($1,$2)', [uid, l]);
  };
  await user(ids.admin, 'admin', 'COMPANY_ADMIN', [], true);
  await user(ids.whMgr, 'whmgr', 'WAREHOUSE_MANAGER', [ids.wA, ids.wB]);
  await user(ids.b1Mgr, 'b1mgr', 'BRANCH_MANAGER', [ids.b1]);
  await user(ids.b1Cashier, 'b1cash', 'SALES_STAFF', [ids.b1]);
  await user(ids.b2Cashier, 'b2cash', 'SALES_STAFF', [ids.b2]);
  await user(ids.purchase, 'purchase', 'PURCHASE_STAFF', [ids.wA]);
  await user(ids.accounts, 'accounts', 'ACCOUNTS_STAFF', [ids.wA, ids.b1]);
  const product = (pid: string, sku: string, rate: number, cost: number, price: number, barcode: string) =>
    db
      .query(
        `INSERT INTO products (id, sku, name, unit, gst_rate_bp, purchase_price, selling_price) VALUES ($1,$2,$2,'pcs',$3,$4,$5)`,
        [pid, sku, rate, cost, price],
      )
      .then(() => db.query('INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)', [barcode, pid]));
  await product(ids.rice, 'RICE', 500, 40000, 52000, '890100001');
  await product(ids.soap, 'SOAP', 1800, 2400, 3500, '890100002');
  await product(ids.oil, 'OIL', 500, 12000, 15500, '890100003');
  await db.query(`INSERT INTO suppliers (id, name) VALUES ($1, 'Supplier One')`, [ids.supplier]);
  return ids;
}

export async function login(app: TestEnv['app'], username: string): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ username, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.accessToken;
}

export async function registerDevice(env: TestEnv, locationId: string): Promise<string> {
  const token = await login(env.app, 'admin');
  const res = await request(env.app).post('/api/devices/register').set('Authorization', `Bearer ${token}`).send({ locationId, name: 'Test PC' });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.deviceKey;
}

export function push(env: TestEnv, deviceKey: string, events: unknown[]) {
  return request(env.app).post('/api/sync/push').set('X-Device-Key', deviceKey).send({ events });
}

export function pull(env: TestEnv, deviceKey: string, cursor = '0') {
  return request(env.app).get(`/api/sync/pull?cursor=${cursor}`).set('X-Device-Key', deviceKey);
}

export function envelope<T extends string, P>(type: T, locationId: string, userId: string, payload: P) {
  return { id: uuidv7(), type, locationId, userId, occurredAt: new Date().toISOString(), payload };
}

let invoiceSeq = 0;
export function salePayload(lines: { productId: string; qty: number; price: number; rateBp: number }[], opts: { customerId?: string | null } = {}): SalePayload {
  const bill = computeBill(
    lines.map((l) => ({ qty: l.qty, unitPrice: l.price, priceIncludesTax: true, gstRateBp: l.rateBp })),
    { interState: false, roundToRupee: true },
  );
  invoiceSeq += 1;
  return {
    id: uuidv7(),
    invoiceNo: `T1/2627/${String(invoiceSeq).padStart(5, '0')}-${Math.random().toString(36).slice(2, 5)}`.slice(0, 20),
    customerId: opts.customerId ?? null,
    interState: false,
    grossTotal: bill.grossTotal,
    discountTotal: bill.discountTotal,
    taxableTotal: bill.taxableTotal,
    cgstTotal: bill.cgstTotal,
    sgstTotal: bill.sgstTotal,
    igstTotal: bill.igstTotal,
    roundOff: bill.roundOff,
    grandTotal: bill.grandTotal,
    tendered: bill.grandTotal,
    change: 0,
    notes: null,
    exchangeReturnId: null,
    lines: lines.map((l, i) => ({
      id: uuidv7(),
      productId: l.productId,
      sku: 'SKU',
      name: 'Product',
      hsnCode: null,
      qty: l.qty,
      unitPrice: l.price,
      priceIncludesTax: true,
      gstRateBp: l.rateBp,
      discount: bill.lines[i].discount,
      taxableValue: bill.lines[i].taxableValue,
      cgst: bill.lines[i].cgst,
      sgst: bill.lines[i].sgst,
      igst: bill.lines[i].igst,
      lineTotal: bill.lines[i].lineTotal,
    })),
    payments: bill.grandTotal > 0 ? [{ id: uuidv7(), method: 'CASH', amount: bill.grandTotal, reference: null }] : [],
  };
}

export async function stockOf(db: Db, locationId: string, productId: string): Promise<number> {
  const r = await db.query('SELECT qty_on_hand FROM stock_levels WHERE location_id = $1 AND product_id = $2', [locationId, productId]);
  return r.rows[0]?.qty_on_hand ?? 0;
}

export function opening(locationId: string, userId: string, lines: { productId: string; qty: number; cost: number }[]) {
  return envelope('stock_adjustment.create', locationId, userId, {
    id: uuidv7(),
    adjustmentNo: `OPN-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'OPENING',
    reason: 'OPENING',
    notes: null,
    lines: lines.map((l) => ({ id: uuidv7(), productId: l.productId, qtyDelta: l.qty, unitCost: l.cost })),
  });
}
