import { Router } from 'express';
import { z } from 'zod';
import { hasPermission, openingStockSchema, RECONCILIATION_TYPES, TRANSFER_STATUSES, uuidv7 } from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one, withTransaction } from '../db/pool.js';
import { assertPermission, requirePermission, requireUser } from '../middleware/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { applyMovement } from '../services/ledger.js';
import { nextCentralNumber } from '../services/numbering.js';
import { TRANSFER_COLS, getTransfer } from '../services/rows.js';
import { locClause, locationFilter, parse, uuidParam } from './util.js';

/** Stock reserved at the source by approved, not yet dispatched transfer quantities. */
const RESERVED_SQL = `coalesce((SELECT sum(tl.qty_approved - tl.qty_dispatched) FROM transfer_lines tl
   JOIN stock_transfers t ON t.id = tl.transfer_id
  WHERE t.source_location_id = s.location_id AND tl.product_id = s.product_id
    AND t.status IN ('APPROVED','PARTIALLY_DISPATCHED') AND tl.qty_approved > tl.qty_dispatched), 0)`;

export function inventoryRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx));

  /**
   * Stock levels. Users who may request transfers can view other locations' stock
   * (read-only) to decide where to request from; otherwise only their own locations.
   */
  r.get('/stock', requirePermission('stock.view'), async (req, res) => {
    const q = parse(
      z.object({
        locationId: z.uuid().optional(),
        productId: z.uuid().optional(),
        search: z.string().trim().max(100).optional(),
        lowOnly: z.enum(['true', 'false']).optional(),
        limit: z.coerce.number().int().min(1).max(2000).default(500),
      }),
      req.query,
    );
    const user = req.user!;
    const crossLocation = hasPermission(user, 'stock.view_all') || hasPermission(user, 'transfers.request');
    const params: unknown[] = [];
    let where = 'WHERE true';
    if (q.locationId) {
      if (!crossLocation) assertPermission(req, 'stock.view', q.locationId);
      params.push(q.locationId);
      where += ` AND s.location_id = $${params.length}`;
    } else if (!crossLocation) {
      where += locClause('s.location_id', locationFilter(req), params);
    }
    if (q.productId) {
      params.push(q.productId);
      where += ` AND s.product_id = $${params.length}`;
    }
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`);
      where += ` AND (lower(p.name) LIKE $${params.length} OR lower(p.sku) LIKE $${params.length})`;
    }
    const settings = await one<{ d: number }>(ctx.db, 'SELECT default_low_stock_level AS d FROM company');
    params.push(settings?.d ?? 0);
    const lowIdx = params.length;
    if (q.lowOnly === 'true') where += ` AND s.qty_on_hand <= greatest(p.reorder_level, $${lowIdx})`;
    params.push(q.limit);
    res.json(
      await many(
        ctx.db,
        `SELECT s.location_id AS "locationId", l.name AS "locationName", l.type AS "locationType", s.product_id AS "productId",
                p.sku, p.name, p.unit, s.qty_on_hand AS "qtyOnHand", ${RESERVED_SQL} AS reserved,
                s.qty_on_hand - ${RESERVED_SQL} AS available, s.avg_cost AS "avgCost",
                s.qty_on_hand * s.avg_cost AS value, greatest(p.reorder_level, $${lowIdx}) AS "reorderLevel",
                s.qty_on_hand <= greatest(p.reorder_level, $${lowIdx}) AS low, s.updated_at AS "updatedAt"
           FROM stock_levels s JOIN products p ON p.id = s.product_id JOIN locations l ON l.id = s.location_id
           ${where} ORDER BY p.name, l.name LIMIT $${params.length}`,
        params,
      ),
    );
  });

  r.get('/movements', requirePermission('stock.view'), async (req, res) => {
    const q = parse(
      z.object({
        locationId: z.uuid(),
        productId: z.uuid().optional(),
        from: z.iso.date().optional(),
        to: z.iso.date().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(200),
      }),
      req.query,
    );
    assertPermission(req, 'stock.view', q.locationId);
    const params: unknown[] = [q.locationId];
    let where = 'WHERE m.location_id = $1';
    if (q.productId) {
      params.push(q.productId);
      where += ` AND m.product_id = $${params.length}`;
    }
    if (q.from) {
      params.push(q.from);
      where += ` AND m.occurred_at >= ($${params.length}::date AT TIME ZONE '${ctx.config.BUSINESS_TZ}')`;
    }
    if (q.to) {
      params.push(q.to);
      where += ` AND m.occurred_at < (($${params.length}::date + 1) AT TIME ZONE '${ctx.config.BUSINESS_TZ}')`;
    }
    params.push(q.limit);
    res.json(
      await many(
        ctx.db,
        `SELECT m.id, m.occurred_at AS "occurredAt", m.movement_type AS "movementType", m.qty_delta AS "qtyDelta",
                m.unit_cost AS "unitCost", m.ref_type AS "refType", m.ref_id AS "refId", m.reason,
                p.sku, p.name AS "productName", u.full_name AS "userName"
           FROM stock_movements m JOIN products p ON p.id = m.product_id LEFT JOIN users u ON u.id = m.user_id
           ${where} ORDER BY m.occurred_at DESC, m.id DESC LIMIT $${params.length}`,
        params,
      ),
    );
  });

  /** Opening stock entered centrally; devices at the location receive it through pull. */
  r.post('/stock/opening', async (req, res) => {
    const body = parse(openingStockSchema, req.body);
    const user = assertPermission(req, 'stock.opening', body.locationId);
    const adjustmentId = uuidv7();
    await withTransaction(ctx.db, async (tx) => {
      const no = await nextCentralNumber(tx, 'OPN');
      const now = new Date().toISOString();
      await tx.query(
        `INSERT INTO stock_adjustments (id, adjustment_no, location_id, kind, reason, notes, user_id, occurred_at)
         VALUES ($1,$2,$3,'OPENING','OPENING','Entered centrally',$4,$5)`,
        [adjustmentId, no, body.locationId, user.id, now],
      );
      for (const l of body.lines) {
        const lineId = uuidv7();
        await tx.query('INSERT INTO stock_adjustment_lines (id, adjustment_id, product_id, qty_delta, unit_cost) VALUES ($1,$2,$3,$4,$5)', [
          lineId, adjustmentId, l.productId, l.qty, l.unitCost,
        ]);
        await applyMovement(tx, {
          id: lineId,
          locationId: body.locationId,
          productId: l.productId,
          qtyDelta: l.qty,
          movementType: 'OPENING',
          refType: 'ADJUSTMENT',
          refId: adjustmentId,
          unitCost: l.unitCost,
          reason: 'OPENING',
          userId: user.id,
          occurredAt: now,
        });
      }
      await audit(tx, { userId: user.id, locationId: body.locationId, action: 'stock.opening', entityType: 'adjustment', entityId: adjustmentId, details: { lines: body.lines.length }, ip: req.ip });
    });
    res.status(201).json({ id: adjustmentId });
  });

  // ---------------- Transfers ----------------
  r.get('/transfers', requirePermission('transfers.view'), async (req, res) => {
    const q = parse(z.object({ locationId: z.uuid().optional(), status: z.enum(TRANSFER_STATUSES).optional() }), req.query);
    const params: unknown[] = [];
    let where = 'WHERE true';
    const filter = locationFilter(req, q.locationId);
    if (filter) {
      params.push(filter);
      where += ` AND (t.source_location_id = ANY($1::uuid[]) OR t.dest_location_id = ANY($1::uuid[]))`;
    }
    if (q.status) {
      params.push(q.status);
      where += ` AND t.status = $${params.length}`;
    }
    res.json(
      await many(
        ctx.db,
        `SELECT ${TRANSFER_COLS}, sl.name AS "sourceName", dl.name AS "destName"
           FROM stock_transfers t JOIN locations sl ON sl.id = t.source_location_id JOIN locations dl ON dl.id = t.dest_location_id
           ${where} ORDER BY t.created_at DESC LIMIT 500`,
        params,
      ),
    );
  });

  r.get('/transfers/:id', requirePermission('transfers.view'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const t = await getTransfer(ctx.db, id);
    if (!t) throw notFound('Transfer');
    const u = req.user!;
    if (!u.allLocations && !u.locationIds.includes(t.sourceLocationId) && !u.locationIds.includes(t.destLocationId)) throw forbidden();
    const history = await many(
      ctx.db,
      `SELECT h.action, h.from_status AS "fromStatus", h.to_status AS "toStatus", h.details, h.occurred_at AS "occurredAt",
              u.full_name AS "userName", l.name AS "locationName"
         FROM transfer_history h LEFT JOIN users u ON u.id = h.user_id LEFT JOIN locations l ON l.id = h.location_id
        WHERE h.transfer_id = $1 ORDER BY h.id`,
      [id],
    );
    res.json({ ...t, history });
  });

  // ---------------- Reconciliation ----------------
  r.get('/reconciliation', requirePermission('transfers.view'), async (req, res) => {
    const q = parse(
      z.object({ status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'), type: z.enum(RECONCILIATION_TYPES).optional(), locationId: z.uuid().optional() }),
      req.query,
    );
    const params: unknown[] = [q.status];
    let where = 'WHERE r.status = $1' + locClause('r.location_id', locationFilter(req, q.locationId), params);
    if (q.type) {
      params.push(q.type);
      where += ` AND r.type = $${params.length}`;
    }
    res.json(
      await many(
        ctx.db,
        `SELECT r.id, r.type, r.status, r.location_id AS "locationId", l.name AS "locationName", r.product_id AS "productId",
                p.name AS "productName", p.sku, r.ref_type AS "refType", r.ref_id AS "refId", r.qty, r.details,
                r.resolution, r.resolution_note AS "resolutionNote", r.resolved_at AS "resolvedAt", r.created_at AS "createdAt",
                t.transfer_no AS "transferNo"
           FROM reconciliation_items r LEFT JOIN locations l ON l.id = r.location_id LEFT JOIN products p ON p.id = r.product_id
           LEFT JOIN stock_transfers t ON r.ref_type = 'TRANSFER' AND t.id = r.ref_id
           ${where} ORDER BY r.created_at DESC LIMIT 500`,
        params,
      ),
    );
  });

  r.post('/reconciliation/:id/resolve', requirePermission('transfers.resolve'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({
        resolution: z.enum(['ACKNOWLEDGED', 'WRITE_OFF', 'RETURN_TO_SOURCE', 'FOUND_AT_DESTINATION']),
        note: z.string().trim().min(3).max(500),
      }),
      req.body,
    );
    await withTransaction(ctx.db, async (tx) => {
      const item = await one(tx, 'SELECT * FROM reconciliation_items WHERE id = $1 FOR UPDATE', [id]);
      if (!item) throw notFound('Reconciliation item');
      if (item.status !== 'OPEN') throw conflict('Item is already resolved');
      const isDiscrepancy = item.type === 'TRANSFER_DISCREPANCY';
      if (!isDiscrepancy && body.resolution !== 'ACKNOWLEDGED') throw badRequest('This item can only be acknowledged');
      if (isDiscrepancy && body.resolution === 'ACKNOWLEDGED') throw badRequest('Choose write-off, return to source or found at destination');
      if (isDiscrepancy && body.resolution !== 'WRITE_OFF') {
        const t = await one(tx, 'SELECT source_location_id, dest_location_id FROM stock_transfers WHERE id = $1', [item.ref_id]);
        const target = body.resolution === 'RETURN_TO_SOURCE' ? t.source_location_id : t.dest_location_id;
        const cost = await one<{ c: number }>(
          tx,
          `SELECT coalesce((SELECT unit_cost FROM stock_movements WHERE ref_type = 'TRANSFER' AND ref_id = $1 AND product_id = $2 AND qty_delta < 0 ORDER BY occurred_at DESC LIMIT 1), 0) AS c`,
          [item.ref_id, item.product_id],
        );
        // Central movement (device_id NULL); the target location's devices pick it up on pull.
        await applyMovement(tx, {
          id: uuidv7(),
          locationId: target,
          productId: item.product_id,
          qtyDelta: item.qty,
          movementType: body.resolution === 'RETURN_TO_SOURCE' ? 'TRANSFER_RESOLUTION' : 'TRANSFER_IN',
          refType: 'TRANSFER',
          refId: item.ref_id,
          unitCost: cost!.c,
          reason: body.resolution,
          userId: req.user!.id,
          occurredAt: new Date().toISOString(),
        });
      }
      await tx.query(
        `UPDATE reconciliation_items SET status = 'RESOLVED', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`,
        [id, body.resolution, body.note, req.user!.id],
      );
      await audit(tx, { userId: req.user!.id, locationId: item.location_id, action: 'reconciliation.resolve', entityType: 'reconciliation', entityId: id, details: body, ip: req.ip });
    });
    res.json({ ok: true });
  });

  return r;
}
