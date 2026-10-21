import type { DB } from '../db/connection';
import { outboxCounts } from './outbox';
import { getSettings } from './meta';

/** Local (this location) reports — always available offline. Dates are local-time YYYY-MM-DD. */

const range = (from?: string, to?: string) => {
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { from: from ?? iso(new Date(today.getTime() - 29 * 86400_000)), to: to ?? iso(today) };
};

export function localDashboard(db: DB, locationId: string) {
  const today = db
    .prepare(
      `SELECT count(*) AS invoices, coalesce(sum(grand_total),0) AS total FROM sales
        WHERE date(occurred_at, 'localtime') = date('now', 'localtime')`,
    )
    .get() as { invoices: number; total: number };
  const todayReturns = db
    .prepare(`SELECT coalesce(sum(refund_total),0) AS total FROM sale_returns WHERE date(occurred_at, 'localtime') = date('now', 'localtime')`)
    .get() as { total: number };
  const week = db
    .prepare(`SELECT coalesce(sum(grand_total),0) AS total FROM sales WHERE date(occurred_at, 'localtime') > date('now', 'localtime', '-7 day')`)
    .get() as { total: number };
  const month = db
    .prepare(`SELECT coalesce(sum(grand_total),0) AS total FROM sales WHERE date(occurred_at, 'localtime') > date('now', 'localtime', '-30 day')`)
    .get() as { total: number };
  const purchasesMonth = db
    .prepare(`SELECT coalesce(sum(grand_total),0) AS total FROM goods_receipts WHERE date(occurred_at, 'localtime') > date('now', 'localtime', '-30 day')`)
    .get() as { total: number };
  const salesByDay = db
    .prepare(
      `SELECT date(occurred_at, 'localtime') AS day, sum(grand_total) AS total, count(*) AS invoices FROM sales
        WHERE date(occurred_at, 'localtime') > date('now', 'localtime', '-30 day') GROUP BY 1 ORDER BY 1`,
    )
    .all();
  const byPayment = db
    .prepare(
      `SELECT p.method, sum(p.amount) AS total FROM payments p JOIN sales s ON p.ref_type = 'SALE' AND s.id = p.ref_id
        WHERE date(s.occurred_at, 'localtime') = date('now', 'localtime') GROUP BY p.method`,
    )
    .all();
  const settings = getSettings(db);
  const stock = db
    .prepare(
      `SELECT coalesce(sum(s.qty_on_hand),0) AS qty, coalesce(sum(max(s.qty_on_hand,0) * coalesce(nullif(s.avg_cost,0), p.purchase_price)),0) AS value,
              coalesce(sum(CASE WHEN p.is_active = 1 AND s.qty_on_hand <= max(p.reorder_level, ?) THEN 1 ELSE 0 END),0) AS lowCount
         FROM stock_levels s JOIN products p ON p.id = s.product_id WHERE s.location_id = ?`,
    )
    .get(settings.defaultLowStockLevel, locationId) as { qty: number; value: number; lowCount: number };
  const transfers = db
    .prepare(
      `SELECT
         sum(CASE WHEN source_location_id = @loc AND status = 'REQUESTED' THEN 1 ELSE 0 END) AS toApprove,
         sum(CASE WHEN source_location_id = @loc AND status IN ('APPROVED','PARTIALLY_DISPATCHED') THEN 1 ELSE 0 END) AS toDispatch,
         sum(CASE WHEN dest_location_id = @loc AND status IN ('DISPATCHED','PARTIALLY_DISPATCHED','PARTIALLY_RECEIVED') THEN 1 ELSE 0 END) AS toReceive,
         sum(CASE WHEN dest_location_id = @loc AND status IN ('REQUESTED','APPROVED') THEN 1 ELSE 0 END) AS awaiting
       FROM stock_transfers`,
    )
    .get({ loc: locationId }) as Record<string, number | null>;
  const topProducts = db
    .prepare(
      `SELECT l.name, sum(l.qty) AS qty, sum(l.line_total) AS total FROM sale_lines l JOIN sales s ON s.id = l.sale_id
        WHERE date(s.occurred_at, 'localtime') > date('now', 'localtime', '-30 day') GROUP BY l.product_id ORDER BY total DESC LIMIT 5`,
    )
    .all();
  return {
    today: { ...today, returns: todayReturns.total },
    week: week.total,
    month: month.total,
    purchasesMonth: purchasesMonth.total,
    salesByDay,
    byPayment,
    stock,
    transfers: Object.fromEntries(Object.entries(transfers).map(([k, v]) => [k, v ?? 0])),
    topProducts,
    sync: outboxCounts(db),
  };
}

export function localSalesReport(db: DB, q: { from?: string; to?: string; groupBy: 'day' | 'product' | 'payment' | 'user' | 'hsn' }) {
  const { from, to } = range(q.from, q.to);
  const where = `date(s.occurred_at, 'localtime') BETWEEN ? AND ?`;
  let sql: string;
  switch (q.groupBy) {
    case 'day':
      sql = `SELECT date(s.occurred_at, 'localtime') AS key, count(*) AS invoices, sum(s.taxable_total) AS taxable,
                    sum(s.cgst_total + s.sgst_total + s.igst_total) AS tax, sum(s.discount_total) AS discount, sum(s.grand_total) AS total
               FROM sales s WHERE ${where} GROUP BY 1 ORDER BY 1`;
      break;
    case 'product':
      sql = `SELECT l.sku AS key, max(l.name) AS name, sum(l.qty) AS qty, sum(l.qty_returned) AS qtyReturned, sum(l.taxable_value) AS taxable,
                    sum(l.line_total) AS total, sum(l.taxable_value) - sum(coalesce(m.unit_cost, 0) * l.qty) AS margin
               FROM sale_lines l JOIN sales s ON s.id = l.sale_id LEFT JOIN stock_movements m ON m.id = l.id
              WHERE ${where} GROUP BY l.sku ORDER BY total DESC`;
      break;
    case 'payment':
      sql = `SELECT p.method AS key, sum(CASE WHEN p.ref_type = 'SALE' THEN p.amount ELSE 0 END) AS collected,
                    sum(CASE WHEN p.ref_type = 'SALE_RETURN' THEN p.amount ELSE 0 END) AS refunded
               FROM payments p JOIN (SELECT id, occurred_at FROM sales UNION ALL SELECT id, occurred_at FROM sale_returns) s ON s.id = p.ref_id
              WHERE ${where} GROUP BY p.method ORDER BY 1`;
      break;
    case 'user':
      sql = `SELECT u.full_name AS key, count(*) AS invoices, sum(s.grand_total) AS total
               FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE ${where} GROUP BY s.user_id ORDER BY total DESC`;
      break;
    case 'hsn':
      sql = `SELECT coalesce(l.hsn_code, 'NA') AS key, l.gst_rate_bp AS rateBp, sum(l.qty) AS qty, sum(l.taxable_value) AS taxable,
                    sum(l.cgst) AS cgst, sum(l.sgst) AS sgst, sum(l.igst) AS igst
               FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`;
      break;
  }
  return { from, to, rows: db.prepare(sql).all(from, to) };
}

/** Outward GST summary for this location: sales less returns, by rate. */
export function localGstReport(db: DB, q: { from?: string; to?: string }) {
  const { from, to } = range(q.from, q.to);
  const rows = db
    .prepare(
      `SELECT rateBp, sum(taxable) AS taxable, sum(cgst) AS cgst, sum(sgst) AS sgst, sum(igst) AS igst FROM (
         SELECT l.gst_rate_bp AS rateBp, l.taxable_value AS taxable, l.cgst, l.sgst, l.igst
           FROM sale_lines l JOIN sales s ON s.id = l.sale_id WHERE date(s.occurred_at, 'localtime') BETWEEN ?1 AND ?2
         UNION ALL
         SELECT l.gst_rate_bp, -rl.taxable_value, -rl.cgst, -rl.sgst, -rl.igst
           FROM sale_return_lines rl JOIN sale_returns r ON r.id = rl.return_id JOIN sale_lines l ON l.id = rl.sale_line_id
          WHERE date(r.occurred_at, 'localtime') BETWEEN ?1 AND ?2
       ) GROUP BY rateBp ORDER BY rateBp`,
    )
    .all(from, to);
  const input = db
    .prepare(
      `SELECT coalesce(sum(taxable_total),0) AS taxable, coalesce(sum(tax_total),0) AS tax FROM (
         SELECT taxable_total, tax_total, occurred_at FROM goods_receipts
         UNION ALL SELECT -taxable_total, -tax_total, occurred_at FROM purchase_returns)
        WHERE date(occurred_at, 'localtime') BETWEEN ? AND ?`,
    )
    .get(from, to);
  return { from, to, rows, input };
}
