import { Router } from 'express';
import { z } from 'zod';
import { PO_STATUSES, purchaseOrderInputSchema } from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one, withTransaction } from '../db/pool.js';
import { assertPermission, requirePermission, requireUser } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { nextCentralNumber } from '../services/numbering.js';
import { PO_COLS, getPurchaseOrder } from '../services/rows.js';
import { locClause, locationFilter, parse, uuidParam } from './util.js';

export function purchaseRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx));

  r.get('/purchase-orders', requirePermission('purchase.view'), async (req, res) => {
    const q = parse(
      z.object({ locationId: z.uuid().optional(), status: z.enum(PO_STATUSES).optional(), supplierId: z.uuid().optional() }),
      req.query,
    );
    const params: unknown[] = [];
    let where = 'WHERE true' + locClause('po.location_id', locationFilter(req, q.locationId), params);
    if (q.status) {
      params.push(q.status);
      where += ` AND po.status = $${params.length}`;
    }
    if (q.supplierId) {
      params.push(q.supplierId);
      where += ` AND po.supplier_id = $${params.length}`;
    }
    res.json(
      await many(
        ctx.db,
        `SELECT ${PO_COLS}, s.name AS "supplierName", l.name AS "locationName",
                (SELECT coalesce(sum(pl.qty * pl.unit_cost), 0) FROM purchase_order_lines pl WHERE pl.purchase_order_id = po.id) AS "taxableTotal"
           FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN locations l ON l.id = po.location_id
           ${where} ORDER BY po.created_at DESC LIMIT 500`,
        params,
      ),
    );
  });

  r.get('/purchase-orders/:id', requirePermission('purchase.view'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const po = await getPurchaseOrder(ctx.db, id);
    if (!po) throw notFound('Purchase order');
    assertPermission(req, 'purchase.view', po.locationId);
    res.json(po);
  });

  r.post('/purchase-orders', async (req, res) => {
    const po = parse(purchaseOrderInputSchema, req.body);
    const user = assertPermission(req, 'purchase.order', po.locationId);
    const loc = await one<{ canReceive: boolean; isActive: boolean }>(
      ctx.db,
      'SELECT can_receive_purchases AS "canReceive", is_active AS "isActive" FROM locations WHERE id = $1',
      [po.locationId],
    );
    if (!loc) throw notFound('Location');
    if (!loc.canReceive || !loc.isActive) throw badRequest('This location is not authorised to receive supplier purchases');
    if (new Set(po.lines.map((l) => l.productId)).size !== po.lines.length) throw badRequest('Each product may appear only once');
    await withTransaction(ctx.db, async (tx) => {
      const poNo = await nextCentralNumber(tx, 'PO');
      await tx.query(
        `INSERT INTO purchase_orders (id, po_no, supplier_id, location_id, status, expected_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [po.id, poNo, po.supplierId, po.locationId, po.status, po.expectedDate, po.notes, user.id],
      );
      for (const l of po.lines) {
        await tx.query(
          `INSERT INTO purchase_order_lines (id, purchase_order_id, product_id, qty, unit_cost, gst_rate_bp) VALUES ($1,$2,$3,$4,$5,$6)`,
          [l.id, po.id, l.productId, l.qty, l.unitCost, l.gstRateBp],
        );
      }
      await audit(tx, { userId: user.id, locationId: po.locationId, action: 'purchase_order.create', entityType: 'purchase_order', entityId: po.id, details: { poNo }, ip: req.ip });
    });
    res.status(201).json(await getPurchaseOrder(ctx.db, po.id));
  });

  /** DRAFT → ORDERED, or cancel an order that has not been received against. */
  r.post('/purchase-orders/:id/status', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { status } = parse(z.object({ status: z.enum(['ORDERED', 'CANCELLED']) }), req.body);
    const po = await getPurchaseOrder(ctx.db, id);
    if (!po) throw notFound('Purchase order');
    const user = assertPermission(req, 'purchase.order', po.locationId);
    if (status === 'ORDERED' && po.status !== 'DRAFT') throw conflict('Only draft orders can be placed');
    if (status === 'CANCELLED') {
      if (!['DRAFT', 'ORDERED'].includes(po.status)) throw conflict('Orders with receipts cannot be cancelled');
      const received = po.lines.some((l) => l.qtyReceived > 0);
      if (received) throw conflict('Orders with receipts cannot be cancelled');
    }
    await ctx.db.query('UPDATE purchase_orders SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
    await audit(ctx.db, { userId: user.id, locationId: po.locationId, action: `purchase_order.${status.toLowerCase()}`, entityType: 'purchase_order', entityId: id, ip: req.ip });
    res.json(await getPurchaseOrder(ctx.db, id));
  });

  r.get('/grns', requirePermission('purchase.view'), async (req, res) => {
    const q = parse(z.object({ locationId: z.uuid().optional(), supplierId: z.uuid().optional() }), req.query);
    const params: unknown[] = [];
    let where = 'WHERE true' + locClause('g.location_id', locationFilter(req, q.locationId), params);
    if (q.supplierId) {
      params.push(q.supplierId);
      where += ` AND g.supplier_id = $${params.length}`;
    }
    res.json(
      await many(
        ctx.db,
        `SELECT g.id, g.grn_no AS "grnNo", g.occurred_at AS "occurredAt", g.supplier_invoice_no AS "supplierInvoiceNo",
                g.supplier_invoice_date AS "supplierInvoiceDate", g.taxable_total AS "taxableTotal", g.tax_total AS "taxTotal",
                g.grand_total AS "grandTotal", s.name AS "supplierName", l.name AS "locationName", po.po_no AS "poNo"
           FROM goods_receipts g JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id
           LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
           ${where} ORDER BY g.occurred_at DESC LIMIT 500`,
        params,
      ),
    );
  });

  r.get('/grns/:id', requirePermission('purchase.view'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const grn = await one(
      ctx.db,
      `SELECT g.*, s.name AS supplier_name, l.name AS location_name FROM goods_receipts g
         JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id WHERE g.id = $1`,
      [id],
    );
    if (!grn) throw notFound('GRN');
    assertPermission(req, 'purchase.view', grn.location_id);
    const lines = await many(
      ctx.db,
      `SELECT gl.*, p.name AS product_name, p.sku FROM goods_receipt_lines gl JOIN products p ON p.id = gl.product_id WHERE gl.grn_id = $1`,
      [id],
    );
    res.json({ ...grn, lines });
  });

  return r;
}
