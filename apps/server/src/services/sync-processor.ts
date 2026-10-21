import {
  canAt,
  canTransition,
  checkTransferRoute,
  deriveFulfilmentStatus,
  syncEventSchema,
  uuidv7,
  UUID_RE,
  type Permission,
  type SyncEvent,
  type SyncEventOf,
  type SyncPushResult,
  type TransferAction,
  type TransferStatus,
} from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one, withTransaction, type Tx } from '../db/pool.js';
import type { AuthedDevice } from '../middleware/auth.js';
import { applyMovement, currentAvgCost, flagNegativeStock } from './ledger.js';
import { audit } from './audit.js';
import { getSettings } from './rows.js';

/** A business-rule rejection. Retryable rejections are expected to succeed later (missing dependency). */
export class EventRejection extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

const reject = (msg: string, retryable = false): never => {
  throw new EventRejection(msg, retryable);
};

interface EventCtx {
  tx: Tx;
  device: AuthedDevice;
  event: SyncEvent;
}

function requiredPermission(event: SyncEvent): Permission[] {
  switch (event.type) {
    case 'customer.upsert':
      return ['customers.manage'];
    case 'sale.create':
      return ['pos.sell'];
    case 'sale_return.create':
      return ['pos.return'];
    case 'stock_adjustment.create':
      return [event.payload.kind === 'OPENING' ? 'stock.opening' : 'stock.adjust'];
    case 'grn.create':
      return ['purchase.receive'];
    case 'purchase_return.create':
      return ['purchase.return'];
    case 'supplier_payment.create':
      return ['supplier_payments.manage'];
    case 'transfer.create':
      return [event.payload.autoApprove ? 'transfers.dispatch' : 'transfers.request'];
    case 'transfer.approve':
    case 'transfer.reject':
      return ['transfers.approve'];
    case 'transfer.cancel':
      return ['transfers.request', 'transfers.approve'];
    case 'transfer.dispatch':
      return ['transfers.dispatch'];
    case 'transfer.receive':
    case 'transfer.close':
      return ['transfers.receive'];
  }
}

async function authorize(c: EventCtx): Promise<void> {
  const { event, device, tx } = c;
  if (event.locationId !== device.locationId) {
    reject('Event location does not match the registered location of this device');
  }
  const user = await one<{ role: any; allLocations: boolean; isActive: boolean; locationIds: string[] }>(
    tx,
    `SELECT u.role, u.all_locations AS "allLocations", u.is_active AS "isActive",
            coalesce((SELECT array_agg(location_id) FROM user_locations WHERE user_id = u.id), '{}') AS "locationIds"
       FROM users u WHERE u.id = $1`,
    [event.userId],
  );
  if (!user) return reject('Unknown user');
  if (!user.isActive) reject('User is deactivated');
  const perms = requiredPermission(event);
  if (!perms.some((p) => canAt(user, p, event.locationId))) {
    reject(`User is not authorised for ${event.type} at this location`);
  }
}

// ---------------------------------------------------------------------------
// Push entry point
// ---------------------------------------------------------------------------

export async function processPush(ctx: AppContext, device: AuthedDevice, rawEvents: unknown[]): Promise<SyncPushResult[]> {
  const results: SyncPushResult[] = [];
  for (const raw of rawEvents) {
    results.push(await processOne(ctx, device, raw));
  }
  await ctx.db.query('UPDATE devices SET last_push_at = now() WHERE id = $1', [device.id]);
  return results;
}

async function processOne(ctx: AppContext, device: AuthedDevice, raw: unknown): Promise<SyncPushResult> {
  const rawId = (raw as { id?: unknown })?.id;
  if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) {
    return { id: String(rawId ?? ''), status: 'REJECTED', error: 'Event id is missing or invalid' };
  }
  const parsed = syncEventSchema.safeParse(raw);
  const eventType = String((raw as { type?: unknown }).type ?? 'unknown');

  return withTransaction(ctx.db, async (tx) => {
    // Claim the idempotency key. A concurrent delivery of the same id blocks here
    // until the first transaction finishes, then sees its final status.
    const claim = await one<{ status: string; deviceId: string }>(
      tx,
      `INSERT INTO sync_inbox (id, device_id, event_type, location_id, user_id, occurred_at, status, payload)
       VALUES ($1, $2, $3, $4, $5, $6, 'PROCESSING', $7)
       ON CONFLICT (id) DO UPDATE SET attempts = sync_inbox.attempts + 1
       RETURNING status, device_id AS "deviceId"`,
      [
        rawId,
        device.id,
        eventType.slice(0, 60),
        parsed.success ? parsed.data.locationId : null,
        parsed.success ? parsed.data.userId : null,
        parsed.success ? parsed.data.occurredAt : null,
        JSON.stringify(raw),
      ],
    );
    if (claim!.deviceId !== device.id) {
      return { id: rawId, status: 'REJECTED', error: 'Event id was already used by another device' } as SyncPushResult;
    }
    if (claim!.status === 'ACCEPTED') {
      return { id: rawId, status: 'DUPLICATE' } as SyncPushResult;
    }

    const markRejected = async (error: string, retryable: boolean): Promise<SyncPushResult> => {
      await tx.query(`UPDATE sync_inbox SET status = 'REJECTED', error = $2, processed_at = now() WHERE id = $1`, [rawId, error]);
      if (!retryable) {
        const exists = await one(tx, `SELECT 1 FROM reconciliation_items WHERE type = 'REJECTED_EVENT' AND ref_id = $1 AND status = 'OPEN'`, [rawId]);
        if (!exists) {
          await tx.query(
            `INSERT INTO reconciliation_items (id, type, location_id, ref_type, ref_id, details)
             VALUES ($1, 'REJECTED_EVENT', $2, 'SYNC_EVENT', $3, $4)`,
            [uuidv7(), device.locationId, rawId, JSON.stringify({ eventType, error })],
          );
        }
      }
      return { id: rawId, status: 'REJECTED', error, retryable };
    };

    if (!parsed.success) {
      const msg = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      return markRejected(`Invalid event: ${msg}`, false);
    }

    const event = parsed.data;
    await tx.query('SAVEPOINT ev');
    try {
      const c: EventCtx = { tx, device, event };
      await authorize(c);
      await HANDLERS[event.type](c as never);
      await tx.query(`UPDATE sync_inbox SET status = 'ACCEPTED', error = NULL, processed_at = now() WHERE id = $1`, [rawId]);
      await audit(tx, {
        userId: event.userId,
        locationId: event.locationId,
        deviceId: device.id,
        action: `sync.${event.type}`,
        entityType: event.type.split('.')[0],
        entityId: entityIdOf(event),
        occurredAt: event.occurredAt,
      });
      return { id: rawId, status: 'ACCEPTED' } as SyncPushResult;
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT ev');
      if (err instanceof EventRejection) return markRejected(err.message, err.retryable);
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') {
        return markRejected(`Duplicate document number or id: ${(err as { detail?: string }).detail ?? ''}`, false);
      }
      if (pgCode === '23503') {
        return markRejected(`Referenced record not found: ${(err as { detail?: string }).detail ?? ''}`, true);
      }
      ctx.log.error({ err, eventId: rawId, type: event.type }, 'unexpected error processing sync event');
      return markRejected(`Server error: ${(err as Error).message}`, true);
    }
  });
}

function entityIdOf(e: SyncEvent): string {
  const p = e.payload as { id?: string; transferId?: string };
  return p.id ?? p.transferId ?? e.id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function assertProductsExist(tx: Tx, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  const r = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM products WHERE id = ANY($1::uuid[])', [unique]);
  if ((r?.n ?? 0) !== unique.length) reject('One or more products do not exist');
}

async function locationRow(tx: Tx, id: string) {
  return one<{ id: string; type: 'WAREHOUSE' | 'BRANCH'; isActive: boolean; canReceivePurchases: boolean }>(
    tx,
    `SELECT id, type, is_active AS "isActive", can_receive_purchases AS "canReceivePurchases" FROM locations WHERE id = $1`,
    [id],
  );
}

async function moveAndFlag(tx: Tx, m: Parameters<typeof applyMovement>[1]): Promise<void> {
  const qty = await applyMovement(tx, m);
  if (qty !== null && qty < 0 && m.qtyDelta < 0) {
    await flagNegativeStock(tx, { locationId: m.locationId, productId: m.productId, qtyOnHand: qty, refType: m.refType, refId: m.refId });
  }
}

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

type Handler<T extends SyncEvent['type']> = (c: EventCtx & { event: SyncEventOf<T> }) => Promise<void>;

const customerUpsert: Handler<'customer.upsert'> = async ({ tx, event }) => {
  const p = event.payload;
  await tx.query(
    `INSERT INTO customers (id, name, phone, email, gstin, state_code, address, created_at_location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (id) DO UPDATE SET name = $2, phone = $3, email = $4, gstin = $5, state_code = $6, address = $7, updated_at = now()`,
    [p.id, p.name, p.phone, p.email, p.gstin, p.stateCode, p.address, event.locationId],
  );
};

const saleCreate: Handler<'sale.create'> = async ({ tx, event, device }) => {
  const p = event.payload;
  const loc = await locationRow(tx, event.locationId);
  if (!loc || loc.type !== 'BRANCH') reject('Sales can only be recorded at selling branches');
  if (p.customerId && !(await one(tx, 'SELECT 1 FROM customers WHERE id = $1', [p.customerId]))) {
    reject('Customer has not been synchronised yet', true);
  }
  await assertProductsExist(tx, p.lines.map((l) => l.productId));

  // Arithmetic integrity: totals must be consistent with lines and payments.
  for (const l of p.lines) {
    if (l.taxableValue + l.cgst + l.sgst + l.igst !== l.lineTotal) reject(`Line ${l.sku}: tax breakup does not add up`);
    if (p.interState ? l.cgst + l.sgst !== 0 : l.igst !== 0) reject(`Line ${l.sku}: wrong GST type for place of supply`);
  }
  if (sum(p.lines, (l) => l.taxableValue) !== p.taxableTotal) reject('Taxable total mismatch');
  if (sum(p.lines, (l) => l.cgst) !== p.cgstTotal || sum(p.lines, (l) => l.sgst) !== p.sgstTotal || sum(p.lines, (l) => l.igst) !== p.igstTotal) {
    reject('Tax total mismatch');
  }
  if (sum(p.lines, (l) => l.discount) !== p.discountTotal) reject('Discount total mismatch');
  if (sum(p.lines, (l) => l.lineTotal) + p.roundOff !== p.grandTotal) reject('Grand total mismatch');
  const paid = sum(p.payments, (x) => x.amount);
  // Payments are amounts applied to the bill (cash net of change); tendered − change = bill.
  if (paid !== p.grandTotal || p.tendered - p.change !== p.grandTotal) reject('Payments do not match the bill total');

  await tx.query(
    `INSERT INTO sales (id, invoice_no, location_id, device_id, user_id, customer_id, inter_state, gross_total, discount_total,
                        taxable_total, cgst_total, sgst_total, igst_total, round_off, grand_total, tendered, change_due, notes,
                        exchange_return_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [
      p.id, p.invoiceNo, event.locationId, device.id, event.userId, p.customerId, p.interState, p.grossTotal, p.discountTotal,
      p.taxableTotal, p.cgstTotal, p.sgstTotal, p.igstTotal, p.roundOff, p.grandTotal, p.tendered, p.change, p.notes,
      p.exchangeReturnId, event.occurredAt,
    ],
  );
  for (const l of p.lines) {
    await tx.query(
      `INSERT INTO sale_lines (id, sale_id, product_id, sku, name, hsn_code, qty, unit_price, price_includes_tax, gst_rate_bp,
                               discount, taxable_value, cgst, sgst, igst, line_total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [l.id, p.id, l.productId, l.sku, l.name, l.hsnCode, l.qty, l.unitPrice, l.priceIncludesTax, l.gstRateBp, l.discount,
       l.taxableValue, l.cgst, l.sgst, l.igst, l.lineTotal],
    );
    await moveAndFlag(tx, {
      id: l.id,
      locationId: event.locationId,
      productId: l.productId,
      qtyDelta: -l.qty,
      movementType: 'SALE',
      refType: 'SALE',
      refId: p.id,
      unitCost: await currentAvgCost(tx, event.locationId, l.productId),
      userId: event.userId,
      deviceId: device.id,
      occurredAt: event.occurredAt,
    });
  }
  for (const pay of p.payments) {
    await tx.query(
      `INSERT INTO payments (id, ref_type, ref_id, location_id, method, amount, reference, occurred_at)
       VALUES ($1, 'SALE', $2, $3, $4, $5, $6, $7)`,
      [pay.id, p.id, event.locationId, pay.method, pay.amount, pay.reference, event.occurredAt],
    );
  }
};

const saleReturnCreate: Handler<'sale_return.create'> = async ({ tx, event, device }) => {
  const p = event.payload;
  const sale = await one<{ locationId: string }>(tx, 'SELECT location_id AS "locationId" FROM sales WHERE id = $1', [p.saleId]);
  if (!sale) return reject('Original sale has not been synchronised yet', true);
  if (sale.locationId !== event.locationId) reject('Returns must be processed at the branch that made the sale');
  if (sum(p.lines, (l) => l.total) !== p.refundTotal) reject('Refund total mismatch');
  if (sum(p.refunds, (r) => r.amount) !== p.refundTotal) reject('Refund payments do not match refund total');

  await tx.query(
    `INSERT INTO sale_returns (id, return_no, sale_id, location_id, device_id, user_id, reason, refund_total, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.id, p.returnNo, p.saleId, event.locationId, device.id, event.userId, p.reason, p.refundTotal, event.occurredAt],
  );
  for (const l of p.lines) {
    const sl = await one<{ saleId: string; qty: number; qtyReturned: number; productId: string }>(
      tx,
      `SELECT sale_id AS "saleId", qty, qty_returned AS "qtyReturned", product_id AS "productId" FROM sale_lines WHERE id = $1 FOR UPDATE`,
      [l.saleLineId],
    );
    if (!sl || sl.saleId !== p.saleId || sl.productId !== l.productId) reject('Return line does not belong to the sale');
    if (sl!.qtyReturned + l.qty > sl!.qty) reject('Return quantity exceeds quantity sold');
    if (l.taxableValue + l.cgst + l.sgst + l.igst !== l.total) reject('Return line tax breakup does not add up');
    await tx.query('UPDATE sale_lines SET qty_returned = qty_returned + $2 WHERE id = $1', [l.saleLineId, l.qty]);
    await tx.query(
      `INSERT INTO sale_return_lines (id, return_id, sale_line_id, product_id, qty, restock, taxable_value, cgst, sgst, igst, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [l.id, p.id, l.saleLineId, l.productId, l.qty, l.restock, l.taxableValue, l.cgst, l.sgst, l.igst, l.total],
    );
    if (l.restock) {
      await applyMovement(tx, {
        id: l.id,
        locationId: event.locationId,
        productId: l.productId,
        qtyDelta: l.qty,
        movementType: 'SALE_RETURN',
        refType: 'SALE_RETURN',
        refId: p.id,
        unitCost: await currentAvgCost(tx, event.locationId, l.productId),
        userId: event.userId,
        deviceId: device.id,
        occurredAt: event.occurredAt,
      });
    }
  }
  for (const r of p.refunds) {
    await tx.query(
      `INSERT INTO payments (id, ref_type, ref_id, location_id, method, amount, reference, occurred_at)
       VALUES ($1, 'SALE_RETURN', $2, $3, $4, $5, $6, $7)`,
      [r.id, p.id, event.locationId, r.method, r.amount, r.reference, event.occurredAt],
    );
  }
};

const stockAdjustmentCreate: Handler<'stock_adjustment.create'> = async ({ tx, event, device }) => {
  const p = event.payload;
  if (p.kind === 'OPENING' && p.lines.some((l) => l.qtyDelta < 0)) reject('Opening stock must be positive');
  await assertProductsExist(tx, p.lines.map((l) => l.productId));
  await tx.query(
    `INSERT INTO stock_adjustments (id, adjustment_no, location_id, kind, reason, notes, user_id, device_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.id, p.adjustmentNo, event.locationId, p.kind, p.reason, p.notes, event.userId, device.id, event.occurredAt],
  );
  for (const l of p.lines) {
    const unitCost = l.qtyDelta > 0 && l.unitCost > 0 ? l.unitCost : await currentAvgCost(tx, event.locationId, l.productId);
    await tx.query(
      `INSERT INTO stock_adjustment_lines (id, adjustment_id, product_id, qty_delta, unit_cost) VALUES ($1,$2,$3,$4,$5)`,
      [l.id, p.id, l.productId, l.qtyDelta, unitCost],
    );
    await moveAndFlag(tx, {
      id: l.id,
      locationId: event.locationId,
      productId: l.productId,
      qtyDelta: l.qtyDelta,
      movementType: p.kind === 'OPENING' ? 'OPENING' : 'ADJUSTMENT',
      refType: 'ADJUSTMENT',
      refId: p.id,
      unitCost,
      reason: p.reason,
      userId: event.userId,
      deviceId: device.id,
      occurredAt: event.occurredAt,
    });
  }
};

function checkPurchaseTotals(p: { lines: { taxableValue: number; taxTotal: number; total: number }[]; taxableTotal: number; taxTotal: number; grandTotal: number }) {
  for (const l of p.lines) if (l.taxableValue + l.taxTotal !== l.total) reject('Purchase line totals do not add up');
  if (sum(p.lines, (l) => l.taxableValue) !== p.taxableTotal) reject('Taxable total mismatch');
  if (sum(p.lines, (l) => l.taxTotal) !== p.taxTotal) reject('Tax total mismatch');
  if (sum(p.lines, (l) => l.total) !== p.grandTotal) reject('Grand total mismatch');
}

const grnCreate: Handler<'grn.create'> = async ({ tx, event, device }) => {
  const p = event.payload;
  const loc = await locationRow(tx, event.locationId);
  if (!loc?.canReceivePurchases) reject('This location is not authorised to receive supplier purchases');
  if (!(await one(tx, 'SELECT 1 FROM suppliers WHERE id = $1', [p.supplierId]))) reject('Supplier not found');
  await assertProductsExist(tx, p.lines.map((l) => l.productId));
  checkPurchaseTotals(p);

  if (p.purchaseOrderId) {
    const po = await one<{ locationId: string; supplierId: string; status: string }>(
      tx,
      `SELECT location_id AS "locationId", supplier_id AS "supplierId", status FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [p.purchaseOrderId],
    );
    if (!po) return reject('Purchase order not found', true);
    if (po.locationId !== event.locationId || po.supplierId !== p.supplierId) reject('Purchase order does not match location/supplier');
    if (po.status === 'CANCELLED' || po.status === 'DRAFT') reject(`Cannot receive against a ${po.status.toLowerCase()} purchase order`);
  }

  await tx.query(
    `INSERT INTO goods_receipts (id, grn_no, purchase_order_id, supplier_id, location_id, device_id, user_id, supplier_invoice_no,
                                 supplier_invoice_date, taxable_total, tax_total, grand_total, notes, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [p.id, p.grnNo, p.purchaseOrderId, p.supplierId, event.locationId, device.id, event.userId, p.supplierInvoiceNo,
     p.supplierInvoiceDate, p.taxableTotal, p.taxTotal, p.grandTotal, p.notes, event.occurredAt],
  );
  for (const l of p.lines) {
    if (l.purchaseOrderLineId) {
      const upd = await tx.query(
        `UPDATE purchase_order_lines SET qty_received = qty_received + $3
          WHERE id = $1 AND purchase_order_id = $2 AND product_id = $4`,
        [l.purchaseOrderLineId, p.purchaseOrderId, l.qty, l.productId],
      );
      if (upd.rowCount !== 1) reject('GRN line does not match the purchase order');
    }
    await tx.query(
      `INSERT INTO goods_receipt_lines (id, grn_id, purchase_order_line_id, product_id, qty, unit_cost, gst_rate_bp, taxable_value, tax_total, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [l.id, p.id, l.purchaseOrderLineId, l.productId, l.qty, l.unitCost, l.gstRateBp, l.taxableValue, l.taxTotal, l.total],
    );
    await applyMovement(tx, {
      id: l.id,
      locationId: event.locationId,
      productId: l.productId,
      qtyDelta: l.qty,
      movementType: 'PURCHASE_RECEIPT',
      refType: 'GRN',
      refId: p.id,
      unitCost: l.unitCost,
      userId: event.userId,
      deviceId: device.id,
      occurredAt: event.occurredAt,
    });
  }
  if (p.purchaseOrderId) {
    await tx.query(
      `UPDATE purchase_orders po SET updated_at = now(), status = CASE
          WHEN (SELECT bool_and(qty_received >= qty) FROM purchase_order_lines WHERE purchase_order_id = po.id) THEN 'RECEIVED'
          ELSE 'PARTIALLY_RECEIVED' END
        WHERE id = $1`,
      [p.purchaseOrderId],
    );
  }
};

const purchaseReturnCreate: Handler<'purchase_return.create'> = async ({ tx, event, device }) => {
  const p = event.payload;
  if (!(await one(tx, 'SELECT 1 FROM suppliers WHERE id = $1', [p.supplierId]))) reject('Supplier not found');
  if (p.grnId) {
    const grn = await one<{ locationId: string; supplierId: string }>(
      tx,
      'SELECT location_id AS "locationId", supplier_id AS "supplierId" FROM goods_receipts WHERE id = $1',
      [p.grnId],
    );
    if (!grn) return reject('GRN has not been synchronised yet', true);
    if (grn.locationId !== event.locationId || grn.supplierId !== p.supplierId) reject('GRN does not match location/supplier');
  }
  await assertProductsExist(tx, p.lines.map((l) => l.productId));
  checkPurchaseTotals(p);
  await tx.query(
    `INSERT INTO purchase_returns (id, return_no, supplier_id, grn_id, location_id, device_id, user_id, reason, taxable_total, tax_total, grand_total, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [p.id, p.returnNo, p.supplierId, p.grnId, event.locationId, device.id, event.userId, p.reason, p.taxableTotal, p.taxTotal, p.grandTotal, event.occurredAt],
  );
  for (const l of p.lines) {
    await tx.query(
      `INSERT INTO purchase_return_lines (id, return_id, product_id, qty, unit_cost, gst_rate_bp, taxable_value, tax_total, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [l.id, p.id, l.productId, l.qty, l.unitCost, l.gstRateBp, l.taxableValue, l.taxTotal, l.total],
    );
    await moveAndFlag(tx, {
      id: l.id,
      locationId: event.locationId,
      productId: l.productId,
      qtyDelta: -l.qty,
      movementType: 'PURCHASE_RETURN',
      refType: 'PURCHASE_RETURN',
      refId: p.id,
      unitCost: l.unitCost,
      userId: event.userId,
      deviceId: device.id,
      occurredAt: event.occurredAt,
    });
  }
};

const supplierPaymentCreate: Handler<'supplier_payment.create'> = async ({ tx, event }) => {
  const p = event.payload;
  if (!(await one(tx, 'SELECT 1 FROM suppliers WHERE id = $1', [p.supplierId]))) reject('Supplier not found');
  if (p.grnId && !(await one(tx, 'SELECT 1 FROM goods_receipts WHERE id = $1 AND supplier_id = $2', [p.grnId, p.supplierId]))) {
    reject('GRN not found for this supplier', true);
  }
  await tx.query(
    `INSERT INTO supplier_payments (id, supplier_id, grn_id, location_id, user_id, amount, method, reference, paid_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.id, p.supplierId, p.grnId, event.locationId, event.userId, p.amount, p.method, p.reference, p.paidOn],
  );
};

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

interface LockedTransfer {
  id: string;
  sourceLocationId: string;
  destLocationId: string;
  requestedByLocationId: string;
  status: TransferStatus;
  lines: { id: string; productId: string; qtyRequested: number; qtyApproved: number; qtyDispatched: number; qtyReceived: number; qtyDamaged: number }[];
}

async function lockTransfer(tx: Tx, id: string): Promise<LockedTransfer> {
  const t = await one<Omit<LockedTransfer, 'lines'>>(
    tx,
    `SELECT id, source_location_id AS "sourceLocationId", dest_location_id AS "destLocationId",
            requested_by_location_id AS "requestedByLocationId", status
       FROM stock_transfers WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!t) return reject('Transfer has not been synchronised yet', true);
  const lines = await many<LockedTransfer['lines'][number]>(
    tx,
    `SELECT id, product_id AS "productId", qty_requested AS "qtyRequested", qty_approved AS "qtyApproved",
            qty_dispatched AS "qtyDispatched", qty_received AS "qtyReceived", qty_damaged AS "qtyDamaged"
       FROM transfer_lines WHERE transfer_id = $1 ORDER BY id`,
    [id],
  );
  return { ...t, lines };
}

function assertSide(t: LockedTransfer, locationId: string, action: TransferAction) {
  const isSource = t.sourceLocationId === locationId;
  const isDest = t.destLocationId === locationId;
  const ok =
    action === 'CANCEL'
      ? isSource || isDest
      : ['APPROVE', 'REJECT', 'DISPATCH'].includes(action)
        ? isSource
        : isDest;
  if (!ok) reject(`Only the ${['RECEIVE', 'CLOSE'].includes(action) ? 'destination' : 'source'} location can ${action.toLowerCase()} this transfer`);
}

async function setTransferStatus(
  tx: Tx,
  t: LockedTransfer,
  to: TransferStatus,
  action: string,
  event: SyncEvent,
  details: Record<string, unknown> = {},
  reason: string | null = null,
) {
  await tx.query(
    `UPDATE stock_transfers SET status = $2, status_reason = coalesce($3, status_reason), updated_at = now() WHERE id = $1`,
    [t.id, to, reason],
  );
  await tx.query(
    `INSERT INTO transfer_history (transfer_id, action, from_status, to_status, user_id, location_id, details, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [t.id, action, t.status, to, event.userId, event.locationId, JSON.stringify(details), event.occurredAt],
  );
}

async function raiseConflict(tx: Tx, t: LockedTransfer, event: SyncEvent, message: string) {
  await tx.query(
    `INSERT INTO reconciliation_items (id, type, location_id, ref_type, ref_id, details)
     VALUES ($1, 'TRANSFER_CONFLICT', $2, 'TRANSFER', $3, $4)`,
    [uuidv7(), event.locationId, t.id, JSON.stringify({ message, eventId: event.id, eventType: event.type, statusBefore: t.status })],
  );
}

const transferCreate: Handler<'transfer.create'> = async ({ tx, event }) => {
  const p = event.payload;
  const src = await locationRow(tx, p.sourceLocationId);
  const dst = await locationRow(tx, p.destLocationId);
  if (!src || !dst) return reject('Unknown source or destination location');
  if (event.locationId !== p.sourceLocationId && event.locationId !== p.destLocationId) {
    reject('A transfer must be created by its source or destination location');
  }
  if (p.autoApprove && event.locationId !== p.sourceLocationId) reject('Only the source can create a direct dispatch');
  const settings = await getSettings(tx);
  const route = checkTransferRoute(src, dst, {
    branchToBranchEnabled: settings?.branchToBranchEnabled ?? false,
    branchToWarehouseEnabled: settings?.branchToWarehouseEnabled ?? true,
  });
  if (!route.ok) reject(route.reason);
  await assertProductsExist(tx, p.lines.map((l) => l.productId));
  if (new Set(p.lines.map((l) => l.productId)).size !== p.lines.length) reject('Each product may appear only once per transfer');

  const status: TransferStatus = p.autoApprove ? 'APPROVED' : 'REQUESTED';
  await tx.query(
    `INSERT INTO stock_transfers (id, transfer_no, source_location_id, dest_location_id, requested_by_location_id, status, notes, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [p.id, p.transferNo, p.sourceLocationId, p.destLocationId, event.locationId, status, p.notes, event.userId, event.occurredAt],
  );
  for (const l of p.lines) {
    await tx.query(
      `INSERT INTO transfer_lines (id, transfer_id, product_id, qty_requested, qty_approved) VALUES ($1,$2,$3,$4,$5)`,
      [l.id, p.id, l.productId, l.qtyRequested, p.autoApprove ? l.qtyRequested : 0],
    );
  }
  await tx.query(
    `INSERT INTO transfer_history (transfer_id, action, from_status, to_status, user_id, location_id, details, occurred_at)
     VALUES ($1, 'CREATE', NULL, $2, $3, $4, '{}', $5)`,
    [p.id, status, event.userId, event.locationId, event.occurredAt],
  );
};

const transferApprove: Handler<'transfer.approve'> = async ({ tx, event }) => {
  const t = await lockTransfer(tx, event.payload.transferId);
  assertSide(t, event.locationId, 'APPROVE');
  if (!canTransition(t.status, 'APPROVE')) reject(`Cannot approve a transfer that is ${t.status.toLowerCase()}`);
  const byId = new Map(t.lines.map((l) => [l.id, l]));
  for (const l of event.payload.lines) {
    const line = byId.get(l.lineId);
    if (!line) reject('Approval line does not belong to the transfer');
    if (l.qtyApproved > line!.qtyRequested) reject('Approved quantity cannot exceed requested quantity');
  }
  if (sum(event.payload.lines, (l) => l.qtyApproved) === 0) reject('Approve at least one unit, or reject the transfer');
  const approved = new Map(event.payload.lines.map((l) => [l.lineId, l.qtyApproved]));
  for (const line of t.lines) {
    await tx.query('UPDATE transfer_lines SET qty_approved = $2 WHERE id = $1', [line.id, approved.get(line.id) ?? 0]);
  }
  await setTransferStatus(tx, t, 'APPROVED', 'APPROVE', event, { lines: event.payload.lines });
};

const transferReject: Handler<'transfer.reject'> = async ({ tx, event }) => {
  const t = await lockTransfer(tx, event.payload.transferId);
  assertSide(t, event.locationId, 'REJECT');
  if (!canTransition(t.status, 'REJECT')) reject(`Cannot reject a transfer that is ${t.status.toLowerCase()}`);
  await setTransferStatus(tx, t, 'REJECTED', 'REJECT', event, {}, event.payload.reason);
};

const transferCancel: Handler<'transfer.cancel'> = async ({ tx, event }) => {
  const t = await lockTransfer(tx, event.payload.transferId);
  assertSide(t, event.locationId, 'CANCEL');
  if (!canTransition(t.status, 'CANCEL')) reject(`Cannot cancel a transfer that is ${t.status.toLowerCase()}`);
  await setTransferStatus(tx, t, 'CANCELLED', 'CANCEL', event, {}, event.payload.reason);
};

const transferDispatch: Handler<'transfer.dispatch'> = async ({ tx, event, device }) => {
  const p = event.payload;
  const t = await lockTransfer(tx, p.transferId);
  assertSide(t, event.locationId, 'DISPATCH');
  const byId = new Map(t.lines.map((l) => [l.id, { ...l }]));
  let conflict: string | null = null;
  if (!canTransition(t.status, 'DISPATCH')) {
    // Goods have physically left the source: accept the fact, re-open the transfer, flag for review.
    conflict = `Dispatch received while transfer was ${t.status}; transfer re-opened`;
  }
  for (const l of p.lines) {
    const line = byId.get(l.lineId);
    if (!line) return reject('Dispatch line does not belong to the transfer');
    line.qtyDispatched += l.qty;
    if (line.qtyDispatched > line.qtyApproved) {
      conflict ??= 'Dispatched quantity exceeded approved quantity';
      line.qtyApproved = line.qtyDispatched;
    }
  }
  await tx.query(`INSERT INTO transfer_dispatches (id, transfer_id, user_id, device_id, notes, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
    p.id, t.id, event.userId, device.id, p.notes, event.occurredAt,
  ]);
  for (const l of p.lines) {
    const line = byId.get(l.lineId)!;
    await tx.query(`INSERT INTO transfer_dispatch_lines (id, dispatch_id, transfer_line_id, qty) VALUES ($1,$2,$3,$4)`, [l.id, p.id, l.lineId, l.qty]);
    await tx.query('UPDATE transfer_lines SET qty_dispatched = $2, qty_approved = $3 WHERE id = $1', [line.id, line.qtyDispatched, line.qtyApproved]);
    await moveAndFlag(tx, {
      id: l.id,
      locationId: t.sourceLocationId,
      productId: line.productId,
      qtyDelta: -l.qty,
      movementType: 'TRANSFER_OUT',
      refType: 'TRANSFER',
      refId: t.id,
      unitCost: await currentAvgCost(tx, t.sourceLocationId, line.productId),
      userId: event.userId,
      deviceId: device.id,
      occurredAt: event.occurredAt,
    });
  }
  if (conflict) await raiseConflict(tx, t, event, conflict);
  await setTransferStatus(tx, t, deriveFulfilmentStatus([...byId.values()]), 'DISPATCH', event, { dispatchId: p.id, lines: p.lines });
};

async function openDiscrepancy(tx: Tx, t: LockedTransfer, productId: string, qty: number, kind: 'DAMAGED' | 'MISSING', lineId: string) {
  await tx.query(
    `INSERT INTO reconciliation_items (id, type, location_id, product_id, ref_type, ref_id, qty, details)
     VALUES ($1, 'TRANSFER_DISCREPANCY', $2, $3, 'TRANSFER', $4, $5, $6)`,
    [uuidv7(), t.destLocationId, productId, t.id, qty, JSON.stringify({ kind, transferLineId: lineId, sourceLocationId: t.sourceLocationId })],
  );
}

const transferReceive: Handler<'transfer.receive'> = async ({ tx, event, device }) => {
  const p = event.payload;
  const t = await lockTransfer(tx, p.transferId);
  assertSide(t, event.locationId, 'RECEIVE');
  const late = !canTransition(t.status, 'RECEIVE');
  const byId = new Map(t.lines.map((l) => [l.id, { ...l }]));
  for (const l of p.lines) {
    const line = byId.get(l.lineId);
    if (!line) return reject('Receipt line does not belong to the transfer');
    if (line.qtyReceived + line.qtyDamaged + l.qtyReceived + l.qtyDamaged > line.qtyDispatched) {
      reject('Received quantity exceeds dispatched quantity');
    }
    line.qtyReceived += l.qtyReceived;
    line.qtyDamaged += l.qtyDamaged;
  }
  await tx.query(`INSERT INTO transfer_receipts (id, transfer_id, user_id, device_id, notes, occurred_at) VALUES ($1,$2,$3,$4,$5,$6)`, [
    p.id, t.id, event.userId, device.id, p.notes, event.occurredAt,
  ]);
  for (const l of p.lines) {
    const line = byId.get(l.lineId)!;
    await tx.query(
      `INSERT INTO transfer_receipt_lines (id, receipt_id, transfer_line_id, qty_received, qty_damaged) VALUES ($1,$2,$3,$4,$5)`,
      [l.id, p.id, l.lineId, l.qtyReceived, l.qtyDamaged],
    );
    await tx.query('UPDATE transfer_lines SET qty_received = $2, qty_damaged = $3 WHERE id = $1', [line.id, line.qtyReceived, line.qtyDamaged]);
    if (l.qtyReceived > 0) {
      const cost = await one<{ c: number }>(
        tx,
        `SELECT m.unit_cost AS c FROM transfer_dispatch_lines dl JOIN stock_movements m ON m.id = dl.id
          WHERE dl.transfer_line_id = $1 ORDER BY m.occurred_at DESC LIMIT 1`,
        [line.id],
      );
      await applyMovement(tx, {
        id: l.id,
        locationId: t.destLocationId,
        productId: line.productId,
        qtyDelta: l.qtyReceived,
        movementType: 'TRANSFER_IN',
        refType: 'TRANSFER',
        refId: t.id,
        unitCost: cost?.c ?? 0,
        userId: event.userId,
        deviceId: device.id,
        occurredAt: event.occurredAt,
      });
    }
    if (l.qtyDamaged > 0) await openDiscrepancy(tx, t, line.productId, l.qtyDamaged, 'DAMAGED', line.id);
  }
  if (late) await raiseConflict(tx, t, event, `Receipt recorded while transfer was ${t.status}`);
  const next = t.status === 'CLOSED_WITH_DISCREPANCY' ? t.status : deriveFulfilmentStatus([...byId.values()]);
  await setTransferStatus(tx, t, next, 'RECEIVE', event, { receiptId: p.id, lines: p.lines });
};

const transferClose: Handler<'transfer.close'> = async ({ tx, event }) => {
  const t = await lockTransfer(tx, event.payload.transferId);
  assertSide(t, event.locationId, 'CLOSE');
  if (!canTransition(t.status, 'CLOSE')) reject(`Cannot close a transfer that is ${t.status.toLowerCase()}`);
  let discrepancy = false;
  for (const line of t.lines) {
    const missing = line.qtyDispatched - line.qtyReceived - line.qtyDamaged;
    if (missing > 0) {
      discrepancy = true;
      await openDiscrepancy(tx, t, line.productId, missing, 'MISSING', line.id);
    }
    if (line.qtyDamaged > 0) discrepancy = true;
  }
  await setTransferStatus(tx, t, discrepancy ? 'CLOSED_WITH_DISCREPANCY' : 'RECEIVED', 'CLOSE', event, {}, event.payload.notes);
};

const HANDLERS: { [K in SyncEvent['type']]: Handler<K> } = {
  'customer.upsert': customerUpsert,
  'sale.create': saleCreate,
  'sale_return.create': saleReturnCreate,
  'stock_adjustment.create': stockAdjustmentCreate,
  'grn.create': grnCreate,
  'purchase_return.create': purchaseReturnCreate,
  'supplier_payment.create': supplierPaymentCreate,
  'transfer.create': transferCreate,
  'transfer.approve': transferApprove,
  'transfer.reject': transferReject,
  'transfer.cancel': transferCancel,
  'transfer.dispatch': transferDispatch,
  'transfer.receive': transferReceive,
  'transfer.close': transferClose,
};
