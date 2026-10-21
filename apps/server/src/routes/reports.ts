import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { many, one } from '../db/pool.js';
import { requirePermission, requireUser } from '../middleware/auth.js';
import { dateRangeQuery, defaultRange, locClause, locationFilter, parse } from './util.js';

/**
 * Consolidated reports across warehouses and branches. Every query is scoped to
 * the locations the user may see; company admins see everything.
 */
export function reportRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx), requirePermission('reports.view'));
  const tz = ctx.config.BUSINESS_TZ;

  /** Builds params + WHERE for a time range on `col` and a location column. */
  const scope = (req: Parameters<Parameters<typeof r.get>[1]>[0], q: { from?: string; to?: string; locationId?: string }, timeCol: string, locCol: string) => {
    const { from, to } = defaultRange(q);
    const params: unknown[] = [from, to, tz];
    const where = `${timeCol} >= ($1::date AT TIME ZONE $3) AND ${timeCol} < (($2::date + 1) AT TIME ZONE $3)` +
      locClause(locCol, locationFilter(req, q.locationId), params);
    return { params, where, from, to };
  };

  r.get('/dashboard', async (req, res) => {
    const q = parse(dateRangeQuery, req.query);
    const s = scope(req, q, 's.occurred_at', 's.location_id');
    const filter = locationFilter(req, q.locationId);
    const lp: unknown[] = [];
    const stockLoc = locClause('st.location_id', filter, lp);

    const [salesTotals, returnsTotals, purchaseTotals, byDay, byBranch, stockByLocation, lowStock, pendingTransfers, openRecon, sync] =
      await Promise.all([
        one(
          ctx.db,
          `SELECT coalesce(sum(s.grand_total),0) AS total, count(*)::int AS invoices,
                  coalesce(sum(s.cgst_total + s.sgst_total + s.igst_total),0) AS tax
             FROM sales s WHERE ${s.where}`,
          s.params,
        ),
        one(ctx.db, `SELECT coalesce(sum(s.refund_total),0) AS total, count(*)::int AS count FROM sale_returns s WHERE ${s.where}`, s.params),
        one(ctx.db, `SELECT coalesce(sum(s.grand_total),0) AS total, count(*)::int AS count FROM goods_receipts s WHERE ${s.where}`, s.params),
        many(
          ctx.db,
          `SELECT to_char((s.occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day, sum(s.grand_total) AS total, count(*)::int AS invoices
             FROM sales s WHERE ${s.where} GROUP BY 1 ORDER BY 1`,
          s.params,
        ),
        many(
          ctx.db,
          `SELECT l.id AS "locationId", l.name, coalesce(sum(s.grand_total),0) AS total, count(s.id)::int AS invoices
             FROM sales s JOIN locations l ON l.id = s.location_id WHERE ${s.where} GROUP BY l.id, l.name ORDER BY total DESC`,
          s.params,
        ),
        many(
          ctx.db,
          `SELECT l.id AS "locationId", l.name, l.type, coalesce(sum(st.qty_on_hand),0) AS qty,
                  coalesce(sum(greatest(st.qty_on_hand,0) * st.avg_cost),0) AS value
             FROM locations l LEFT JOIN stock_levels st ON st.location_id = l.id
            WHERE l.is_active ${filter ? 'AND l.id = ANY($1::uuid[])' : ''}
            GROUP BY l.id ORDER BY l.type DESC, l.name`,
          lp,
        ),
        one(
          ctx.db,
          `SELECT count(*)::int AS n FROM stock_levels st JOIN products p ON p.id = st.product_id
            WHERE p.is_active AND st.qty_on_hand <= greatest(p.reorder_level, (SELECT default_low_stock_level FROM company)) ${stockLoc}`,
          lp,
        ),
        many(
          ctx.db,
          `SELECT t.status, count(*)::int AS n FROM stock_transfers t
            WHERE t.status NOT IN ('REJECTED','CANCELLED','RECEIVED','CLOSED_WITH_DISCREPANCY')
            ${filter ? `AND (t.source_location_id = ANY($1::uuid[]) OR t.dest_location_id = ANY($1::uuid[]))` : ''}
            GROUP BY t.status`,
          filter ? [filter] : [],
        ),
        one(
          ctx.db,
          `SELECT count(*)::int AS n FROM reconciliation_items WHERE status = 'OPEN' ${filter ? 'AND location_id = ANY($1::uuid[])' : ''}`,
          filter ? [filter] : [],
        ),
        one(
          ctx.db,
          `SELECT coalesce(sum(d.pending_reported),0)::int AS pending,
                  (SELECT count(*)::int FROM sync_inbox i WHERE i.status = 'REJECTED' ${filter ? 'AND i.location_id = ANY($1::uuid[])' : ''}) AS rejected,
                  count(*) FILTER (WHERE d.last_seen_at < now() - interval '1 hour' OR d.last_seen_at IS NULL)::int AS "offlineDevices",
                  count(*)::int AS devices
             FROM devices d WHERE d.is_active ${filter ? 'AND d.location_id = ANY($1::uuid[])' : ''}`,
          filter ? [filter] : [],
        ),
      ]);

    res.json({
      range: { from: s.from, to: s.to },
      sales: salesTotals,
      returns: returnsTotals,
      purchases: purchaseTotals,
      salesByDay: byDay,
      salesByBranch: byBranch,
      stockByLocation,
      totalStock: {
        qty: stockByLocation.reduce((a: number, x: any) => a + Number(x.qty), 0),
        value: stockByLocation.reduce((a: number, x: any) => a + Number(x.value), 0),
      },
      lowStockCount: lowStock?.n ?? 0,
      pendingTransfers,
      openReconciliation: openRecon?.n ?? 0,
      sync,
    });
  });

  r.get('/sales', requirePermission('sales.view'), async (req, res) => {
    const q = parse(dateRangeQuery.extend({ groupBy: z.enum(['day', 'location', 'product', 'payment', 'user', 'invoice']).default('day') }), req.query);
    const s = scope(req, q, 's.occurred_at', 's.location_id');
    let sql: string;
    switch (q.groupBy) {
      case 'day':
        sql = `SELECT to_char((s.occurred_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS key, count(*)::int AS invoices,
                      sum(s.taxable_total) AS taxable, sum(s.cgst_total + s.sgst_total + s.igst_total) AS tax,
                      sum(s.discount_total) AS discount, sum(s.grand_total) AS total
                 FROM sales s WHERE ${s.where} GROUP BY 1 ORDER BY 1`;
        break;
      case 'location':
        sql = `SELECT l.name AS key, count(*)::int AS invoices, sum(s.taxable_total) AS taxable,
                      sum(s.cgst_total + s.sgst_total + s.igst_total) AS tax, sum(s.discount_total) AS discount, sum(s.grand_total) AS total
                 FROM sales s JOIN locations l ON l.id = s.location_id WHERE ${s.where} GROUP BY l.name ORDER BY total DESC`;
        break;
      case 'user':
        sql = `SELECT u.full_name AS key, count(*)::int AS invoices, sum(s.taxable_total) AS taxable,
                      sum(s.cgst_total + s.sgst_total + s.igst_total) AS tax, sum(s.discount_total) AS discount, sum(s.grand_total) AS total
                 FROM sales s JOIN users u ON u.id = s.user_id WHERE ${s.where} GROUP BY u.full_name ORDER BY total DESC`;
        break;
      case 'payment':
        sql = `SELECT p.method AS key, count(DISTINCT s.id)::int AS invoices,
                      sum(p.amount) FILTER (WHERE p.ref_type = 'SALE') AS collected,
                      coalesce(sum(p.amount) FILTER (WHERE p.ref_type = 'SALE_RETURN'), 0) AS refunded
                 FROM payments p JOIN (SELECT id, occurred_at, location_id FROM sales UNION ALL SELECT id, occurred_at, location_id FROM sale_returns) s
                   ON s.id = p.ref_id WHERE ${s.where} GROUP BY p.method ORDER BY 1`;
        break;
      case 'product':
        sql = `SELECT sl.sku AS key, max(sl.name) AS name, sum(sl.qty)::int AS qty, sum(sl.qty_returned)::int AS "qtyReturned",
                      sum(sl.taxable_value) AS taxable, sum(sl.line_total) AS total,
                      sum(sl.taxable_value) - coalesce(sum(m.unit_cost * sl.qty), 0) AS margin
                 FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id LEFT JOIN stock_movements m ON m.id = sl.id
                WHERE ${s.where} GROUP BY sl.sku ORDER BY total DESC LIMIT 500`;
        break;
      case 'invoice':
        sql = `SELECT s.id, s.invoice_no AS key, s.occurred_at AS "occurredAt", l.name AS "locationName", c.name AS "customerName",
                      s.taxable_total AS taxable, s.cgst_total + s.sgst_total + s.igst_total AS tax, s.grand_total AS total,
                      (SELECT coalesce(sum(r.refund_total),0) FROM sale_returns r WHERE r.sale_id = s.id) AS refunded
                 FROM sales s JOIN locations l ON l.id = s.location_id LEFT JOIN customers c ON c.id = s.customer_id
                WHERE ${s.where} ORDER BY s.occurred_at DESC LIMIT 1000`;
        break;
    }
    res.json({ range: { from: s.from, to: s.to }, rows: await many(ctx.db, sql, s.params) });
  });

  /** GSTR-1 style outward supply summary: sales less returns, by rate and B2B/B2C, plus HSN summary. */
  r.get('/gst', requirePermission('reports.gst'), async (req, res) => {
    const q = parse(dateRangeQuery, req.query);
    const s = scope(req, q, 'x.occurred_at', 'x.location_id');
    const base = `
      SELECT x.*, CASE WHEN c.gstin IS NOT NULL THEN 'B2B' ELSE 'B2C' END AS supply_type FROM (
        SELECT s.occurred_at, s.location_id, s.customer_id, sl.gst_rate_bp, sl.hsn_code, sl.qty,
               sl.taxable_value, sl.cgst, sl.sgst, sl.igst
          FROM sale_lines sl JOIN sales s ON s.id = sl.sale_id
        UNION ALL
        SELECT r.occurred_at, r.location_id, s.customer_id, sl.gst_rate_bp, sl.hsn_code, -rl.qty,
               -rl.taxable_value, -rl.cgst, -rl.sgst, -rl.igst
          FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id
          JOIN sale_lines sl ON sl.id = rl.sale_line_id JOIN sales s ON s.id = r.sale_id
      ) x LEFT JOIN customers c ON c.id = x.customer_id WHERE ${s.where}`;
    const [byRate, byHsn, byLocation] = await Promise.all([
      many(
        ctx.db,
        `SELECT supply_type AS "supplyType", gst_rate_bp AS "rateBp", sum(taxable_value) AS taxable, sum(cgst) AS cgst,
                sum(sgst) AS sgst, sum(igst) AS igst FROM (${base}) g GROUP BY 1, 2 ORDER BY 1, 2`,
        s.params,
      ),
      many(
        ctx.db,
        `SELECT coalesce(hsn_code, 'NA') AS hsn, gst_rate_bp AS "rateBp", sum(qty)::int AS qty, sum(taxable_value) AS taxable,
                sum(cgst) AS cgst, sum(sgst) AS sgst, sum(igst) AS igst FROM (${base}) g GROUP BY 1, 2 ORDER BY 1, 2`,
        s.params,
      ),
      many(
        ctx.db,
        `SELECT l.name AS location, l.gstin, sum(taxable_value) AS taxable, sum(cgst) AS cgst, sum(sgst) AS sgst, sum(igst) AS igst
           FROM (${base}) g JOIN locations l ON l.id = g.location_id GROUP BY l.name, l.gstin ORDER BY 1`,
        s.params,
      ),
    ]);
    // Input tax from purchases (net of purchase returns) for the same period.
    const sp = scope(req, q, 'g.occurred_at', 'g.location_id');
    const inputTax = await one(
      ctx.db,
      `SELECT coalesce(sum(taxable_total),0) AS taxable, coalesce(sum(tax_total),0) AS tax FROM (
         SELECT occurred_at, location_id, taxable_total, tax_total FROM goods_receipts
         UNION ALL SELECT occurred_at, location_id, -taxable_total, -tax_total FROM purchase_returns) g WHERE ${sp.where}`,
      sp.params,
    );
    res.json({ range: { from: s.from, to: s.to }, byRate, byHsn, byLocation, inputTax });
  });

  r.get('/stock-valuation', requirePermission('stock.view'), async (req, res) => {
    const q = parse(z.object({ locationId: z.uuid().optional() }), req.query);
    const params: unknown[] = [];
    const where = 'WHERE true' + locClause('st.location_id', locationFilter(req, q.locationId), params);
    const [byLocation, byCategory] = await Promise.all([
      many(
        ctx.db,
        `SELECT l.name AS location, l.type, count(*) FILTER (WHERE st.qty_on_hand <> 0)::int AS skus, sum(st.qty_on_hand)::bigint AS qty,
                sum(greatest(st.qty_on_hand,0) * st.avg_cost) AS "costValue", sum(greatest(st.qty_on_hand,0) * p.selling_price) AS "retailValue"
           FROM stock_levels st JOIN locations l ON l.id = st.location_id JOIN products p ON p.id = st.product_id
           ${where} GROUP BY l.name, l.type ORDER BY l.type DESC, l.name`,
        params,
      ),
      many(
        ctx.db,
        `SELECT coalesce(c.name, 'Uncategorised') AS category, sum(st.qty_on_hand)::bigint AS qty,
                sum(greatest(st.qty_on_hand,0) * st.avg_cost) AS "costValue"
           FROM stock_levels st JOIN products p ON p.id = st.product_id LEFT JOIN categories c ON c.id = p.category_id
           ${where} GROUP BY 1 ORDER BY 3 DESC`,
        params,
      ),
    ]);
    res.json({ byLocation, byCategory });
  });

  r.get('/purchases', requirePermission('purchase.view'), async (req, res) => {
    const q = parse(dateRangeQuery, req.query);
    const s = scope(req, q, 'g.occurred_at', 'g.location_id');
    const [bySupplier, byLocation] = await Promise.all([
      many(
        ctx.db,
        `SELECT sp.name AS key, count(*)::int AS grns, sum(g.taxable_total) AS taxable, sum(g.tax_total) AS tax, sum(g.grand_total) AS total
           FROM goods_receipts g JOIN suppliers sp ON sp.id = g.supplier_id WHERE ${s.where} GROUP BY sp.name ORDER BY total DESC`,
        s.params,
      ),
      many(
        ctx.db,
        `SELECT l.name AS key, count(*)::int AS grns, sum(g.taxable_total) AS taxable, sum(g.tax_total) AS tax, sum(g.grand_total) AS total
           FROM goods_receipts g JOIN locations l ON l.id = g.location_id WHERE ${s.where} GROUP BY l.name ORDER BY total DESC`,
        s.params,
      ),
    ]);
    res.json({ range: { from: s.from, to: s.to }, bySupplier, byLocation });
  });

  r.get('/transfers', requirePermission('transfers.view'), async (req, res) => {
    const q = parse(dateRangeQuery, req.query);
    const { from, to } = defaultRange(q);
    const filter = locationFilter(req, q.locationId);
    const params: unknown[] = [from, to, tz];
    let where = `t.created_at >= ($1::date AT TIME ZONE $3) AND t.created_at < (($2::date + 1) AT TIME ZONE $3)`;
    if (filter) {
      params.push(filter);
      where += ` AND (t.source_location_id = ANY($4::uuid[]) OR t.dest_location_id = ANY($4::uuid[]))`;
    }
    res.json({
      range: { from, to },
      rows: await many(
        ctx.db,
        `SELECT t.id, t.transfer_no AS "transferNo", t.status, t.created_at AS "createdAt", sl.name AS source, sl.type AS "sourceType",
                dl.name AS destination, dl.type AS "destType",
                sum(tl.qty_requested)::int AS requested, sum(tl.qty_approved)::int AS approved, sum(tl.qty_dispatched)::int AS dispatched,
                sum(tl.qty_received)::int AS received, sum(tl.qty_damaged)::int AS damaged
           FROM stock_transfers t JOIN transfer_lines tl ON tl.transfer_id = t.id
           JOIN locations sl ON sl.id = t.source_location_id JOIN locations dl ON dl.id = t.dest_location_id
          WHERE ${where} GROUP BY t.id, sl.name, sl.type, dl.name, dl.type ORDER BY t.created_at DESC`,
        params,
      ),
    });
  });

  r.get('/returns', requirePermission('sales.view'), async (req, res) => {
    const q = parse(dateRangeQuery, req.query);
    const s = scope(req, q, 'r.occurred_at', 'r.location_id');
    res.json({
      range: { from: s.from, to: s.to },
      rows: await many(
        ctx.db,
        `SELECT r.id, r.return_no AS "returnNo", r.occurred_at AS "occurredAt", s.invoice_no AS "invoiceNo", l.name AS "locationName",
                r.reason, r.refund_total AS "refundTotal", u.full_name AS "userName",
                (SELECT sum(rl.qty)::int FROM sale_return_lines rl WHERE rl.return_id = r.id) AS qty,
                (SELECT sum(rl.qty)::int FROM sale_return_lines rl WHERE rl.return_id = r.id AND rl.restock) AS "qtyRestocked"
           FROM sale_returns r JOIN sales s ON s.id = r.sale_id JOIN locations l ON l.id = r.location_id JOIN users u ON u.id = r.user_id
          WHERE ${s.where} ORDER BY r.occurred_at DESC LIMIT 1000`,
        s.params,
      ),
    });
  });

  return r;
}
