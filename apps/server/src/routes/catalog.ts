import { Router } from 'express';
import { z } from 'zod';
import { categoryInputSchema, productInputSchema, uuidv7, type ProductInput } from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one, withTransaction, type Tx } from '../db/pool.js';
import { requirePermission, requireUser } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { CATEGORY_COLS, PRODUCT_LIST_COLS, getProduct, listCategories } from '../services/rows.js';
import { parse, uuidParam } from './util.js';

export function catalogRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx));

  // ---------------- Categories ----------------
  r.get('/categories', async (_req, res) => {
    res.json(await listCategories(ctx.db));
  });

  r.post('/categories', requirePermission('products.manage'), async (req, res) => {
    const c = parse(categoryInputSchema, req.body);
    const id = uuidv7();
    await ctx.db.query('INSERT INTO categories (id, name, parent_id, is_active) VALUES ($1,$2,$3,$4)', [id, c.name, c.parentId, c.isActive]);
    await audit(ctx.db, { userId: req.user!.id, action: 'category.create', entityType: 'category', entityId: id, details: c, ip: req.ip });
    res.status(201).json(await one(ctx.db, `SELECT ${CATEGORY_COLS} FROM categories c WHERE c.id = $1`, [id]));
  });

  r.put('/categories/:id', requirePermission('products.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const c = parse(categoryInputSchema, req.body);
    if (c.parentId === id) throw badRequest('A category cannot be its own parent');
    const upd = await ctx.db.query('UPDATE categories SET name=$2, parent_id=$3, is_active=$4, updated_at=now() WHERE id=$1', [
      id,
      c.name,
      c.parentId,
      c.isActive,
    ]);
    if (upd.rowCount === 0) throw notFound('Category');
    await audit(ctx.db, { userId: req.user!.id, action: 'category.update', entityType: 'category', entityId: id, details: c, ip: req.ip });
    res.json(await one(ctx.db, `SELECT ${CATEGORY_COLS} FROM categories c WHERE c.id = $1`, [id]));
  });

  // ---------------- Products ----------------
  r.get('/products', async (req, res) => {
    const q = parse(
      z.object({
        search: z.string().trim().max(100).optional(),
        categoryId: z.uuid().optional(),
        active: z.enum(['true', 'false', 'all']).default('all'),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      req.query,
    );
    const params: unknown[] = [];
    let where = 'WHERE true';
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`, q.search);
      where += ` AND (lower(p.name) LIKE $${params.length - 1} OR lower(p.sku) LIKE $${params.length - 1}
                 OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = $${params.length}))`;
    }
    if (q.categoryId) {
      params.push(q.categoryId);
      where += ` AND p.category_id = $${params.length}`;
    }
    if (q.active !== 'all') {
      params.push(q.active === 'true');
      where += ` AND p.is_active = $${params.length}`;
    }
    const total = await one<{ n: number }>(ctx.db, `SELECT count(*)::int AS n FROM products p ${where}`, params);
    params.push(q.limit, q.offset);
    const rows = await many(
      ctx.db,
      `SELECT ${PRODUCT_LIST_COLS}, c.name AS "categoryName" FROM products p LEFT JOIN categories c ON c.id = p.category_id
        ${where} ORDER BY p.name LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ total: total!.n, rows });
  });

  r.get('/products/by-barcode/:code', async (req, res) => {
    const code = String(req.params.code).trim();
    const row = await one<{ id: string; factor: number }>(
      ctx.db,
      `SELECT p.id, b.factor FROM product_barcodes b JOIN products p ON p.id = b.product_id WHERE b.barcode = $1
       UNION ALL SELECT p.id, 1 FROM products p WHERE p.sku = upper($1) LIMIT 1`,
      [code],
    );
    if (!row) throw notFound('Product');
    res.json({ product: await getProduct(ctx.db, row.id), factor: row.factor });
  });

  r.get('/products/:id', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = await getProduct(ctx.db, id);
    if (!p) throw notFound('Product');
    res.json(p);
  });

  /** Purchase price history from goods received notes. */
  r.get('/products/:id/price-history', async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    res.json(
      await many(
        ctx.db,
        `SELECT g.occurred_at AS "receivedAt", g.grn_no AS "grnNo", s.name AS "supplierName", l.name AS "locationName",
                gl.qty, gl.unit_cost AS "unitCost"
           FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.grn_id
           JOIN suppliers s ON s.id = g.supplier_id JOIN locations l ON l.id = g.location_id
          WHERE gl.product_id = $1 ORDER BY g.occurred_at DESC LIMIT 100`,
        [id],
      ),
    );
  });

  const writeBarcodes = async (tx: Tx, productId: string, p: ProductInput) => {
    for (const b of p.barcodes) {
      const owner = await one<{ productId: string }>(tx, 'SELECT product_id AS "productId" FROM product_barcodes WHERE barcode = $1', [b.barcode]);
      if (owner && owner.productId !== productId) throw conflict(`Barcode ${b.barcode} is already assigned to another product`);
    }
    await tx.query('DELETE FROM product_barcodes WHERE product_id = $1', [productId]);
    for (const b of p.barcodes) {
      await tx.query('INSERT INTO product_barcodes (barcode, product_id, unit_label, factor) VALUES ($1,$2,$3,$4)', [
        b.barcode,
        productId,
        b.unitLabel,
        b.factor,
      ]);
    }
  };

  r.post('/products', requirePermission('products.manage'), async (req, res) => {
    const p = parse(productInputSchema, req.body);
    const id = uuidv7();
    await withTransaction(ctx.db, async (tx) => {
      await tx.query(
        `INSERT INTO products (id, sku, name, category_id, brand, hsn_code, unit, gst_rate_bp, purchase_price, selling_price, mrp,
                               price_includes_tax, reorder_level, variant_group, variant_attrs, image_data, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [id, p.sku, p.name, p.categoryId, p.brand, p.hsnCode, p.unit, p.gstRateBp, p.purchasePrice, p.sellingPrice, p.mrp,
         p.priceIncludesTax, p.reorderLevel, p.variantGroup, JSON.stringify(p.variantAttrs), p.imageData, p.isActive],
      );
      await writeBarcodes(tx, id, p);
      const { imageData: _img, ...details } = p;
      await audit(tx, { userId: req.user!.id, action: 'product.create', entityType: 'product', entityId: id, details, ip: req.ip });
    });
    res.status(201).json(await getProduct(ctx.db, id));
  });

  r.put('/products/:id', requirePermission('products.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const p = parse(productInputSchema, req.body);
    const before = await getProduct(ctx.db, id);
    if (!before) throw notFound('Product');
    await withTransaction(ctx.db, async (tx) => {
      await tx.query(
        `UPDATE products SET sku=$2, name=$3, category_id=$4, brand=$5, hsn_code=$6, unit=$7, gst_rate_bp=$8, purchase_price=$9,
                selling_price=$10, mrp=$11, price_includes_tax=$12, reorder_level=$13, variant_group=$14, variant_attrs=$15,
                image_data=$16, is_active=$17, updated_at=now()
          WHERE id=$1`,
        [id, p.sku, p.name, p.categoryId, p.brand, p.hsnCode, p.unit, p.gstRateBp, p.purchasePrice, p.sellingPrice, p.mrp,
         p.priceIncludesTax, p.reorderLevel, p.variantGroup, JSON.stringify(p.variantAttrs), p.imageData, p.isActive],
      );
      await writeBarcodes(tx, id, p);
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const k of ['sku', 'name', 'gstRateBp', 'purchasePrice', 'sellingPrice', 'mrp', 'isActive'] as const) {
        if (before[k] !== p[k]) changes[k] = { from: before[k], to: p[k] };
      }
      await audit(tx, { userId: req.user!.id, action: 'product.update', entityType: 'product', entityId: id, details: changes, ip: req.ip });
    });
    res.json(await getProduct(ctx.db, id));
  });

  return r;
}
