import { z } from 'zod';
import {
  checkPayments,
  computeBill,
  computeLineRefund,
  customerInputSchema,
  hasPermission,
  PAYMENT_METHODS,
  uuidv7,
  type SalePayload,
} from '@store/shared';
import type { DB } from '../db/connection';
import { bool, nowIso, tx } from '../db/connection';
import { requireHere, type CoreContext } from '../context';
import { notFound, validation } from '../errors';
import { getLocation, getProductsByIds, mapCustomer } from './catalog';
import { getSettings } from './meta';
import { enqueue } from './outbox';
import { nextDocNumber } from './numbering';
import { applyMovement, assertAvailable, avgCost } from './stock';
import { auditLocal } from './audit';

// ---------------------------------------------------------------------------
// Customers (can be created offline at the POS)
// ---------------------------------------------------------------------------

export function upsertCustomer(ctx: CoreContext, raw: Omit<z.input<typeof customerInputSchema>, 'id'> & { id?: string }) {
  const { session, device } = requireHere(ctx, 'customers.manage');
  const c = customerInputSchema.parse({ ...raw, id: raw.id ?? uuidv7() });
  const db = ctx.db;
  if (c.phone) {
    const dup = db.prepare('SELECT id FROM customers WHERE phone = ? AND id <> ?').get(c.phone, c.id);
    if (dup) throw validation('Another customer already uses this phone number');
  }
  tx(db, () => {
    db.prepare(
      `INSERT INTO customers (id, name, phone, email, gstin, state_code, address, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email, gstin=excluded.gstin,
         state_code=excluded.state_code, address=excluded.address, updated_at=excluded.updated_at`,
    ).run(c.id, c.name, c.phone, c.email, c.gstin, c.stateCode, c.address, nowIso());
    enqueue(db, { type: 'customer.upsert', locationId: device.locationId, userId: session.user.id, payload: c, docRefs: [c.id] });
  });
  ctx.onLocalWrite();
  return mapCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(c.id));
}

export function searchCustomers(db: DB, search: string, limit = 20) {
  const s = search.trim();
  const rows = s
    ? db.prepare('SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR gstin LIKE ? ORDER BY name LIMIT ?').all(`%${s}%`, `%${s}%`, `%${s}%`, limit)
    : db.prepare('SELECT * FROM customers ORDER BY updated_at DESC LIMIT ?').all(limit);
  return (rows as any[]).map(mapCustomer);
}

export function customerHistory(db: DB, customerId: string) {
  return db
    .prepare(
      `SELECT s.id, s.invoice_no AS invoiceNo, s.occurred_at AS occurredAt, s.grand_total AS grandTotal,
              (SELECT coalesce(sum(r.refund_total),0) FROM sale_returns r WHERE r.sale_id = s.id) AS refunded,
              (SELECT sum(qty) FROM sale_lines l WHERE l.sale_id = s.id) AS items
         FROM sales s WHERE s.customer_id = ? ORDER BY s.occurred_at DESC LIMIT 200`,
    )
    .all(customerId);
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

export const saleInputSchema = z.object({
  customerId: z.uuid().nullish(),
  billDiscount: z.number().int().min(0).default(0),
  notes: z.string().trim().max(300).nullish(),
  exchangeReturnId: z.uuid().nullish(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        qty: z.number().int().positive('Quantity must be at least 1').max(100000),
        discount: z
          .discriminatedUnion('type', [
            z.object({ type: z.literal('PERCENT'), valueBp: z.number().int().min(0).max(10000) }),
            z.object({ type: z.literal('AMOUNT'), value: z.number().int().min(0) }),
          ])
          .nullish(),
      }),
    )
    .min(1, 'Cart is empty')
    .max(500),
  payments: z
    .array(z.object({ method: z.enum(PAYMENT_METHODS), amount: z.number().int().positive(), reference: z.string().trim().max(80).nullish() }))
    .max(10),
});
export type SaleInput = z.input<typeof saleInputSchema>;

export interface SaleDetail {
  id: string;
  invoiceNo: string;
  occurredAt: string;
  locationId: string;
  userName: string | null;
  customer: ReturnType<typeof mapCustomer> | null;
  interState: boolean;
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  roundOff: number;
  grandTotal: number;
  tendered: number;
  change: number;
  notes: string | null;
  lines: {
    id: string;
    productId: string;
    sku: string;
    name: string;
    hsnCode: string | null;
    qty: number;
    qtyReturned: number;
    unitPrice: number;
    priceIncludesTax: boolean;
    gstRateBp: number;
    discount: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    lineTotal: number;
  }[];
  payments: { id: string; method: string; amount: number; reference: string | null }[];
  returns: { id: string; returnNo: string; occurredAt: string; refundTotal: number; reason: string }[];
  syncStatus: string | null;
}

/** Preview totals for the cart (no writes). Used by the POS for live totals. */
export function quoteSale(ctx: CoreContext, raw: SaleInput) {
  const input = saleInputSchema.parse({ ...raw, payments: [] });
  const { device } = requireHere(ctx, 'pos.sell');
  return priceCart(ctx.db, device.locationId, input);
}

function priceCart(db: DB, locationId: string, input: z.infer<typeof saleInputSchema>) {
  const location = getLocation(db, locationId);
  const products = getProductsByIds(db, input.lines.map((l) => l.productId));
  for (const l of input.lines) {
    const p = products.get(l.productId);
    if (!p) throw validation('Product not found');
    if (!p.isActive) throw validation(`${p.name} is inactive and cannot be sold`);
  }
  let customer = null;
  if (input.customerId) {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(input.customerId);
    if (!c) throw notFound('Customer');
    customer = mapCustomer(c);
  }
  // Place of supply: customer's state when known (B2B), else the branch's state.
  const interState = !!customer?.stateCode && customer.stateCode !== location.stateCode;
  const settings = getSettings(db);
  const bill = computeBill(
    input.lines.map((l) => {
      const p = products.get(l.productId)!;
      return { qty: l.qty, unitPrice: p.sellingPrice, priceIncludesTax: p.priceIncludesTax, gstRateBp: p.gstRateBp, discount: l.discount ?? null };
    }),
    { interState, billDiscount: input.billDiscount, roundToRupee: settings.roundToRupee },
  );
  return { bill, products, customer, interState, location };
}

/**
 * Offline-capable sale: validates stock, then commits sale, lines, payments,
 * stock movements and the sync event in ONE SQLite transaction.
 */
export function createSale(ctx: CoreContext, raw: SaleInput): SaleDetail {
  const input = saleInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, 'pos.sell');
  const db = ctx.db;
  const hasDiscount = input.billDiscount > 0 || input.lines.some((l) => l.discount && (l.discount.type === 'PERCENT' ? l.discount.valueBp : l.discount.value) > 0);
  if (hasDiscount && !hasPermission(session.user, 'pos.discount')) throw validation('You are not allowed to give discounts');

  const saleId = tx(db, () => {
    const { bill, products, interState, location } = priceCart(db, device.locationId, input);
    if (location.type !== 'BRANCH') throw validation('Sales can only be made at a selling branch');
    const payments = input.payments.filter((p) => p.amount > 0);
    if (bill.grandTotal > 0) {
      const check = checkPayments(bill.grandTotal, payments);
      if (!check.ok) throw validation(check.error!);
    } else if (payments.length) {
      throw validation('No payment is needed for a zero-value bill');
    }
    const tendered = payments.reduce((s, p) => s + p.amount, 0);
    const change = Math.max(0, tendered - bill.grandTotal);

    const wanted = new Map<string, number>();
    for (const l of input.lines) wanted.set(l.productId, (wanted.get(l.productId) ?? 0) + l.qty);
    assertAvailable(db, device.locationId, wanted, { names: new Map([...products].map(([k, v]) => [k, v.name])) });

    const id = uuidv7();
    const invoiceNo = nextDocNumber(db, 'SALE', location, device.deviceNo);
    const now = nowIso();
    db.prepare(
      `INSERT INTO sales (id, invoice_no, location_id, user_id, customer_id, inter_state, gross_total, discount_total, taxable_total,
                          cgst_total, sgst_total, igst_total, round_off, grand_total, tendered, change_due, notes, exchange_return_id, occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, invoiceNo, device.locationId, session.user.id, input.customerId ?? null, interState ? 1 : 0, bill.grossTotal, bill.discountTotal,
      bill.taxableTotal, bill.cgstTotal, bill.sgstTotal, bill.igstTotal, bill.roundOff, bill.grandTotal, tendered, change, input.notes ?? null,
      input.exchangeReturnId ?? null, now);

    const lines: SalePayload['lines'] = input.lines.map((l, i) => {
      const p = products.get(l.productId)!;
      const b = bill.lines[i];
      const line = {
        id: uuidv7(),
        productId: p.id,
        sku: p.sku,
        name: p.name,
        hsnCode: p.hsnCode,
        qty: l.qty,
        unitPrice: p.sellingPrice,
        priceIncludesTax: p.priceIncludesTax,
        gstRateBp: p.gstRateBp,
        discount: b.discount,
        taxableValue: b.taxableValue,
        cgst: b.cgst,
        sgst: b.sgst,
        igst: b.igst,
        lineTotal: b.lineTotal,
      };
      db.prepare(
        `INSERT INTO sale_lines (id, sale_id, product_id, sku, name, hsn_code, qty, unit_price, price_includes_tax, gst_rate_bp, discount,
                                 taxable_value, cgst, sgst, igst, line_total) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(line.id, id, line.productId, line.sku, line.name, line.hsnCode, line.qty, line.unitPrice, line.priceIncludesTax ? 1 : 0,
        line.gstRateBp, line.discount, line.taxableValue, line.cgst, line.sgst, line.igst, line.lineTotal);
      applyMovement(db, {
        id: line.id,
        locationId: device.locationId,
        productId: p.id,
        qtyDelta: -l.qty,
        movementType: 'SALE',
        refType: 'SALE',
        refId: id,
        unitCost: avgCost(db, device.locationId, p.id),
        userId: session.user.id,
        occurredAt: now,
        origin: 'LOCAL',
      });
      return line;
    });

    const paymentRows = payments.map((p) => ({ id: uuidv7(), method: p.method, amount: p.amount, reference: p.reference ?? null }));
    for (const p of paymentRows) {
      db.prepare(`INSERT INTO payments (id, ref_type, ref_id, method, amount, reference, occurred_at) VALUES (?, 'SALE', ?, ?, ?, ?, ?)`).run(
        p.id, id, p.method, p.amount, p.reference, now,
      );
    }

    enqueue(db, {
      type: 'sale.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: {
        id,
        invoiceNo,
        customerId: input.customerId ?? null,
        interState,
        grossTotal: bill.grossTotal,
        discountTotal: bill.discountTotal,
        taxableTotal: bill.taxableTotal,
        cgstTotal: bill.cgstTotal,
        sgstTotal: bill.sgstTotal,
        igstTotal: bill.igstTotal,
        roundOff: bill.roundOff,
        grandTotal: bill.grandTotal,
        tendered,
        change,
        notes: input.notes ?? null,
        exchangeReturnId: input.exchangeReturnId ?? null,
        lines,
        payments: paymentRows,
      },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'sale.create', 'sale', id, { invoiceNo, grandTotal: bill.grandTotal });
    return id;
  });
  ctx.onLocalWrite();
  return getSale(db, saleId);
}

export function getSale(db: DB, id: string): SaleDetail {
  const s = db
    .prepare(
      `SELECT s.*, u.full_name AS user_name,
              (SELECT status FROM outbox o WHERE o.type = 'sale.create' AND EXISTS (SELECT 1 FROM json_each(o.doc_refs) WHERE value = s.id)) AS sync_status
         FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as any;
  if (!s) throw notFound('Sale');
  const customer = s.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(s.customer_id) : null;
  const lines = (db.prepare('SELECT * FROM sale_lines WHERE sale_id = ? ORDER BY rowid').all(id) as any[]).map((l) => ({
    id: l.id,
    productId: l.product_id,
    sku: l.sku,
    name: l.name,
    hsnCode: l.hsn_code,
    qty: l.qty,
    qtyReturned: l.qty_returned,
    unitPrice: l.unit_price,
    priceIncludesTax: bool(l.price_includes_tax),
    gstRateBp: l.gst_rate_bp,
    discount: l.discount,
    taxableValue: l.taxable_value,
    cgst: l.cgst,
    sgst: l.sgst,
    igst: l.igst,
    lineTotal: l.line_total,
  }));
  const payments = db.prepare(`SELECT id, method, amount, reference FROM payments WHERE ref_type = 'SALE' AND ref_id = ? ORDER BY rowid`).all(id) as any[];
  const returns = db
    .prepare('SELECT id, return_no AS returnNo, occurred_at AS occurredAt, refund_total AS refundTotal, reason FROM sale_returns WHERE sale_id = ? ORDER BY occurred_at')
    .all(id) as any[];
  return {
    id: s.id,
    invoiceNo: s.invoice_no,
    occurredAt: s.occurred_at,
    locationId: s.location_id,
    userName: s.user_name,
    customer: customer ? mapCustomer(customer) : null,
    interState: bool(s.inter_state),
    grossTotal: s.gross_total,
    discountTotal: s.discount_total,
    taxableTotal: s.taxable_total,
    cgstTotal: s.cgst_total,
    sgstTotal: s.sgst_total,
    igstTotal: s.igst_total,
    roundOff: s.round_off,
    grandTotal: s.grand_total,
    tendered: s.tendered,
    change: s.change_due,
    notes: s.notes,
    lines,
    payments,
    returns,
    syncStatus: s.sync_status,
  };
}

export function findSaleByInvoice(db: DB, invoiceNo: string): SaleDetail | null {
  const r = db.prepare('SELECT id FROM sales WHERE invoice_no = ?').get(invoiceNo.trim().toUpperCase()) as { id: string } | undefined;
  return r ? getSale(db, r.id) : null;
}

export function listSales(db: DB, q: { from?: string; to?: string; search?: string; limit?: number }) {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (q.from) {
    where.push(`date(s.occurred_at, 'localtime') >= ?`);
    params.push(q.from);
  }
  if (q.to) {
    where.push(`date(s.occurred_at, 'localtime') <= ?`);
    params.push(q.to);
  }
  if (q.search?.trim()) {
    where.push('(s.invoice_no LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    const like = `%${q.search.trim()}%`;
    params.push(like, like, like);
  }
  params.push(q.limit ?? 500);
  return db
    .prepare(
      `SELECT s.id, s.invoice_no AS invoiceNo, s.occurred_at AS occurredAt, s.grand_total AS grandTotal,
              s.cgst_total + s.sgst_total + s.igst_total AS taxTotal, c.name AS customerName, c.phone AS customerPhone,
              u.full_name AS userName,
              (SELECT coalesce(sum(refund_total),0) FROM sale_returns r WHERE r.sale_id = s.id) AS refunded,
              (SELECT group_concat(method, '+') FROM payments p WHERE p.ref_type = 'SALE' AND p.ref_id = s.id) AS methods,
              (SELECT status FROM outbox o WHERE o.type = 'sale.create' AND EXISTS (SELECT 1 FROM json_each(o.doc_refs) WHERE value = s.id)) AS syncStatus
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id LEFT JOIN users u ON u.id = s.user_id
        WHERE ${where.join(' AND ')} ORDER BY s.occurred_at DESC LIMIT ?`,
    )
    .all(...params);
}

// ---------------------------------------------------------------------------
// Returns / refunds
// ---------------------------------------------------------------------------

export const returnInputSchema = z.object({
  saleId: z.uuid(),
  reason: z.string().trim().min(2, 'Enter a reason').max(300),
  refundMethod: z.enum(PAYMENT_METHODS),
  lines: z
    .array(z.object({ saleLineId: z.uuid(), qty: z.number().int().positive(), restock: z.boolean() }))
    .min(1, 'Select at least one item to return'),
});
export type ReturnInput = z.infer<typeof returnInputSchema>;

/** Sales return with pro-rata refund of taxes; restockable items go back into stock. */
export function createReturn(ctx: CoreContext, raw: ReturnInput) {
  const input = returnInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, 'pos.return');
  const db = ctx.db;
  const result = tx(db, () => {
    const sale = db.prepare('SELECT id, location_id FROM sales WHERE id = ?').get(input.saleId) as { id: string; location_id: string } | undefined;
    if (!sale) throw notFound('Sale');
    if (sale.location_id !== device.locationId) throw validation('Returns must be processed at the branch that made the sale');
    const location = getLocation(db, device.locationId);
    const id = uuidv7();
    const returnNo = nextDocNumber(db, 'SALE_RETURN', location, device.deviceNo);
    const now = nowIso();
    const seen = new Set<string>();
    const lines = input.lines.map((l) => {
      if (seen.has(l.saleLineId)) throw validation('Each invoice line can appear only once');
      seen.add(l.saleLineId);
      const sl = db.prepare('SELECT * FROM sale_lines WHERE id = ? AND sale_id = ?').get(l.saleLineId, input.saleId) as any;
      if (!sl) throw validation('Item does not belong to this invoice');
      if (sl.qty_returned + l.qty > sl.qty) throw validation(`${sl.name}: only ${sl.qty - sl.qty_returned} can be returned`);
      const refund = computeLineRefund(
        { qtySold: sl.qty, qtyAlreadyReturned: sl.qty_returned, taxableValue: sl.taxable_value, cgst: sl.cgst, sgst: sl.sgst, igst: sl.igst, lineTotal: sl.line_total },
        l.qty,
      );
      db.prepare('UPDATE sale_lines SET qty_returned = qty_returned + ? WHERE id = ?').run(l.qty, sl.id);
      return { id: uuidv7(), saleLineId: sl.id, productId: sl.product_id as string, qty: l.qty, restock: l.restock, ...refund };
    });
    const refundTotal = lines.reduce((s, l) => s + l.total, 0);
    db.prepare('INSERT INTO sale_returns (id, return_no, sale_id, location_id, user_id, reason, refund_total, occurred_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, returnNo, input.saleId, device.locationId, session.user.id, input.reason, refundTotal, now,
    );
    for (const l of lines) {
      db.prepare(
        `INSERT INTO sale_return_lines (id, return_id, sale_line_id, product_id, qty, restock, taxable_value, cgst, sgst, igst, total)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(l.id, id, l.saleLineId, l.productId, l.qty, l.restock ? 1 : 0, l.taxableValue, l.cgst, l.sgst, l.igst, l.total);
      if (l.restock) {
        applyMovement(db, {
          id: l.id,
          locationId: device.locationId,
          productId: l.productId,
          qtyDelta: l.qty,
          movementType: 'SALE_RETURN',
          refType: 'SALE_RETURN',
          refId: id,
          unitCost: avgCost(db, device.locationId, l.productId),
          userId: session.user.id,
          occurredAt: now,
          origin: 'LOCAL',
        });
      }
    }
    const refunds = refundTotal > 0 ? [{ id: uuidv7(), method: input.refundMethod, amount: refundTotal, reference: null }] : [];
    for (const r of refunds) {
      db.prepare(`INSERT INTO payments (id, ref_type, ref_id, method, amount, reference, occurred_at) VALUES (?, 'SALE_RETURN', ?, ?, ?, NULL, ?)`).run(
        r.id, id, r.method, r.amount, now,
      );
    }
    enqueue(db, {
      type: 'sale_return.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id, returnNo, saleId: input.saleId, reason: input.reason, refundTotal, lines, refunds },
      docRefs: [id, input.saleId],
    });
    auditLocal(db, session.user.id, 'sale.return', 'sale_return', id, { returnNo, refundTotal });
    return { id, returnNo, refundTotal };
  });
  ctx.onLocalWrite();
  return result;
}

export function getReturn(db: DB, id: string) {
  const r = db
    .prepare(
      `SELECT r.id, r.return_no AS returnNo, r.occurred_at AS occurredAt, r.reason, r.refund_total AS refundTotal, s.invoice_no AS invoiceNo,
              s.id AS saleId, u.full_name AS userName, c.name AS customerName
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id LEFT JOIN customers c ON c.id = s.customer_id
        WHERE r.id = ?`,
    )
    .get(id) as any;
  if (!r) throw notFound('Return');
  const lines = db
    .prepare(
      `SELECT rl.qty, rl.restock, rl.taxable_value AS taxableValue, rl.cgst, rl.sgst, rl.igst, rl.total, sl.name, sl.sku, sl.hsn_code AS hsnCode, sl.gst_rate_bp AS gstRateBp
         FROM sale_return_lines rl JOIN sale_lines sl ON sl.id = rl.sale_line_id WHERE rl.return_id = ?`,
    )
    .all(id);
  const refunds = db.prepare(`SELECT method, amount FROM payments WHERE ref_type = 'SALE_RETURN' AND ref_id = ?`).all(id);
  return { ...r, lines, refunds };
}

export function listReturns(db: DB, limit = 300) {
  return db
    .prepare(
      `SELECT r.id, r.return_no AS returnNo, r.occurred_at AS occurredAt, r.reason, r.refund_total AS refundTotal,
              s.invoice_no AS invoiceNo, u.full_name AS userName
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.occurred_at DESC LIMIT ?`,
    )
    .all(limit);
}
