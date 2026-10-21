import { afterEach, describe, expect, it } from 'vitest';
import { syncEventSchema } from '@store/shared';
import { createSale, createReturn, getSale, upsertCustomer } from '../src/core/services/sales';
import { createAdjustment, onHand, listStock } from '../src/core/services/stock';
import { createTransfer, approveTransfer, dispatchTransfer } from '../src/core/services/transfers';
import { createGrn } from '../src/core/services/purchases';
import { findByBarcode } from '../src/core/services/catalog';
import { cleanupTempDirs, count, ids, offlineCore, signIn } from './helpers';

afterEach(() => cleanupTempDirs());

function branchWithStock() {
  const core = offlineCore(ids.b1, ids.admin, 'COMPANY_ADMIN');
  createAdjustment(core.ctx, {
    kind: 'OPENING',
    reason: 'OPENING',
    lines: [
      { productId: ids.rice, qtyDelta: 10, unitCost: 40000 },
      { productId: ids.soap, qtyDelta: 20, unitCost: 2400 },
    ],
  });
  signIn(core, ids.cashier, 'SALES_STAFF');
  return core;
}

describe('offline POS sale', () => {
  it('commits sale, payments, stock movements and the sync event atomically', () => {
    const core = branchWithStock();
    const sale = createSale(core.ctx, {
      lines: [
        { productId: ids.rice, qty: 2 },
        { productId: ids.soap, qty: 1, discount: { type: 'PERCENT', valueBp: 1000 } },
      ],
      payments: [
        { method: 'UPI', amount: 100000 },
        { method: 'CASH', amount: 20000 },
      ],
    });
    // 2 × 520.00 + 118.00 − 10% = 1040 + 106.20 = 1146.20 → rounded 1146.00
    expect(sale.grandTotal).toBe(114600);
    expect(sale.roundOff).toBe(-20);
    expect(sale.change).toBe(120000 - 114600);
    expect(sale.invoiceNo).toBe('B11/' + sale.invoiceNo.split('/')[1] + '/00001');
    expect(sale.cgstTotal + sale.sgstTotal).toBe(sale.lines.reduce((s, l) => s + l.cgst + l.sgst, 0));
    expect(onHand(core.db, ids.b1, ids.rice)).toBe(8);
    expect(onHand(core.db, ids.b1, ids.soap)).toBe(19);

    const events = core.db.prepare(`SELECT envelope FROM outbox WHERE type = 'sale.create'`).all() as { envelope: string }[];
    expect(events).toHaveLength(1);
    const parsed = syncEventSchema.safeParse(JSON.parse(events[0].envelope));
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'sale.create') {
      expect(parsed.data.payload.lines.map((l) => l.id)).toEqual(sale.lines.map((l) => l.id));
      expect(parsed.data.userId).toBe(ids.cashier);
    }
    const ledger = core.db.prepare(`SELECT count(*) AS n FROM stock_movements WHERE ref_id = ? AND movement_type = 'SALE'`).get(sale.id) as { n: number };
    expect(ledger.n).toBe(2);
  });

  it('rejects overselling without writing anything', () => {
    const core = branchWithStock();
    const before = { sales: count(core, 'sales'), outbox: count(core, 'outbox'), movements: count(core, 'stock_movements') };
    expect(() => createSale(core.ctx, { lines: [{ productId: ids.rice, qty: 11 }], payments: [{ method: 'CASH', amount: 600000 }] })).toThrow(/Insufficient stock/);
    expect({ sales: count(core, 'sales'), outbox: count(core, 'outbox'), movements: count(core, 'stock_movements') }).toEqual(before);
    // The invoice counter did not advance either: the next sale gets #1.
    const s = createSale(core.ctx, { lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CASH', amount: 11800 }] });
    expect(s.invoiceNo.endsWith('/00001')).toBe(true);
  });

  it('rolls back completely if the process fails mid-transaction', () => {
    const core = branchWithStock();
    // Simulate a crash/IO failure after lines and movements were written but before commit.
    core.db.exec(`CREATE TEMP TRIGGER boom BEFORE INSERT ON payments WHEN NEW.amount = 11801 BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;`);
    const before = { sales: count(core, 'sales'), lines: count(core, 'sale_lines'), outbox: count(core, 'outbox'), movements: count(core, 'stock_movements') };
    expect(() => createSale(core.ctx, { lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CASH', amount: 11801 }] })).toThrow(/disk I\/O/);
    expect({ sales: count(core, 'sales'), lines: count(core, 'sale_lines'), outbox: count(core, 'outbox'), movements: count(core, 'stock_movements') }).toEqual(before);
    expect(onHand(core.db, ids.b1, ids.soap)).toBe(20);
  });

  it('validates payments', () => {
    const core = branchWithStock();
    expect(() => createSale(core.ctx, { lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CASH', amount: 100 }] })).toThrow(/less than/);
    expect(() => createSale(core.ctx, { lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CARD', amount: 20000 }] })).toThrow(/exceeds/);
    expect(() => createSale(core.ctx, { lines: [], payments: [] })).toThrow(/Cart is empty/);
  });

  it('charges IGST for a customer from another state', () => {
    const core = branchWithStock();
    const sale = createSale(core.ctx, { customerId: ids.customerOtherState, lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CARD', amount: 11800 }] });
    expect(sale.interState).toBe(true);
    expect(sale.igstTotal).toBe(1800);
    expect(sale.cgstTotal + sale.sgstTotal).toBe(0);
  });

  it('creates customers offline and queues them before the sale', () => {
    const core = branchWithStock();
    const c = upsertCustomer(core.ctx, { name: 'Walk-in Ravi', phone: '9876543210' });
    createSale(core.ctx, { customerId: c.id, lines: [{ productId: ids.soap, qty: 1 }], payments: [{ method: 'CASH', amount: 11800 }] });
    const types = (core.db.prepare('SELECT type FROM outbox ORDER BY seq').all() as { type: string }[]).map((r) => r.type);
    expect(types.indexOf('customer.upsert')).toBeLessThan(types.indexOf('sale.create'));
    expect(() => upsertCustomer(core.ctx, { name: 'Dup', phone: '9876543210' })).toThrow(/phone/);
  });

  it('resolves pack barcodes with their factor', () => {
    const core = branchWithStock();
    expect(findByBarcode(core.db, '1001-BOX')).toMatchObject({ factor: 10, product: { sku: 'RICE' } });
    expect(findByBarcode(core.db, 'rice')?.product.id).toBe(ids.rice);
    expect(findByBarcode(core.db, 'nope')).toBeNull();
  });
});

describe('returns', () => {
  it('refunds pro-rata, restocks good items and blocks over-returns', () => {
    const core = branchWithStock();
    const sale = createSale(core.ctx, { lines: [{ productId: ids.soap, qty: 3 }], payments: [{ method: 'CASH', amount: 35400 }] });
    const lineId = sale.lines[0].id;
    const r1 = createReturn(core.ctx, { saleId: sale.id, reason: 'Wrong item', refundMethod: 'CASH', lines: [{ saleLineId: lineId, qty: 2, restock: true }] });
    expect(r1.refundTotal).toBe(23600);
    expect(onHand(core.db, ids.b1, ids.soap)).toBe(19);
    expect(() => createReturn(core.ctx, { saleId: sale.id, reason: 'again', refundMethod: 'CASH', lines: [{ saleLineId: lineId, qty: 2, restock: true }] })).toThrow(/only 1/);
    createReturn(core.ctx, { saleId: sale.id, reason: 'Damaged', refundMethod: 'UPI', lines: [{ saleLineId: lineId, qty: 1, restock: false }] });
    expect(onHand(core.db, ids.b1, ids.soap)).toBe(19);
    const after = getSale(core.db, sale.id);
    expect(after.lines[0].qtyReturned).toBe(3);
    expect(after.returns.reduce((s, r) => s + r.refundTotal, 0)).toBe(sale.lines[0].lineTotal);
  });
});

describe('permissions and location rules', () => {
  it('enforces role permissions', () => {
    const core = branchWithStock();
    expect(() => createAdjustment(core.ctx, { kind: 'ADJUSTMENT', reason: 'DAMAGE', notes: 'x', lines: [{ productId: ids.rice, qtyDelta: -1 }] })).toThrow(/permission/);
  });

  it('blocks users not assigned to this location', () => {
    const core = offlineCore(ids.b1, ids.whmgr, 'WAREHOUSE_MANAGER');
    expect(() => createTransfer(core.ctx, { sourceLocationId: ids.wa, destLocationId: ids.b1, lines: [{ productId: ids.rice, qty: 1 }] })).toThrow(/not assigned/);
  });

  it('only branches sell and only authorised locations receive purchases', () => {
    const wh = offlineCore(ids.wa, ids.admin, 'COMPANY_ADMIN');
    createAdjustment(wh.ctx, { kind: 'OPENING', reason: 'OPENING', lines: [{ productId: ids.rice, qtyDelta: 5, unitCost: 1 }] });
    expect(() => createSale(wh.ctx, { lines: [{ productId: ids.rice, qty: 1 }], payments: [{ method: 'CASH', amount: 52000 }] })).toThrow(/selling branch/);
    const br = offlineCore(ids.b1, ids.admin, 'COMPANY_ADMIN');
    expect(() => createGrn(br.ctx, { supplierId: ids.supplier, lines: [{ productId: ids.rice, qty: 1, unitCost: 1, gstRateBp: 0 }] })).toThrow(/not authorised/);
  });

  it('requires a reason and notes for adjustments', () => {
    const core = offlineCore(ids.b1, ids.admin, 'COMPANY_ADMIN');
    expect(() => createAdjustment(core.ctx, { kind: 'ADJUSTMENT', reason: 'DAMAGE', lines: [{ productId: ids.rice, qtyDelta: 1 }] })).toThrow(/notes/);
  });
});

describe('warehouse operations', () => {
  it('GRN updates stock and weighted average cost; transfer reservation limits availability', () => {
    const wh = offlineCore(ids.wa, ids.admin, 'COMPANY_ADMIN');
    createGrn(wh.ctx, { supplierId: ids.supplier, supplierInvoiceNo: 'S-1', lines: [{ productId: ids.rice, qty: 10, unitCost: 40000, gstRateBp: 500 }] });
    createGrn(wh.ctx, { supplierId: ids.supplier, lines: [{ productId: ids.rice, qty: 10, unitCost: 50000, gstRateBp: 500 }] });
    const row = listStock(wh.db, ids.wa).find((r) => r.productId === ids.rice)!;
    expect(row.qtyOnHand).toBe(20);
    expect(row.avgCost).toBe(45000);

    const t = createTransfer(wh.ctx, { sourceLocationId: ids.wa, destLocationId: ids.b1, lines: [{ productId: ids.rice, qty: 15 }] });
    expect(t.status).toBe('APPROVED');
    const afterReserve = listStock(wh.db, ids.wa).find((r) => r.productId === ids.rice)!;
    expect(afterReserve).toMatchObject({ qtyOnHand: 20, reserved: 15, available: 5 });
    // A second order cannot reserve more than what is available
    expect(() => createTransfer(wh.ctx, { sourceLocationId: ids.wa, destLocationId: ids.b2, lines: [{ productId: ids.rice, qty: 6 }] })).toThrow(/Insufficient/);
    const detail = dispatchTransfer(wh.ctx, t.id, [{ lineId: (wh.db.prepare('SELECT id FROM transfer_lines WHERE transfer_id = ?').get(t.id) as { id: string }).id, qty: 15 }]);
    expect(detail.status).toBe('DISPATCHED');
    expect(listStock(wh.db, ids.wa).find((r) => r.productId === ids.rice)).toMatchObject({ qtyOnHand: 5, reserved: 0, available: 5 });
  });

  it('branch requests need source approval; branch-to-branch is gated by settings', () => {
    const br = offlineCore(ids.b1, ids.admin, 'COMPANY_ADMIN');
    const req = createTransfer(br.ctx, { sourceLocationId: ids.wa, destLocationId: ids.b1, lines: [{ productId: ids.rice, qty: 3 }] });
    expect(req.status).toBe('REQUESTED');
    expect(() => approveTransfer(br.ctx, req.id, [])).toThrow(/Only the source/);
    expect(() => createTransfer(br.ctx, { sourceLocationId: ids.b2, destLocationId: ids.b1, lines: [{ productId: ids.rice, qty: 1 }] })).toThrow(/Branch-to-branch/);
  });
});
