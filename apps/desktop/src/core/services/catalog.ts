import type { CategoryRow, CustomerRow, LocationRow, ProductRow, SupplierRow, UserRow } from '@store/shared';
import type { DB } from '../db/connection';
import { bool } from '../db/connection';
import { notFound } from '../errors';

/** Read access to master data cached from the central server. */

export const mapLocation = (r: any): LocationRow => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  address: r.address,
  stateCode: r.state_code,
  gstin: r.gstin,
  phone: r.phone,
  invoicePrefix: r.invoice_prefix,
  canReceivePurchases: bool(r.can_receive_purchases),
  isActive: bool(r.is_active),
});

export const mapUser = (r: any): UserRow => ({
  id: r.id,
  username: r.username,
  fullName: r.full_name,
  role: r.role,
  allLocations: bool(r.all_locations),
  locationIds: JSON.parse(r.location_ids),
  isActive: bool(r.is_active),
});

export const mapProduct = (r: any, barcodes: ProductRow['barcodes'] = []): ProductRow => ({
  id: r.id,
  sku: r.sku,
  name: r.name,
  categoryId: r.category_id,
  brand: r.brand,
  hsnCode: r.hsn_code,
  unit: r.unit,
  gstRateBp: r.gst_rate_bp,
  purchasePrice: r.purchase_price,
  sellingPrice: r.selling_price,
  mrp: r.mrp,
  priceIncludesTax: bool(r.price_includes_tax),
  reorderLevel: r.reorder_level,
  variantGroup: r.variant_group,
  variantAttrs: JSON.parse(r.variant_attrs ?? '{}'),
  imageData: r.image_data ?? null,
  isActive: bool(r.is_active),
  barcodes,
});

export const mapSupplier = (r: any): SupplierRow => ({
  id: r.id,
  name: r.name,
  gstin: r.gstin,
  stateCode: r.state_code,
  phone: r.phone,
  email: r.email,
  address: r.address,
  isActive: bool(r.is_active),
});

export const mapCustomer = (r: any): CustomerRow => ({
  id: r.id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  gstin: r.gstin,
  stateCode: r.state_code,
  address: r.address,
});

export function listLocations(db: DB): LocationRow[] {
  return (db.prepare('SELECT * FROM locations ORDER BY type DESC, name').all() as any[]).map(mapLocation);
}

export function getLocation(db: DB, id: string): LocationRow {
  const r = db.prepare('SELECT * FROM locations WHERE id = ?').get(id);
  if (!r) throw notFound('Location');
  return mapLocation(r);
}

export function getUserByUsername(db: DB, username: string): UserRow | null {
  const r = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim().toLowerCase());
  return r ? mapUser(r) : null;
}

export function listUsers(db: DB): UserRow[] {
  return (db.prepare('SELECT * FROM users ORDER BY full_name').all() as any[]).map(mapUser);
}

export function listCategories(db: DB): CategoryRow[] {
  return (db.prepare('SELECT * FROM categories ORDER BY name').all() as any[]).map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    isActive: bool(r.is_active),
  }));
}

function barcodesFor(db: DB, productIds: string[]): Map<string, ProductRow['barcodes']> {
  const map = new Map<string, ProductRow['barcodes']>();
  if (productIds.length === 0) return map;
  const rows = db
    .prepare(`SELECT * FROM product_barcodes WHERE product_id IN (SELECT value FROM json_each(?)) ORDER BY factor, barcode`)
    .all(JSON.stringify(productIds)) as any[];
  for (const r of rows) {
    const list = map.get(r.product_id) ?? [];
    list.push({ barcode: r.barcode, unitLabel: r.unit_label, factor: r.factor });
    map.set(r.product_id, list);
  }
  return map;
}

export function getProduct(db: DB, id: string, withImage = true): ProductRow {
  const r = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;
  if (!r) throw notFound('Product');
  if (!withImage) r.image_data = null;
  return mapProduct(r, barcodesFor(db, [id]).get(id) ?? []);
}

export function getProductsByIds(db: DB, ids: string[]): Map<string, ProductRow> {
  const rows = db.prepare(`SELECT * FROM products WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...new Set(ids)])) as any[];
  const bc = barcodesFor(db, rows.map((r) => r.id));
  return new Map(rows.map((r) => [r.id, mapProduct({ ...r, image_data: null }, bc.get(r.id) ?? [])]));
}

export interface ProductSearch {
  search?: string;
  categoryId?: string;
  activeOnly?: boolean;
  limit?: number;
  offset?: number;
  locationId?: string;
}

export interface ProductListItem extends ProductRow {
  categoryName: string | null;
  qtyOnHand: number | null;
}

/** Product search by name, SKU or exact barcode; includes on-hand qty at a location when given. */
export function searchProducts(db: DB, q: ProductSearch): { total: number; rows: ProductListItem[] } {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (q.search?.trim()) {
    const s = q.search.trim();
    where.push(`(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR EXISTS (SELECT 1 FROM product_barcodes b WHERE b.product_id = p.id AND b.barcode = ?))`);
    params.push(`%${s}%`, `%${s}%`, `%${s}%`, s);
  }
  if (q.categoryId) {
    where.push('p.category_id = ?');
    params.push(q.categoryId);
  }
  if (q.activeOnly) where.push('p.is_active = 1');
  const total = (db.prepare(`SELECT count(*) AS n FROM products p WHERE ${where.join(' AND ')}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT p.*, NULL AS image_data, c.name AS category_name,
              (SELECT qty_on_hand FROM stock_levels s WHERE s.product_id = p.id AND s.location_id = ?) AS qty_on_hand
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    )
    .all(q.locationId ?? '', ...params, q.limit ?? 100, q.offset ?? 0) as any[];
  const bc = barcodesFor(db, rows.map((r) => r.id));
  return {
    total,
    rows: rows.map((r) => ({ ...mapProduct(r, bc.get(r.id) ?? []), categoryName: r.category_name, qtyOnHand: r.qty_on_hand ?? 0 })),
  };
}

/** Barcode scan: exact barcode (with pack factor) or SKU. */
export function findByBarcode(db: DB, code: string): { product: ProductRow; factor: number } | null {
  const c = code.trim();
  if (!c) return null;
  const b = db.prepare('SELECT product_id, factor FROM product_barcodes WHERE barcode = ?').get(c) as { product_id: string; factor: number } | undefined;
  if (b) return { product: getProduct(db, b.product_id, false), factor: b.factor };
  const p = db.prepare('SELECT id FROM products WHERE sku = ?').get(c.toUpperCase()) as { id: string } | undefined;
  return p ? { product: getProduct(db, p.id, false), factor: 1 } : null;
}

export function listSuppliers(db: DB, search?: string): SupplierRow[] {
  const rows = search?.trim()
    ? db.prepare('SELECT * FROM suppliers WHERE name LIKE ? OR gstin LIKE ? OR phone LIKE ? ORDER BY name').all(`%${search}%`, `%${search}%`, `%${search}%`)
    : db.prepare('SELECT * FROM suppliers ORDER BY name').all();
  return (rows as any[]).map(mapSupplier);
}

export function getSupplier(db: DB, id: string): SupplierRow {
  const r = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!r) throw notFound('Supplier');
  return mapSupplier(r);
}
