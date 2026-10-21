import { z } from 'zod';
import { ADJUSTMENT_REASONS, uuidv7, type MovementType } from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso, tx } from '../db/connection';
import { requireHere, type CoreContext } from '../context';
import { validation } from '../errors';
import { getLocation, getProductsByIds } from './catalog';
import { getSettings } from './meta';
import { enqueue } from './outbox';
import { nextDocNumber } from './numbering';
import { auditLocal } from './audit';

export interface LocalMovement {
  id: string;
  locationId: string;
  productId: string;
  qtyDelta: number;
  movementType: MovementType;
  refType: string;
  refId: string;
  unitCost: number;
  reason?: string | null;
  userId?: string | null;
  occurredAt: string;
  origin: 'LOCAL' | 'REMOTE';
}

const COST_BEARING: MovementType[] = ['OPENING', 'PURCHASE_RECEIPT', 'TRANSFER_IN'];

/**
 * The single function that changes local stock: append the movement and update
 * the derived level. Idempotent on movement id (returns false if already applied).
 */
export function applyMovement(db: DB, m: LocalMovement): boolean {
  const ins = db
    .prepare(
      `INSERT OR IGNORE INTO stock_movements (id, location_id, product_id, qty_delta, movement_type, ref_type, ref_id, unit_cost, reason, user_id, origin, occurred_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(m.id, m.locationId, m.productId, m.qtyDelta, m.movementType, m.refType, m.refId, m.unitCost, m.reason ?? null, m.userId ?? null, m.origin, m.occurredAt);
  if (ins.changes === 0) return false;
  const costBearing = m.qtyDelta > 0 && COST_BEARING.includes(m.movementType) && m.unitCost > 0 ? 1 : 0;
  db.prepare(
    `INSERT INTO stock_levels (location_id, product_id, qty_on_hand, avg_cost, updated_at)
     VALUES (@loc, @prod, @qty, CASE WHEN @cb = 1 THEN @cost ELSE 0 END, @now)
     ON CONFLICT(location_id, product_id) DO UPDATE SET
       avg_cost = CASE
         WHEN @cb = 1 AND qty_on_hand > 0 THEN CAST(round((qty_on_hand * avg_cost + @qty * @cost) * 1.0 / (qty_on_hand + @qty)) AS INTEGER)
         WHEN @cb = 1 THEN @cost
         ELSE avg_cost END,
       qty_on_hand = qty_on_hand + @qty,
       updated_at = @now`,
  ).run({ loc: m.locationId, prod: m.productId, qty: m.qtyDelta, cost: m.unitCost, cb: costBearing, now: nowIso() });
  return true;
}

export function onHand(db: DB, locationId: string, productId: string): number {
  const r = db.prepare('SELECT qty_on_hand FROM stock_levels WHERE location_id = ? AND product_id = ?').get(locationId, productId) as
    | { qty_on_hand: number }
    | undefined;
  return r?.qty_on_hand ?? 0;
}

export function avgCost(db: DB, locationId: string, productId: string): number {
  const r = db
    .prepare(
      `SELECT coalesce((SELECT nullif(avg_cost, 0) FROM stock_levels WHERE location_id = ? AND product_id = ?),
                       (SELECT purchase_price FROM products WHERE id = ?), 0) AS c`,
    )
    .get(locationId, productId, productId) as { c: number };
  return r.c;
}

/** Stock reserved by approved but not yet dispatched outgoing transfers (optionally excluding one transfer). */
export function reserved(db: DB, locationId: string, productId: string, excludeTransferId?: string): number {
  const r = db
    .prepare(
      `SELECT coalesce(sum(tl.qty_approved - tl.qty_dispatched), 0) AS n
         FROM transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
        WHERE t.source_location_id = ? AND tl.product_id = ? AND t.status IN ('APPROVED','PARTIALLY_DISPATCHED')
          AND tl.qty_approved > tl.qty_dispatched AND t.id <> ?`,
    )
    .get(locationId, productId, excludeTransferId ?? '') as { n: number };
  return r.n;
}

export function available(db: DB, locationId: string, productId: string, excludeTransferId?: string): number {
  return onHand(db, locationId, productId) - reserved(db, locationId, productId, excludeTransferId);
}

/** Throws a validation error listing every product whose requested quantity exceeds availability. */
export function assertAvailable(db: DB, locationId: string, wanted: Map<string, number>, opts: { excludeTransferId?: string; names?: Map<string, string> } = {}): void {
  if (getSettings(db).allowNegativeStock) return;
  const short: string[] = [];
  for (const [productId, qty] of wanted) {
    const avail = available(db, locationId, productId, opts.excludeTransferId);
    if (qty > avail) short.push(`${opts.names?.get(productId) ?? productId}: need ${qty}, available ${Math.max(avail, 0)}`);
  }
  if (short.length) throw validation(`Insufficient stock — ${short.join('; ')}`, { short });
}

export interface StockListItem {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  categoryName: string | null;
  qtyOnHand: number;
  reserved: number;
  available: number;
  avgCost: number;
  value: number;
  reorderLevel: number;
  low: boolean;
  sellingPrice: number;
}

export function listStock(db: DB, locationId: string, q: { search?: string; lowOnly?: boolean; includeZero?: boolean } = {}): StockListItem[] {
  const settings = getSettings(db);
  const search = q.search?.trim() ?? '';
  const rows = db
    .prepare(
      `SELECT p.id AS productId, p.sku, p.name, p.unit, c.name AS categoryName, p.selling_price AS sellingPrice,
              coalesce(s.qty_on_hand, 0) AS qtyOnHand, coalesce(nullif(s.avg_cost, 0), p.purchase_price) AS avgCost,
              coalesce((SELECT sum(tl.qty_approved - tl.qty_dispatched) FROM transfer_lines tl JOIN stock_transfers t ON t.id = tl.transfer_id
                         WHERE t.source_location_id = @loc AND tl.product_id = p.id AND t.status IN ('APPROVED','PARTIALLY_DISPATCHED')
                           AND tl.qty_approved > tl.qty_dispatched), 0) AS reserved,
              max(p.reorder_level, @low) AS reorderLevel
         FROM products p LEFT JOIN stock_levels s ON s.product_id = p.id AND s.location_id = @loc
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE (p.is_active = 1 OR coalesce(s.qty_on_hand, 0) <> 0)
          AND (@search = '' OR p.name LIKE @like OR p.sku LIKE @like
               OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = @search))
        ORDER BY p.name COLLATE NOCASE`,
    )
    .all({ loc: locationId, low: settings.defaultLowStockLevel, search, like: `%${search}%` }) as any[];
  return rows
    .map((r) => ({
      ...r,
      available: r.qtyOnHand - r.reserved,
      value: Math.max(r.qtyOnHand, 0) * r.avgCost,
      low: r.qtyOnHand <= r.reorderLevel,
    }))
    .filter((r) => (q.lowOnly ? r.low : true))
    .filter((r) => (q.includeZero === false ? r.qtyOnHand !== 0 : true));
}

export function listMovements(db: DB, locationId: string, q: { productId?: string; limit?: number } = {}) {
  const params: unknown[] = [locationId];
  let where = 'm.location_id = ?';
  if (q.productId) {
    where += ' AND m.product_id = ?';
    params.push(q.productId);
  }
  params.push(q.limit ?? 300);
  return db
    .prepare(
      `SELECT m.id, m.occurred_at AS occurredAt, m.movement_type AS movementType, m.qty_delta AS qtyDelta, m.unit_cost AS unitCost,
              m.ref_type AS refType, m.ref_id AS refId, m.reason, m.origin, p.sku, p.name AS productName, u.full_name AS userName,
              coalesce(s.invoice_no, sr.return_no, g.grn_no, t.transfer_no, a.adjustment_no, pr.return_no) AS docNo
         FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN sales s ON m.ref_type = 'SALE' AND s.id = m.ref_id
         LEFT JOIN sale_returns sr ON m.ref_type = 'SALE_RETURN' AND sr.id = m.ref_id
         LEFT JOIN goods_receipts g ON m.ref_type = 'GRN' AND g.id = m.ref_id
         LEFT JOIN stock_transfers t ON m.ref_type = 'TRANSFER' AND t.id = m.ref_id
         LEFT JOIN stock_adjustments a ON m.ref_type = 'ADJUSTMENT' AND a.id = m.ref_id
         LEFT JOIN purchase_returns pr ON m.ref_type = 'PURCHASE_RETURN' AND pr.id = m.ref_id
        WHERE ${where} ORDER BY m.occurred_at DESC, m.id DESC LIMIT ?`,
    )
    .all(...params);
}

export const adjustmentInputSchema = z.object({
  kind: z.enum(['OPENING', 'ADJUSTMENT']),
  reason: z.enum([...ADJUSTMENT_REASONS, 'OPENING']),
  notes: z.string().trim().max(500).nullish(),
  lines: z
    .array(
      z.object({
        productId: z.uuid(),
        qtyDelta: z.number().int().refine((v) => v !== 0, 'Quantity cannot be zero'),
        unitCost: z.number().int().min(0).optional(),
      }),
    )
    .min(1, 'Add at least one product'),
});
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

/** Stock adjustment (damage, loss, count correction…) or opening stock, with reason. */
export function createAdjustment(ctx: CoreContext, raw: AdjustmentInput) {
  const input = adjustmentInputSchema.parse(raw);
  const { session, device } = requireHere(ctx, input.kind === 'OPENING' ? 'stock.opening' : 'stock.adjust');
  if (input.kind === 'OPENING' && input.lines.some((l) => l.qtyDelta < 0)) throw validation('Opening stock must be positive');
  if (input.kind === 'ADJUSTMENT' && input.reason === 'OPENING') throw validation('Choose an adjustment reason');
  if (input.kind === 'ADJUSTMENT' && !input.notes) throw validation('Explain the reason for the adjustment in the notes');
  const db = ctx.db;
  const location = getLocation(db, device.locationId);
  const products = getProductsByIds(db, input.lines.map((l) => l.productId));
  if (products.size !== new Set(input.lines.map((l) => l.productId)).size) throw validation('Unknown product in adjustment');

  const result = tx(db, () => {
    const decreases = new Map<string, number>();
    for (const l of input.lines) if (l.qtyDelta < 0) decreases.set(l.productId, (decreases.get(l.productId) ?? 0) - l.qtyDelta);
    assertAvailable(db, device.locationId, decreases, { names: new Map([...products].map(([k, v]) => [k, v.name])) });

    const id = uuidv7();
    const adjustmentNo = nextDocNumber(db, 'ADJUSTMENT', location, device.deviceNo);
    const now = nowIso();
    db.prepare('INSERT INTO stock_adjustments (id, adjustment_no, location_id, kind, reason, notes, user_id, occurred_at) VALUES (?,?,?,?,?,?,?,?)').run(
      id, adjustmentNo, device.locationId, input.kind, input.reason, input.notes ?? null, session.user.id, now,
    );
    const lines = input.lines.map((l) => {
      const lineId = uuidv7();
      const unitCost = l.qtyDelta > 0 && l.unitCost ? l.unitCost : avgCost(db, device.locationId, l.productId);
      db.prepare('INSERT INTO stock_adjustment_lines (id, adjustment_id, product_id, qty_delta, unit_cost) VALUES (?,?,?,?,?)').run(
        lineId, id, l.productId, l.qtyDelta, unitCost,
      );
      applyMovement(db, {
        id: lineId,
        locationId: device.locationId,
        productId: l.productId,
        qtyDelta: l.qtyDelta,
        movementType: input.kind === 'OPENING' ? 'OPENING' : 'ADJUSTMENT',
        refType: 'ADJUSTMENT',
        refId: id,
        unitCost,
        reason: input.reason,
        userId: session.user.id,
        occurredAt: now,
        origin: 'LOCAL',
      });
      return { id: lineId, productId: l.productId, qtyDelta: l.qtyDelta, unitCost };
    });
    enqueue(db, {
      type: 'stock_adjustment.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id, adjustmentNo, kind: input.kind, reason: input.reason, notes: input.notes ?? null, lines },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, `stock.${input.kind.toLowerCase()}`, 'adjustment', id, { adjustmentNo, lines: lines.length });
    return { id, adjustmentNo };
  });
  ctx.onLocalWrite();
  return result;
}

export function listAdjustments(db: DB, locationId: string) {
  return db
    .prepare(
      `SELECT a.id, a.adjustment_no AS adjustmentNo, a.kind, a.reason, a.notes, a.occurred_at AS occurredAt, u.full_name AS userName,
              (SELECT count(*) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS lineCount,
              (SELECT sum(l.qty_delta * l.unit_cost) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS valueDelta
         FROM stock_adjustments a LEFT JOIN users u ON u.id = a.user_id WHERE a.location_id = ? ORDER BY a.occurred_at DESC LIMIT 500`,
    )
    .all(locationId);
}
