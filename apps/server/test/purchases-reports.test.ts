import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@store/shared';
import { createTestEnv, envelope, login, opening, push, registerDevice, salePayload, stockOf, type TestEnv } from './helpers.js';

let env: TestEnv;
let waKey: string;
let b1Key: string;
let admin: string;

beforeAll(async () => {
  env = await createTestEnv();
  waKey = await registerDevice(env, env.ids.wA);
  b1Key = await registerDevice(env, env.ids.b1);
  admin = await login(env.app, 'admin');
});
afterAll(async () => env.close());

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function grn(poId: string | null, lines: { productId: string; qty: number; unitCost: number; rateBp: number; poLineId?: string | null }[]) {
  const ls = lines.map((l) => {
    const taxableValue = l.qty * l.unitCost;
    const taxTotal = Math.round((taxableValue * l.rateBp) / 10000);
    return {
      id: uuidv7(),
      productId: l.productId,
      purchaseOrderLineId: l.poLineId ?? null,
      qty: l.qty,
      unitCost: l.unitCost,
      gstRateBp: l.rateBp,
      taxableValue,
      taxTotal,
      total: taxableValue + taxTotal,
    };
  });
  return {
    id: uuidv7(),
    grnNo: `G-${Math.random().toString(36).slice(2, 9)}`,
    purchaseOrderId: poId,
    supplierId: env.ids.supplier,
    supplierInvoiceNo: 'INV-1',
    supplierInvoiceDate: '2026-10-01',
    taxableTotal: ls.reduce((s, l) => s + l.taxableValue, 0),
    taxTotal: ls.reduce((s, l) => s + l.taxTotal, 0),
    grandTotal: ls.reduce((s, l) => s + l.total, 0),
    notes: null,
    lines: ls,
  };
}

describe('purchasing', () => {
  it('purchase order → partial GRN → full GRN, with weighted average cost', async () => {
    const purchaser = await login(env.app, 'purchase');
    const poLine = uuidv7();
    const po = await request(env.app)
      .post('/api/purchase-orders')
      .set(auth(purchaser))
      .send({ id: uuidv7(), supplierId: env.ids.supplier, locationId: env.ids.wA, status: 'ORDERED', lines: [{ id: poLine, productId: env.ids.rice, qty: 100, unitCost: 40000, gstRateBp: 500 }] });
    expect(po.status).toBe(201);
    expect(po.body.poNo).toMatch(/^PO\/\d{4}\/00001$/);

    // Purchase staff assigned only to WA cannot raise a PO for WB
    const denied = await request(env.app)
      .post('/api/purchase-orders')
      .set(auth(purchaser))
      .send({ id: uuidv7(), supplierId: env.ids.supplier, locationId: env.ids.wB, status: 'ORDERED', lines: [{ id: uuidv7(), productId: env.ids.rice, qty: 1, unitCost: 1, gstRateBp: 0 }] });
    expect(denied.status).toBe(403);

    const g1 = await push(env, waKey, [envelope('grn.create', env.ids.wA, env.ids.whMgr, grn(po.body.id, [{ productId: env.ids.rice, qty: 40, unitCost: 40000, rateBp: 500, poLineId: poLine }]))]);
    expect(g1.body.results[0].status).toBe('ACCEPTED');
    let state = await request(env.app).get(`/api/purchase-orders/${po.body.id}`).set(auth(admin));
    expect(state.body.status).toBe('PARTIALLY_RECEIVED');

    const g2 = await push(env, waKey, [envelope('grn.create', env.ids.wA, env.ids.whMgr, grn(po.body.id, [{ productId: env.ids.rice, qty: 60, unitCost: 45000, rateBp: 500, poLineId: poLine }]))]);
    expect(g2.body.results[0].status).toBe('ACCEPTED');
    state = await request(env.app).get(`/api/purchase-orders/${po.body.id}`).set(auth(admin));
    expect(state.body.status).toBe('RECEIVED');
    expect(await stockOf(env.db, env.ids.wA, env.ids.rice)).toBe(100);
    const lvl = await env.db.query('SELECT avg_cost FROM stock_levels WHERE location_id = $1 AND product_id = $2', [env.ids.wA, env.ids.rice]);
    expect(lvl.rows[0].avg_cost).toBe(43000); // (40*400 + 60*450) / 100

    // A received PO can no longer be cancelled
    const cancel = await request(env.app).post(`/api/purchase-orders/${po.body.id}/status`).set(auth(purchaser)).send({ status: 'CANCELLED' });
    expect(cancel.status).toBe(409);
  });

  it('rejects GRNs at locations that cannot receive supplier purchases', async () => {
    const res = await push(env, b1Key, [envelope('grn.create', env.ids.b1, env.ids.admin, grn(null, [{ productId: env.ids.soap, qty: 1, unitCost: 100, rateBp: 0 }]))]);
    expect(res.body.results[0].error).toMatch(/not authorised to receive/);
  });

  it('records purchase returns and supplier payments in the supplier ledger', async () => {
    const g = grn(null, [{ productId: env.ids.oil, qty: 10, unitCost: 10000, rateBp: 500 }]);
    expect((await push(env, waKey, [envelope('grn.create', env.ids.wA, env.ids.whMgr, g)])).body.results[0].status).toBe('ACCEPTED');
    const ret = {
      id: uuidv7(),
      returnNo: 'PR-1',
      supplierId: env.ids.supplier,
      grnId: g.id,
      reason: 'Leaking bottles',
      taxableTotal: 20000,
      taxTotal: 1000,
      grandTotal: 21000,
      lines: [{ id: uuidv7(), productId: env.ids.oil, qty: 2, unitCost: 10000, gstRateBp: 500, taxableValue: 20000, taxTotal: 1000, total: 21000 }],
    };
    expect((await push(env, waKey, [envelope('purchase_return.create', env.ids.wA, env.ids.whMgr, ret)])).body.results[0].status).toBe('ACCEPTED');
    expect(await stockOf(env.db, env.ids.wA, env.ids.oil)).toBe(8);

    // Accounts staff pays the supplier from the warehouse terminal
    const pay = envelope('supplier_payment.create', env.ids.wA, env.ids.accounts, {
      id: uuidv7(), supplierId: env.ids.supplier, grnId: g.id, amount: 50000, method: 'BANK_TRANSFER', reference: 'NEFT123', paidOn: '2026-10-20',
    });
    expect((await push(env, waKey, [pay])).body.results[0].status).toBe('ACCEPTED');

    const ledger = await request(env.app).get(`/api/suppliers/${env.ids.supplier}/ledger`).set(auth(admin));
    expect(ledger.status).toBe(200);
    const totalGrn = ledger.body.entries.filter((e: { kind: string }) => e.kind === 'GRN').reduce((s: number, e: { credit: number }) => s + Number(e.credit), 0);
    expect(ledger.body.balanceDue).toBe(totalGrn - 21000 - 50000);
  });
});

describe('products API', () => {
  it('creates products and prevents duplicate barcodes', async () => {
    const body = { sku: 'tea-250', name: 'Tea 250g', unit: 'pcs', gstRateBp: 500, purchasePrice: 9000, sellingPrice: 12000, mrp: 12500, barcodes: [{ barcode: '8909999000011' }, { barcode: '8909999000028', unitLabel: 'box', factor: 12 }] };
    const res = await request(env.app).post('/api/products').set(auth(admin)).send(body);
    expect(res.status).toBe(201);
    expect(res.body.sku).toBe('TEA-250');
    const dup = await request(env.app).post('/api/products').set(auth(admin)).send({ ...body, sku: 'TEA-500', barcodes: [{ barcode: '8909999000011' }] });
    expect(dup.status).toBe(409);
    const scan = await request(env.app).get('/api/products/by-barcode/8909999000028').set(auth(admin));
    expect(scan.body.factor).toBe(12);
    const cashier = await login(env.app, 'b1cash');
    expect((await request(env.app).post('/api/products').set(auth(cashier)).send(body)).status).toBe(403);
    const invalid = await request(env.app).post('/api/products').set(auth(admin)).send({ ...body, sku: '!', sellingPrice: -1 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION');
  });
});

describe('reports & location scoping', () => {
  it('produces dashboard and GST figures and scopes them to the user locations', async () => {
    await push(env, b1Key, [opening(env.ids.b1, env.ids.admin, [{ productId: env.ids.soap, qty: 10, cost: 2400 }])]);
    const sale = salePayload([{ productId: env.ids.soap, qty: 2, price: 11800, rateBp: 1800 }]);
    expect((await push(env, b1Key, [envelope('sale.create', env.ids.b1, env.ids.b1Cashier, sale)])).body.results[0].status).toBe('ACCEPTED');

    const dash = await request(env.app).get('/api/reports/dashboard').set(auth(admin));
    expect(dash.status).toBe(200);
    expect(dash.body.sales.total).toBe(23600);
    expect(dash.body.salesByBranch[0].total).toBe(23600);
    expect(dash.body.stockByLocation.length).toBe(4);

    const gst = await request(env.app).get('/api/reports/gst').set(auth(admin));
    const row = gst.body.byRate.find((r: { rateBp: number }) => r.rateBp === 1800);
    expect(row).toMatchObject({ supplyType: 'B2C', taxable: 20000, cgst: 1800, sgst: 1800, igst: 0 });

    // Branch manager of B1 cannot read warehouse-only purchase data for WA via locationId
    const b1mgr = await login(env.app, 'b1mgr');
    const forbidden = await request(env.app).get(`/api/reports/dashboard?locationId=${env.ids.wA}`).set(auth(b1mgr));
    expect(forbidden.status).toBe(403);
    const own = await request(env.app).get('/api/reports/dashboard').set(auth(b1mgr));
    expect(own.body.stockByLocation.map((l: { locationId: string }) => l.locationId)).toEqual([env.ids.b1]);

    // Sales staff have no report access at all
    const cashier = await login(env.app, 'b1cash');
    expect((await request(env.app).get('/api/reports/dashboard').set(auth(cashier))).status).toBe(403);
  });
});
