import { uuidv7, type MovementType } from '@store/shared';
import { one, type Tx } from '../db/pool.js';

export interface MovementInput {
  id: string;
  locationId: string;
  productId: string;
  qtyDelta: number;
  movementType: MovementType;
  refType: string;
  refId: string;
  unitCost?: number;
  reason?: string | null;
  userId?: string | null;
  deviceId?: string | null;
  occurredAt: string | Date;
}

const COST_BEARING: MovementType[] = ['OPENING', 'PURCHASE_RECEIPT', 'TRANSFER_IN'];

/**
 * The only way stock changes centrally: append a movement and update the derived
 * level in the same transaction. Idempotent on movement id. Returns the new on-hand
 * quantity, or null when the movement already existed.
 */
export async function applyMovement(tx: Tx, m: MovementInput): Promise<number | null> {
  const inserted = await tx.query(
    `INSERT INTO stock_movements (id, location_id, product_id, qty_delta, movement_type, ref_type, ref_id, unit_cost, reason, user_id, device_id, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [
      m.id,
      m.locationId,
      m.productId,
      m.qtyDelta,
      m.movementType,
      m.refType,
      m.refId,
      m.unitCost ?? 0,
      m.reason ?? null,
      m.userId ?? null,
      m.deviceId ?? null,
      m.occurredAt,
    ],
  );
  if (inserted.rowCount === 0) return null;

  const costBearing = m.qtyDelta > 0 && COST_BEARING.includes(m.movementType) && (m.unitCost ?? 0) > 0;
  // Weighted average cost is recomputed only on cost-bearing receipts.
  const row = await one<{ qty: number }>(
    tx,
    `INSERT INTO stock_levels AS s (location_id, product_id, qty_on_hand, avg_cost, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (location_id, product_id) DO UPDATE SET
       avg_cost = CASE
         WHEN $5::boolean AND s.qty_on_hand > 0 THEN
           ((s.qty_on_hand::numeric * s.avg_cost + $3::numeric * $4) / (s.qty_on_hand + $3))::bigint
         WHEN $5::boolean THEN $4
         ELSE s.avg_cost END,
       qty_on_hand = s.qty_on_hand + $3,
       updated_at = now()
     RETURNING qty_on_hand AS qty`,
    [m.locationId, m.productId, m.qtyDelta, costBearing ? m.unitCost : 0, costBearing],
  );
  return row!.qty;
}

/** Opens a reconciliation item when a fact (e.g. an offline sale) drove stock negative. */
export async function flagNegativeStock(
  tx: Tx,
  args: { locationId: string; productId: string; qtyOnHand: number; refType: string; refId: string },
): Promise<void> {
  const existing = await one(
    tx,
    `SELECT id FROM reconciliation_items
      WHERE type = 'NEGATIVE_STOCK' AND status = 'OPEN' AND location_id = $1 AND product_id = $2`,
    [args.locationId, args.productId],
  );
  if (existing) {
    await tx.query(`UPDATE reconciliation_items SET qty = $2, details = details || $3::jsonb WHERE id = $1`, [
      existing.id,
      args.qtyOnHand,
      JSON.stringify({ lastRefType: args.refType, lastRefId: args.refId }),
    ]);
    return;
  }
  await tx.query(
    `INSERT INTO reconciliation_items (id, type, location_id, product_id, ref_type, ref_id, qty, details)
     VALUES ($1, 'NEGATIVE_STOCK', $2, $3, $4, $5, $6, $7)`,
    [
      uuidv7(),
      args.locationId,
      args.productId,
      args.refType,
      args.refId,
      args.qtyOnHand,
      JSON.stringify({ message: 'Central stock went negative after synchronising offline transactions' }),
    ],
  );
}

export async function currentAvgCost(tx: Tx, locationId: string, productId: string): Promise<number> {
  const r = await one<{ avg: number }>(
    tx,
    `SELECT coalesce((SELECT avg_cost FROM stock_levels WHERE location_id = $1 AND product_id = $2),
                     (SELECT purchase_price FROM products WHERE id = $2), 0) AS avg`,
    [locationId, productId],
  );
  return r?.avg ?? 0;
}
