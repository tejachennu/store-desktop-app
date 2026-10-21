import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeLineRefund, uuidv7 } from '@store/shared';
import { createTestEnv, envelope, opening, pull, push, registerDevice, salePayload, stockOf, type TestEnv } from './helpers.js';

let env: TestEnv;
let b1Key: string;
let b1Key2: string;
let b2Key: string;

beforeAll(async () => {
  env = await createTestEnv();
  b1Key = await registerDevice(env, env.ids.b1);
  b1Key2 = await registerDevice(env, env.ids.b1);
  b2Key = await registerDevice(env, env.ids.b2);
  const res = await push(env, b1Key, [
    opening(env.ids.b1, env.ids.admin, [
      { productId: env.ids.rice, qty: 20, cost: 40000 },
      { productId: env.ids.soap, qty: 50, cost: 2400 },
    ]),
  ]);
  expect(res.body.results[0].status).toBe('ACCEPTED');
});
afterAll(async () => env.close());

describe('sync push: offline sales', () => {
  it('accepts a sale, posts stock movements and is idempotent on replay', async () => {
    const sale = salePayload([
      { productId: env.ids.rice, qty: 2, price: 52000, rateBp: 500 },
      { productId: env.ids.soap, qty: 3, price: 3500, rateBp: 1800 },
    ]);
    const ev = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, sale);
    const first = await push(env, b1Key, [ev]);
    expect(first.status).toBe(200);
    expect(first.body.results[0]).toMatchObject({ id: ev.id, status: 'ACCEPTED' });
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(18);

    // Interrupted request: the client never saw the response and retries.
    const replay = await push(env, b1Key, [ev]);
    expect(replay.body.results[0].status).toBe('DUPLICATE');
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(18);
    const sales = await env.db.query('SELECT count(*)::int AS n FROM sales WHERE id = $1', [sale.id]);
    expect(sales.rows[0].n).toBe(1);
  });

  it('processes concurrent deliveries of the same event exactly once', async () => {
    const ev = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, salePayload([{ productId: env.ids.soap, qty: 1, price: 3500, rateBp: 1800 }]));
    const before = await stockOf(env.db, env.ids.b1, env.ids.soap);
    const [a, b, c] = await Promise.all([push(env, b1Key, [ev]), push(env, b1Key, [ev]), push(env, b1Key, [ev])]);
    const statuses = [a, b, c].map((r) => r.body.results[0].status).sort();
    expect(statuses).toEqual(['ACCEPTED', 'DUPLICATE', 'DUPLICATE']);
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(before - 1);
  });

  it('rejects a sale whose totals do not add up and records it for review', async () => {
    const sale = salePayload([{ productId: env.ids.soap, qty: 1, price: 3500, rateBp: 1800 }]);
    sale.grandTotal += 100;
    const ev = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, sale);
    const res = await push(env, b1Key, [ev]);
    expect(res.body.results[0]).toMatchObject({ status: 'REJECTED', retryable: false });
    const inbox = await env.db.query(`SELECT status FROM sync_inbox WHERE id = $1`, [ev.id]);
    expect(inbox.rows[0].status).toBe('REJECTED');
    const recon = await env.db.query(`SELECT count(*)::int AS n FROM reconciliation_items WHERE type = 'REJECTED_EVENT' AND ref_id = $1`, [ev.id]);
    expect(recon.rows[0].n).toBe(1);
  });

  it('rejects events for another location or by an unauthorised user', async () => {
    const wrongLoc = envelope('sale.create', env.ids.b2, env.ids.b2Cashier, salePayload([{ productId: env.ids.soap, qty: 1, price: 3500, rateBp: 1800 }]));
    const wrongUser = envelope('sale.create', env.ids.b1, env.ids.b2Cashier, salePayload([{ productId: env.ids.soap, qty: 1, price: 3500, rateBp: 1800 }]));
    const res = await push(env, b1Key, [wrongLoc, wrongUser]);
    expect(res.body.results[0].status).toBe('REJECTED');
    expect(res.body.results[0].error).toMatch(/location/);
    expect(res.body.results[1].status).toBe('REJECTED');
    expect(res.body.results[1].error).toMatch(/not authorised/);
  });

  it('accepts offline sales that drive central stock negative and flags them', async () => {
    // Two terminals sold the last units while offline.
    const s1 = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, salePayload([{ productId: env.ids.rice, qty: 10, price: 52000, rateBp: 500 }]));
    const s2 = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, salePayload([{ productId: env.ids.rice, qty: 10, price: 52000, rateBp: 500 }]));
    expect((await push(env, b1Key, [s1])).body.results[0].status).toBe('ACCEPTED');
    expect((await push(env, b1Key2, [s2])).body.results[0].status).toBe('ACCEPTED');
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(-2);
    const recon = await env.db.query(
      `SELECT qty FROM reconciliation_items WHERE type = 'NEGATIVE_STOCK' AND status = 'OPEN' AND location_id = $1 AND product_id = $2`,
      [env.ids.b1, env.ids.rice],
    );
    expect(recon.rows).toHaveLength(1);
    expect(recon.rows[0].qty).toBe(-2);
  });

  it('marks a sale that references an unsynced customer as retryable, then accepts once the customer arrives', async () => {
    const customerId = uuidv7();
    const sale = envelope('sale.create', env.ids.b1, env.ids.b1Cashier, salePayload([{ productId: env.ids.soap, qty: 1, price: 3500, rateBp: 1800 }], { customerId }));
    const first = await push(env, b1Key, [sale]);
    expect(first.body.results[0]).toMatchObject({ status: 'REJECTED', retryable: true });
    const cust = envelope('customer.upsert', env.ids.b1, env.ids.b1Cashier, { id: customerId, name: 'Ramesh', phone: '9876543210', email: null, gstin: null, stateCode: null, address: null });
    const second = await push(env, b1Key, [cust, sale]);
    expect(second.body.results.map((r: { status: string }) => r.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
  });
});

describe('sync push: returns', () => {
  it('handles partial returns with exact refunds and blocks over-returns', async () => {
    const sale = salePayload([{ productId: env.ids.soap, qty: 3, price: 3500, rateBp: 1800 }]);
    await push(env, b1Key, [envelope('sale.create', env.ids.b1, env.ids.b1Cashier, sale)]);
    const line = sale.lines[0];
    const stockBefore = await stockOf(env.db, env.ids.b1, env.ids.soap);

    const mkReturn = (qty: number, already: number, restock: boolean) => {
      const refund = computeLineRefund({ qtySold: line.qty, qtyAlreadyReturned: already, ...line }, qty);
      return envelope('sale_return.create', env.ids.b1, env.ids.b1Cashier, {
        id: uuidv7(),
        returnNo: `R-${Math.random().toString(36).slice(2, 9)}`,
        saleId: sale.id,
        reason: 'Customer changed mind',
        refundTotal: refund.total,
        lines: [{ id: uuidv7(), saleLineId: line.id, productId: line.productId, qty, restock, ...refund }],
        refunds: [{ id: uuidv7(), method: 'CASH' as const, amount: refund.total, reference: null }],
      });
    };
    const r1 = await push(env, b1Key, [mkReturn(2, 0, true)]);
    expect(r1.body.results[0].status).toBe('ACCEPTED');
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(stockBefore + 2);

    const over = await push(env, b1Key, [mkReturn(2, 0, true)]); // 2 already returned + 2 > 3 sold
    expect(over.body.results[0].status).toBe('REJECTED');
    expect(over.body.results[0].error).toMatch(/exceeds/);

    const r2 = await push(env, b1Key, [mkReturn(1, 2, false)]); // damaged: not restocked
    expect(r2.body.results[0].status).toBe('ACCEPTED');
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(stockBefore + 2);
    const refunded = await env.db.query('SELECT sum(refund_total)::int AS t FROM sale_returns WHERE sale_id = $1', [sale.id]);
    expect(refunded.rows[0].t).toBe(line.lineTotal);
  });

  it('defers a return whose sale has not reached the server yet', async () => {
    const res = await push(env, b1Key, [
      envelope('sale_return.create', env.ids.b1, env.ids.b1Cashier, {
        id: uuidv7(),
        returnNo: 'R-NOSALE',
        saleId: uuidv7(),
        reason: 'test',
        refundTotal: 100,
        lines: [{ id: uuidv7(), saleLineId: uuidv7(), productId: env.ids.soap, qty: 1, restock: true, taxableValue: 85, cgst: 8, sgst: 7, igst: 0, total: 100 }],
        refunds: [{ id: uuidv7(), method: 'CASH', amount: 100, reference: null }],
      }),
    ]);
    expect(res.body.results[0]).toMatchObject({ status: 'REJECTED', retryable: true });
  });
});

describe('sync pull', () => {
  it('delivers master data incrementally without password hashes', async () => {
    const first = await pull(env, b2Key);
    expect(first.status).toBe(200);
    expect(first.body.products.length).toBe(3);
    expect(first.body.locations.length).toBe(4);
    expect(first.body.settings.name).toBe('Test Co');
    expect(first.body.users.length).toBeGreaterThan(0);
    expect(JSON.stringify(first.body)).not.toMatch(/password|scrypt/i);
    const rice = first.body.products.find((p: { id: string }) => p.id === env.ids.rice);
    expect(rice.barcodes).toEqual([{ barcode: '890100001', unitLabel: 'pcs', factor: 1 }]);

    let cursor = first.body.cursor;
    let hasMore = first.body.hasMore;
    while (hasMore) {
      const next = await pull(env, b2Key, cursor);
      cursor = next.body.cursor;
      hasMore = next.body.hasMore;
    }
    const empty = await pull(env, b2Key, cursor);
    expect(empty.body.products).toEqual([]);
    expect(empty.body.cursor).toBe(cursor);

    await env.db.query(`UPDATE products SET selling_price = 54000, updated_at = now() WHERE id = $1`, [env.ids.rice]);
    const changed = await pull(env, b2Key, cursor);
    expect(changed.body.products).toHaveLength(1);
    expect(changed.body.products[0].sellingPrice).toBe(54000);
    expect(BigInt(changed.body.cursor)).toBeGreaterThan(BigInt(cursor));
  });

  it("fans out a terminal's movements to sibling terminals at the same location only", async () => {
    const all1 = await pullAll(b1Key);
    const all2 = await pullAll(b1Key2);
    const allB2 = await pullAll(b2Key);
    const devices = await env.db.query('SELECT id FROM devices ORDER BY device_no');
    const ownIdOf = (key: string) => key.split('.')[0];
    expect(all1.every((m) => m.deviceId !== ownIdOf(b1Key))).toBe(true);
    expect(all1.some((m) => m.deviceId === ownIdOf(b1Key2))).toBe(true);
    expect(all2.some((m) => m.deviceId === ownIdOf(b1Key))).toBe(true);
    expect(allB2).toEqual([]);
    expect(devices.rows.length).toBe(3);
  });
});

async function pullAll(key: string) {
  const movements: { deviceId: string; locationId: string }[] = [];
  let cursor = '0';
  for (;;) {
    const res = await pull(env, key, cursor);
    movements.push(...res.body.movements);
    cursor = res.body.cursor;
    if (!res.body.hasMore) break;
  }
  return movements;
}
