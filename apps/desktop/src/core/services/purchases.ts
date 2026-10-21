import { z } from 'zod';
import { mulDivRound, uuidv7, type PurchaseOrderStatus } from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso, tx } from '../db/connection';
import { requireHere, type CoreContext } from '../context';
import { notFound, validation } from '../errors';
import { getLocation, getProductsByIds, getSupplier } from './catalog';
import { enqueue } from './outbox';
import { nextDocNumber } from './numbering';
import { applyMovement, assertAvailable } from './stock';
import { auditLocal } from './audit';

function purchaseLine(l: { productId: string; qty: number; unitCost: number; gstRateBp: number }) {
  const taxableValue = l.qty * l.unitCost;
  const taxTotal = mulDivRound(taxableValue, l.gstRateBp, 10000);
  return { id: uuidv7(), ...l, taxableValue, taxTotal, total: taxableValue + taxTotal };
}

const sumBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

// ---------------------------------------------------------------------------
// Purchase orders (authored centrally, cached for receiving)
// ---------------------------------------------------------------------------

export function listPurchaseOrders(db: DB, locationId: string, status?: PurchaseOrderStatus) {
  return db
    .prepare(
      `SELECT po.id, po.po_no AS poNo, po.status, po.expected_date AS expectedDate, po.created_at AS createdAt, po.notes,
              po.supplier_id AS supplierId, s.name AS supplierName,
              (SELECT sum(qty) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS qtyOrdered,
              (SELECT sum(qty_received) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS qtyReceived,
              (SELECT sum(qty * unit_cost) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id) AS taxableTotal
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id
        WHERE po.location_id = ? AND (? IS NULL OR po.status = ?) ORDER BY po.created_at DESC`,
    )
    .all(locationId, status ?? null, status ?? null);
}

export function getPurchaseOrder(db: DB, id: string) {
  const po = db
    .prepare(
      `SELECT po.id, po.po_no AS poNo, po.status, po.expected_date AS expectedDate, po.created_at AS createdAt, po.notes,
              po.supplier_id AS supplierId, po.location_id AS locationId, s.name AS supplierName
         FROM purchase_orders po LEFT JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = ?`,
    )
    .get(id) as any;
  if (!po) throw notFound('Purchase order');
  po.lines = db
    .prepare(
      `SELECT l.id, l.product_id AS productId, p.name AS productName, p.sku, l.qty, l.qty_received AS qtyReceived, l.unit_cost AS unitCost, l.gst_rate_bp AS gstRateBp
         FROM purchase_order_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.purchase_order_id = ?`,
    )
    .all(id);
  return po;
}

// ---------------------------------------------------------------------------
// Goods received notes (offline)
// ---------------------------------------------------------------------------

export const grnInputSchema = z.object({
  purchaseOrderId: z.uuid().nullish(),
  supplierId: z.uuid(),
  supplierInvoiceNo: z.string().trim().max(40).nullish(),
  supplierInvoiceDate: z.iso.date().nullish(),
  notes: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        purchaseOrderLineId: z.uuid().nullish(),
        qty: z.number().int().positive(),
        unitCost: z.number().int().min(0),
        gstRateBp: z.number().int().min(0).max(10000),
      }),
    )
    .min(1, 'Add at least one product'),
});
export type GrnInput = z.input<typeof grnInputSchema>;

export function createGrn(ctx: CoreContext, raw: GrnInput) {
  const input = grnInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, 'purchase.receive');
  const db = ctx.db;
  const location = getLocation(db, device.locationId);
  if (!location.canReceivePurchases) throw validation('This location is not authorised to receive supplier purchases');
  getSupplier(db, input.supplierId);
  const products = getProductsByIds(db, input.lines.map((l) => l.productId));
  if (products.size !== new Set(input.lines.map((l) => l.productId)).size) throw validation('Unknown product');

  const result = tx(db, () => {
    if (input.purchaseOrderId) {
      const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(input.purchaseOrderId) as any;
      if (!po) throw notFound('Purchase order');
      if (po.location_id !== device.locationId || po.supplier_id !== input.supplierId) throw validation('Purchase order is for a different location or supplier');
      if (!['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status)) throw validation(`Cannot receive against a ${po.status.toLowerCase()} order`);
      for (const l of input.lines) {
        if (!l.purchaseOrderLineId) continue;
        const pl = db.prepare('SELECT * FROM purchase_order_lines WHERE id = ? AND purchase_order_id = ?').get(l.purchaseOrderLineId, po.id) as any;
        if (!pl || pl.product_id !== l.productId) throw validation('Line does not match the purchase order');
      }
    }
    const id = uuidv7();
    const grnNo = nextDocNumber(db, 'GRN', location, device.deviceNo);
    const now = nowIso();
    const lines = input.lines.map((l) => ({ ...purchaseLine(l), purchaseOrderLineId: l.purchaseOrderLineId ?? null }));
    const totals = { taxableTotal: sumBy(lines, (l) => l.taxableValue), taxTotal: sumBy(lines, (l) => l.taxTotal), grandTotal: sumBy(lines, (l) => l.total) };
    db.prepare(
      `INSERT INTO goods_receipts (id, grn_no, purchase_order_id, supplier_id, location_id, user_id, supplier_invoice_no, supplier_invoice_date,
                                   taxable_total, tax_total, grand_total, notes, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, grnNo, input.purchaseOrderId ?? null, input.supplierId, device.locationId, session.user.id, input.supplierInvoiceNo ?? null,
      input.supplierInvoiceDate ?? null, totals.taxableTotal, totals.taxTotal, totals.grandTotal, input.notes ?? null, now);
    for (const l of lines) {
      db.prepare(
        `INSERT INTO goods_receipt_lines (id, grn_id, purchase_order_line_id, product_id, qty, unit_cost, gst_rate_bp, taxable_value, tax_total, total)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(l.id, id, l.purchaseOrderLineId, l.productId, l.qty, l.unitCost, l.gstRateBp, l.taxableValue, l.taxTotal, l.total);
      if (l.purchaseOrderLineId) db.prepare('UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ?').run(l.qty, l.purchaseOrderLineId);
      applyMovement(db, {
        id: l.id,
        locationId: device.locationId,
        productId: l.productId,
        qtyDelta: l.qty,
        movementType: 'PURCHASE_RECEIPT',
        refType: 'GRN',
        refId: id,
        unitCost: l.unitCost,
        userId: session.user.id,
        occurredAt: now,
        origin: 'LOCAL',
      });
    }
    if (input.purchaseOrderId) {
      db.prepare(
        `UPDATE purchase_orders SET status = CASE
           WHEN (SELECT min(qty_received >= qty) FROM purchase_order_lines WHERE purchase_order_id = ?1) = 1 THEN 'RECEIVED'
           ELSE 'PARTIALLY_RECEIVED' END WHERE id = ?1`,
      ).run(input.purchaseOrderId);
    }
    enqueue(db, {
      type: 'grn.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: {
        id,
        grnNo,
        purchaseOrderId: input.purchaseOrderId ?? null,
        supplierId: input.supplierId,
        supplierInvoiceNo: input.supplierInvoiceNo ?? null,
        supplierInvoiceDate: input.supplierInvoiceDate ?? null,
        ...totals,
        notes: input.notes ?? null,
        lines,
      },
      docRefs: input.purchaseOrderId ? [id, input.purchaseOrderId] : [id],
    });
    auditLocal(db, session.user.id, 'grn.create', 'grn', id, { grnNo, grandTotal: totals.grandTotal });
    return { id, grnNo, ...totals };
  });
  ctx.onLocalWrite();
  return result;
}

export function listGrns(db: DB, locationId: string) {
  return db
    .prepare(
      `SELECT g.id, g.grn_no AS grnNo, g.occurred_at AS occurredAt, g.supplier_invoice_no AS supplierInvoiceNo, g.grand_total AS grandTotal,
              g.tax_total AS taxTotal, s.name AS supplierName, po.po_no AS poNo
         FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
        WHERE g.location_id = ? ORDER BY g.occurred_at DESC LIMIT 500`,
    )
    .all(locationId);
}

export function getGrn(db: DB, id: string) {
  const g = db
    .prepare(
      `SELECT g.id, g.grn_no AS grnNo, g.occurred_at AS occurredAt, g.supplier_id AS supplierId, s.name AS supplierName,
              g.supplier_invoice_no AS supplierInvoiceNo, g.supplier_invoice_date AS supplierInvoiceDate, g.taxable_total AS taxableTotal,
              g.tax_total AS taxTotal, g.grand_total AS grandTotal, g.notes, po.po_no AS poNo
         FROM goods_receipts g LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id WHERE g.id = ?`,
    )
    .get(id) as any;
  if (!g) throw notFound('GRN');
  g.lines = db
    .prepare(
      `SELECT l.id, l.product_id AS productId, p.name AS productName, p.sku, l.qty, l.unit_cost AS unitCost, l.gst_rate_bp AS gstRateBp,
              l.taxable_value AS taxableValue, l.tax_total AS taxTotal, l.total
         FROM goods_receipt_lines l LEFT JOIN products p ON p.id = l.product_id WHERE l.grn_id = ?`,
    )
    .all(id);
  return g;
}

// ---------------------------------------------------------------------------
// Purchase returns & supplier payments
// ---------------------------------------------------------------------------

export const purchaseReturnInputSchema = z.object({
  supplierId: z.uuid(),
  grnId: z.uuid().nullish(),
  reason: z.string().trim().min(2, 'Enter a reason').max(300),
  lines: z
    .array(z.object({ productId: z.uuid(), qty: z.number().int().positive(), unitCost: z.number().int().min(0), gstRateBp: z.number().int().min(0).max(10000) }))
    .min(1),
});
export type PurchaseReturnInput = z.infer<typeof purchaseReturnInputSchema>;

export function createPurchaseReturn(ctx: CoreContext, raw: PurchaseReturnInput) {
  const input = purchaseReturnInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, 'purchase.return');
  const db = ctx.db;
  const location = getLocation(db, device.locationId);
  getSupplier(db, input.supplierId);
  const products = getProductsByIds(db, input.lines.map((l) => l.productId));
  const result = tx(db, () => {
    if (input.grnId) {
      const g = db.prepare('SELECT supplier_id, location_id FROM goods_receipts WHERE id = ?').get(input.grnId) as any;
      if (!g || g.supplier_id !== input.supplierId || g.location_id !== device.locationId) throw validation('GRN does not match supplier/location');
    }
    const wanted = new Map<string, number>();
    for (const l of input.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.qty);
    assertAvailable(db, device.locationId, wanted, { names: new Map([...products].map(([k, v]) => [k, v.name])) });
    const id = uuidv7();
    const returnNo = nextDocNumber(db, 'PURCHASE_RETURN', location, device.deviceNo);
    const now = nowIso();
    const lines = input.lines.map(purchaseLine);
    const totals = { taxableTotal: sumBy(lines, (l) => l.taxableValue), taxTotal: sumBy(lines, (l) => l.taxTotal), grandTotal: sumBy(lines, (l) => l.total) };
    db.prepare(
      `INSERT INTO purchase_returns (id, return_no, supplier_id, grn_id, location_id, user_id, reason, taxable_total, tax_total, grand_total, occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, returnNo, input.supplierId, input.grnId ?? null, device.locationId, session.user.id, input.reason, totals.taxableTotal, totals.taxTotal, totals.grandTotal, now);
    for (const l of lines) {
      db.prepare(
        `INSERT INTO purchase_return_lines (id, return_id, product_id, qty, unit_cost, gst_rate_bp, taxable_value, tax_total, total) VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(l.id, id, l.productId, l.qty, l.unitCost, l.gstRateBp, l.taxableValue, l.taxTotal, l.total);
      applyMovement(db, {
        id: l.id,
        locationId: device.locationId,
        productId: l.productId,
        qtyDelta: -l.qty,
        movementType: 'PURCHASE_RETURN',
        refType: 'PURCHASE_RETURN',
        refId: id,
        unitCost: l.unitCost,
        userId: session.user.id,
        occurredAt: now,
        origin: 'LOCAL',
      });
    }
    enqueue(db, {
      type: 'purchase_return.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id, returnNo, supplierId: input.supplierId, grnId: input.grnId ?? null, reason: input.reason, ...totals, lines },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'purchase_return.create', 'purchase_return', id, { returnNo });
    return { id, returnNo, ...totals };
  });
  ctx.onLocalWrite();
  return result;
}

export function listPurchaseReturns(db: DB, locationId: string) {
  return db
    .prepare(
      `SELECT r.id, r.return_no AS returnNo, r.occurred_at AS occurredAt, r.reason, r.grand_total AS grandTotal, s.name AS supplierName, g.grn_no AS grnNo
         FROM purchase_returns r LEFT JOIN suppliers s ON s.id = r.supplier_id LEFT JOIN goods_receipts g ON g.id = r.grn_id
        WHERE r.location_id = ? ORDER BY r.occurred_at DESC LIMIT 500`,
    )
    .all(locationId);
}

export const supplierPaymentInputSchema = z.object({
  supplierId: z.uuid(),
  grnId: z.uuid().nullish(),
  amount: z.number().int().positive('Amount must be greater than zero'),
  method: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE']),
  reference: z.string().trim().max(80).nullish(),
  paidOn: z.iso.date(),
});
export type SupplierPaymentInput = z.infer<typeof supplierPaymentInputSchema>;

export function recordSupplierPayment(ctx: CoreContext, raw: SupplierPaymentInput) {
  const input = supplierPaymentInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, 'supplier_payments.manage');
  getSupplier(ctx.db, input.supplierId);
  const id = uuidv7();
  tx(ctx.db, () => {
    ctx.db
      .prepare('INSERT INTO supplier_payments (id, supplier_id, grn_id, user_id, amount, method, reference, paid_on) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, input.supplierId, input.grnId ?? null, session.user.id, input.amount, input.method, input.reference ?? null, input.paidOn);
    enqueue(ctx.db, {
      type: 'supplier_payment.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id, ...input, grnId: input.grnId ?? null, reference: input.reference ?? null },
      docRefs: [id],
    });
    auditLocal(ctx.db, session.user.id, 'supplier_payment.create', 'supplier_payment', id, { amount: input.amount });
  });
  ctx.onLocalWrite();
  return { id };
}

export function listSupplierPayments(db: DB) {
  return db
    .prepare(
      `SELECT sp.id, sp.paid_on AS paidOn, sp.amount, sp.method, sp.reference, s.name AS supplierName, g.grn_no AS grnNo, u.full_name AS userName
         FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id LEFT JOIN goods_receipts g ON g.id = sp.grn_id
         LEFT JOIN users u ON u.id = sp.user_id ORDER BY sp.paid_on DESC, sp.rowid DESC LIMIT 500`,
    )
    .all();
}
