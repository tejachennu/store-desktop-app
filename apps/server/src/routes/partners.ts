import { Router } from 'express';
import { z } from 'zod';
import { customerInputSchema, supplierInputSchema, uuidv7 } from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one } from '../db/pool.js';
import { requirePermission, requireUser } from '../middleware/auth.js';
import { notFound } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { CUSTOMER_COLS, SUPPLIER_COLS, getCustomer, getSupplier } from '../services/rows.js';
import { locClause, locationFilter, parse, uuidParam } from './util.js';

export function partnerRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx));

  // ---------------- Suppliers ----------------
  r.get('/suppliers', requirePermission('suppliers.view'), async (req, res) => {
    const { search } = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    const params: unknown[] = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(s.name) LIKE $1 OR s.gstin ILIKE $1 OR s.phone LIKE $1`;
    }
    res.json(
      await many(
        ctx.db,
        `SELECT ${SUPPLIER_COLS},
                coalesce((SELECT sum(grand_total) FROM goods_receipts g WHERE g.supplier_id = s.id), 0)
                - coalesce((SELECT sum(grand_total) FROM purchase_returns pr WHERE pr.supplier_id = s.id), 0)
                - coalesce((SELECT sum(amount) FROM supplier_payments sp WHERE sp.supplier_id = s.id), 0) AS "balanceDue"
           FROM suppliers s ${where} ORDER BY s.name LIMIT 500`,
        params,
      ),
    );
  });

  r.post('/suppliers', requirePermission('suppliers.manage'), async (req, res) => {
    const s = parse(supplierInputSchema, req.body);
    const id = uuidv7();
    await ctx.db.query(
      `INSERT INTO suppliers (id, name, gstin, state_code, phone, email, address, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, s.name, s.gstin, s.stateCode, s.phone, s.email, s.address, s.isActive],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'supplier.create', entityType: 'supplier', entityId: id, details: s, ip: req.ip });
    res.status(201).json(await getSupplier(ctx.db, id));
  });

  r.put('/suppliers/:id', requirePermission('suppliers.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const s = parse(supplierInputSchema, req.body);
    const upd = await ctx.db.query(
      `UPDATE suppliers SET name=$2, gstin=$3, state_code=$4, phone=$5, email=$6, address=$7, is_active=$8, updated_at=now() WHERE id=$1`,
      [id, s.name, s.gstin, s.stateCode, s.phone, s.email, s.address, s.isActive],
    );
    if (upd.rowCount === 0) throw notFound('Supplier');
    await audit(ctx.db, { userId: req.user!.id, action: 'supplier.update', entityType: 'supplier', entityId: id, details: s, ip: req.ip });
    res.json(await getSupplier(ctx.db, id));
  });

  /** Supplier ledger: GRNs (credit), purchase returns and payments (debit). */
  r.get('/suppliers/:id/ledger', requirePermission('suppliers.view'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const supplier = await getSupplier(ctx.db, id);
    if (!supplier) throw notFound('Supplier');
    const entries = await many(
      ctx.db,
      `SELECT * FROM (
         SELECT 'GRN' AS kind, g.id, g.grn_no AS "docNo", g.supplier_invoice_no AS reference, g.occurred_at AS date, g.grand_total AS credit, 0 AS debit, l.name AS "locationName"
           FROM goods_receipts g JOIN locations l ON l.id = g.location_id WHERE g.supplier_id = $1
         UNION ALL
         SELECT 'PURCHASE_RETURN', pr.id, pr.return_no, pr.reason, pr.occurred_at, 0, pr.grand_total, l.name
           FROM purchase_returns pr JOIN locations l ON l.id = pr.location_id WHERE pr.supplier_id = $1
         UNION ALL
         SELECT 'PAYMENT', sp.id, sp.method, sp.reference, sp.paid_on::timestamptz, 0, sp.amount, l.name
           FROM supplier_payments sp JOIN locations l ON l.id = sp.location_id WHERE sp.supplier_id = $1
       ) x ORDER BY date`,
      [id],
    );
    let balance = 0;
    const rows = entries.map((e: any) => {
      balance += Number(e.credit) - Number(e.debit);
      return { ...e, balance };
    });
    res.json({ supplier, entries: rows, balanceDue: balance });
  });

  // ---------------- Customers ----------------
  r.get('/customers', requirePermission('customers.view'), async (req, res) => {
    const { search } = parse(z.object({ search: z.string().trim().max(100).optional() }), req.query);
    const params: unknown[] = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(c.name) LIKE $1 OR c.phone LIKE $1 OR c.gstin ILIKE $1`;
    }
    res.json(await many(ctx.db, `SELECT ${CUSTOMER_COLS} FROM customers c ${where} ORDER BY c.name LIMIT 200`, params));
  });

  r.put('/customers/:id', requirePermission('customers.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = parse(customerInputSchema, { ...req.body, id });
    await ctx.db.query(
      `INSERT INTO customers (id, name, phone, email, gstin, state_code, address) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, phone=$3, email=$4, gstin=$5, state_code=$6, address=$7, updated_at=now()`,
      [id, c.name, c.phone, c.email, c.gstin, c.stateCode, c.address],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'customer.upsert', entityType: 'customer', entityId: id, ip: req.ip });
    res.json(await getCustomer(ctx.db, id));
  });

  /** Customer purchase history, limited to locations the user can see. */
  r.get('/customers/:id/history', requirePermission('sales.view'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const params: unknown[] = [id];
    const clause = locClause('s.location_id', locationFilter(req), params);
    res.json(
      await many(
        ctx.db,
        `SELECT s.id, s.invoice_no AS "invoiceNo", s.occurred_at AS "occurredAt", s.grand_total AS "grandTotal",
                l.name AS "locationName",
                (SELECT coalesce(sum(r.refund_total), 0) FROM sale_returns r WHERE r.sale_id = s.id) AS "refunded"
           FROM sales s JOIN locations l ON l.id = s.location_id
          WHERE s.customer_id = $1 ${clause} ORDER BY s.occurred_at DESC LIMIT 200`,
        params,
      ),
    );
  });

  return r;
}
