import type {
  CategoryRow,
  CompanySettings,
  CustomerRow,
  LocationRow,
  ProductRow,
  PurchaseOrderRow,
  SupplierRow,
  TransferRow,
  UserRow,
} from '@store/shared';
import { many, one, type Queryable } from '../db/pool.js';

/** SELECT fragments that map snake_case columns to the shared camelCase row types. */

export const LOCATION_COLS = `l.id, l.code, l.name, l.type, l.address, l.state_code AS "stateCode", l.gstin, l.phone,
  l.invoice_prefix AS "invoicePrefix", l.can_receive_purchases AS "canReceivePurchases", l.is_active AS "isActive"`;

export const USER_COLS = `u.id, u.username, u.full_name AS "fullName", u.role, u.all_locations AS "allLocations",
  u.is_active AS "isActive",
  coalesce((SELECT array_agg(ul.location_id ORDER BY ul.location_id) FROM user_locations ul WHERE ul.user_id = u.id), '{}') AS "locationIds"`;

export const CATEGORY_COLS = `c.id, c.name, c.parent_id AS "parentId", c.is_active AS "isActive"`;

export const PRODUCT_COLS = `p.id, p.sku, p.name, p.category_id AS "categoryId", p.brand, p.hsn_code AS "hsnCode", p.unit,
  p.gst_rate_bp AS "gstRateBp", p.purchase_price AS "purchasePrice", p.selling_price AS "sellingPrice", p.mrp,
  p.price_includes_tax AS "priceIncludesTax", p.reorder_level AS "reorderLevel", p.variant_group AS "variantGroup",
  p.variant_attrs AS "variantAttrs", p.image_data AS "imageData", p.is_active AS "isActive",
  coalesce((SELECT json_agg(json_build_object('barcode', b.barcode, 'unitLabel', b.unit_label, 'factor', b.factor) ORDER BY b.factor, b.barcode)
              FROM product_barcodes b WHERE b.product_id = p.id), '[]'::json) AS barcodes`;

/** Same as PRODUCT_COLS without the (potentially large) image. */
export const PRODUCT_LIST_COLS = PRODUCT_COLS.replace('p.image_data AS "imageData"', 'NULL AS "imageData"');

export const SUPPLIER_COLS = `s.id, s.name, s.gstin, s.state_code AS "stateCode", s.phone, s.email, s.address, s.is_active AS "isActive"`;

export const CUSTOMER_COLS = `c.id, c.name, c.phone, c.email, c.gstin, c.state_code AS "stateCode", c.address`;

export const PO_COLS = `po.id, po.po_no AS "poNo", po.supplier_id AS "supplierId", po.location_id AS "locationId", po.status,
  to_char(po.expected_date, 'YYYY-MM-DD') AS "expectedDate", po.notes, po.created_at AS "createdAt",
  coalesce((SELECT json_agg(json_build_object('id', pl.id, 'productId', pl.product_id, 'qty', pl.qty, 'qtyReceived', pl.qty_received,
              'unitCost', pl.unit_cost, 'gstRateBp', pl.gst_rate_bp) ORDER BY pl.id)
              FROM purchase_order_lines pl WHERE pl.purchase_order_id = po.id), '[]'::json) AS lines`;

export const TRANSFER_COLS = `t.id, t.transfer_no AS "transferNo", t.source_location_id AS "sourceLocationId",
  t.dest_location_id AS "destLocationId", t.requested_by_location_id AS "requestedByLocationId", t.status, t.notes,
  t.status_reason AS "statusReason", t.created_at AS "createdAt", t.updated_at AS "updatedAt",
  coalesce((SELECT json_agg(json_build_object('id', tl.id, 'productId', tl.product_id, 'qtyRequested', tl.qty_requested,
              'qtyApproved', tl.qty_approved, 'qtyDispatched', tl.qty_dispatched, 'qtyReceived', tl.qty_received,
              'qtyDamaged', tl.qty_damaged) ORDER BY tl.id)
              FROM transfer_lines tl WHERE tl.transfer_id = t.id), '[]'::json) AS lines`;

export const MOVEMENT_COLS = `m.id, m.location_id AS "locationId", m.product_id AS "productId", m.qty_delta AS "qtyDelta",
  m.movement_type AS "movementType", m.ref_type AS "refType", m.ref_id AS "refId", m.unit_cost AS "unitCost",
  m.occurred_at AS "occurredAt", m.device_id AS "deviceId"`;

export async function getSettings(q: Queryable): Promise<(CompanySettings & { id: string }) | null> {
  return one(
    q,
    `SELECT id, name, gstin, state_code AS "stateCode", address, phone,
            branch_to_branch_enabled AS "branchToBranchEnabled", branch_to_warehouse_enabled AS "branchToWarehouseEnabled",
            allow_negative_stock AS "allowNegativeStock", round_to_rupee AS "roundToRupee",
            receipt_footer AS "receiptFooter", default_low_stock_level AS "defaultLowStockLevel"
       FROM company LIMIT 1`,
  );
}

export async function getLocation(q: Queryable, id: string): Promise<LocationRow | null> {
  return one(q, `SELECT ${LOCATION_COLS} FROM locations l WHERE l.id = $1`, [id]);
}

export async function getUser(q: Queryable, id: string): Promise<UserRow | null> {
  return one(q, `SELECT ${USER_COLS} FROM users u WHERE u.id = $1`, [id]);
}

export async function getProduct(q: Queryable, id: string): Promise<ProductRow | null> {
  return one(q, `SELECT ${PRODUCT_COLS} FROM products p WHERE p.id = $1`, [id]);
}

export async function getTransfer(q: Queryable, id: string): Promise<TransferRow | null> {
  return one(q, `SELECT ${TRANSFER_COLS} FROM stock_transfers t WHERE t.id = $1`, [id]);
}

export async function getPurchaseOrder(q: Queryable, id: string): Promise<PurchaseOrderRow | null> {
  return one(q, `SELECT ${PO_COLS} FROM purchase_orders po WHERE po.id = $1`, [id]);
}

export async function listCategories(q: Queryable): Promise<CategoryRow[]> {
  return many(q, `SELECT ${CATEGORY_COLS} FROM categories c ORDER BY c.name`);
}

export async function getSupplier(q: Queryable, id: string): Promise<SupplierRow | null> {
  return one(q, `SELECT ${SUPPLIER_COLS} FROM suppliers s WHERE s.id = $1`, [id]);
}

export async function getCustomer(q: Queryable, id: string): Promise<CustomerRow | null> {
  return one(q, `SELECT ${CUSTOMER_COLS} FROM customers c WHERE c.id = $1`, [id]);
}
