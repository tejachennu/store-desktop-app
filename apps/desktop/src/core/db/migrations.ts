/**
 * Local SQLite schema, versioned with PRAGMA user_version. Append new migrations;
 * never edit a released one. Money is integer paise, quantities integer base units,
 * ids are UUIDv7 strings, timestamps ISO-8601 UTC strings.
 */
export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------- Cached master data (authored centrally, pulled) ----------------
CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('WAREHOUSE','BRANCH')),
  address TEXT,
  state_code TEXT NOT NULL,
  gstin TEXT,
  phone TEXT,
  invoice_prefix TEXT NOT NULL,
  can_receive_purchases INTEGER NOT NULL,
  is_active INTEGER NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL,
  all_locations INTEGER NOT NULL,
  location_ids TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL
);

-- Offline login verifier, written only after a successful online login on this PC.
CREATE TABLE user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  verifier TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  is_active INTEGER NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id TEXT,
  brand TEXT,
  hsn_code TEXT,
  unit TEXT NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  purchase_price INTEGER NOT NULL,
  selling_price INTEGER NOT NULL,
  mrp INTEGER,
  price_includes_tax INTEGER NOT NULL,
  reorder_level INTEGER NOT NULL,
  variant_group TEXT,
  variant_attrs TEXT NOT NULL DEFAULT '{}',
  image_data TEXT,
  is_active INTEGER NOT NULL
);
CREATE INDEX products_name_idx ON products (name COLLATE NOCASE);

CREATE TABLE product_barcodes (
  barcode TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_label TEXT NOT NULL,
  factor INTEGER NOT NULL
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (product_id);

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gstin TEXT,
  state_code TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  is_active INTEGER NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  gstin TEXT,
  state_code TEXT,
  address TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX customers_phone_idx ON customers (phone);

-- ---------------- Inventory ledger for this location ----------------
CREATE TABLE stock_levels (
  location_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_on_hand INTEGER NOT NULL DEFAULT 0,
  avg_cost INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (location_id, product_id)
);

CREATE TABLE stock_movements (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  qty_delta INTEGER NOT NULL CHECK (qty_delta <> 0),
  movement_type TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  user_id TEXT,
  -- LOCAL: created on this PC; REMOTE: pulled (sibling terminal or central admin)
  origin TEXT NOT NULL CHECK (origin IN ('LOCAL','REMOTE')),
  occurred_at TEXT NOT NULL
);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, occurred_at);
CREATE INDEX stock_movements_ref_idx ON stock_movements (ref_type, ref_id);
CREATE TRIGGER stock_movements_no_update BEFORE UPDATE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;
CREATE TRIGGER stock_movements_no_delete BEFORE DELETE ON stock_movements
BEGIN SELECT RAISE(ABORT, 'stock_movements is append-only'); END;

CREATE TABLE stock_adjustments (
  id TEXT PRIMARY KEY,
  adjustment_no TEXT NOT NULL UNIQUE,
  location_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  notes TEXT,
  user_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE stock_adjustment_lines (
  id TEXT PRIMARY KEY,
  adjustment_id TEXT NOT NULL REFERENCES stock_adjustments(id),
  product_id TEXT NOT NULL,
  qty_delta INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL
);

-- ---------------- Sales ----------------
CREATE TABLE sales (
  id TEXT PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  location_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  customer_id TEXT,
  inter_state INTEGER NOT NULL,
  gross_total INTEGER NOT NULL,
  discount_total INTEGER NOT NULL,
  taxable_total INTEGER NOT NULL,
  cgst_total INTEGER NOT NULL,
  sgst_total INTEGER NOT NULL,
  igst_total INTEGER NOT NULL,
  round_off INTEGER NOT NULL,
  grand_total INTEGER NOT NULL,
  tendered INTEGER NOT NULL,
  change_due INTEGER NOT NULL,
  notes TEXT,
  exchange_return_id TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX sales_time_idx ON sales (occurred_at);
CREATE INDEX sales_customer_idx ON sales (customer_id);

CREATE TABLE sale_lines (
  id TEXT PRIMARY KEY,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  hsn_code TEXT,
  qty INTEGER NOT NULL CHECK (qty > 0),
  qty_returned INTEGER NOT NULL DEFAULT 0,
  unit_price INTEGER NOT NULL,
  price_includes_tax INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  discount INTEGER NOT NULL,
  taxable_value INTEGER NOT NULL,
  cgst INTEGER NOT NULL,
  sgst INTEGER NOT NULL,
  igst INTEGER NOT NULL,
  line_total INTEGER NOT NULL,
  CHECK (qty_returned <= qty)
);
CREATE INDEX sale_lines_sale_idx ON sale_lines (sale_id);

CREATE TABLE sale_returns (
  id TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  sale_id TEXT NOT NULL REFERENCES sales(id),
  location_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  refund_total INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE sale_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES sale_returns(id),
  sale_line_id TEXT NOT NULL REFERENCES sale_lines(id),
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  restock INTEGER NOT NULL,
  taxable_value INTEGER NOT NULL,
  cgst INTEGER NOT NULL,
  sgst INTEGER NOT NULL,
  igst INTEGER NOT NULL,
  total INTEGER NOT NULL
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  ref_type TEXT NOT NULL CHECK (ref_type IN ('SALE','SALE_RETURN')),
  ref_id TEXT NOT NULL,
  method TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  reference TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX payments_ref_idx ON payments (ref_type, ref_id);

-- ---------------- Purchasing ----------------
CREATE TABLE purchase_orders (
  id TEXT PRIMARY KEY,
  po_no TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expected_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE purchase_order_lines (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  qty_received INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL
);

CREATE TABLE goods_receipts (
  id TEXT PRIMARY KEY,
  grn_no TEXT NOT NULL UNIQUE,
  purchase_order_id TEXT,
  supplier_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  supplier_invoice_no TEXT,
  supplier_invoice_date TEXT,
  taxable_total INTEGER NOT NULL,
  tax_total INTEGER NOT NULL,
  grand_total INTEGER NOT NULL,
  notes TEXT,
  occurred_at TEXT NOT NULL
);
CREATE TABLE goods_receipt_lines (
  id TEXT PRIMARY KEY,
  grn_id TEXT NOT NULL REFERENCES goods_receipts(id),
  purchase_order_line_id TEXT,
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  taxable_value INTEGER NOT NULL,
  tax_total INTEGER NOT NULL,
  total INTEGER NOT NULL
);

CREATE TABLE purchase_returns (
  id TEXT PRIMARY KEY,
  return_no TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  grn_id TEXT,
  location_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  taxable_total INTEGER NOT NULL,
  tax_total INTEGER NOT NULL,
  grand_total INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE purchase_return_lines (
  id TEXT PRIMARY KEY,
  return_id TEXT NOT NULL REFERENCES purchase_returns(id),
  product_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL,
  gst_rate_bp INTEGER NOT NULL,
  taxable_value INTEGER NOT NULL,
  tax_total INTEGER NOT NULL,
  total INTEGER NOT NULL
);

CREATE TABLE supplier_payments (
  id TEXT PRIMARY KEY,
  supplier_id TEXT NOT NULL,
  grn_id TEXT,
  user_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  reference TEXT,
  paid_on TEXT NOT NULL
);

-- ---------------- Transfers (documents shared with the other side) ----------------
CREATE TABLE stock_transfers (
  id TEXT PRIMARY KEY,
  transfer_no TEXT NOT NULL,
  source_location_id TEXT NOT NULL,
  dest_location_id TEXT NOT NULL,
  requested_by_location_id TEXT NOT NULL,
  status TEXT NOT NULL,
  notes TEXT,
  status_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE transfer_lines (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  qty_requested INTEGER NOT NULL,
  qty_approved INTEGER NOT NULL DEFAULT 0,
  qty_dispatched INTEGER NOT NULL DEFAULT 0,
  qty_received INTEGER NOT NULL DEFAULT 0,
  qty_damaged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX transfer_lines_transfer_idx ON transfer_lines (transfer_id);

-- ---------------- Sync ----------------
-- Every event that must reach the server is written here in the same
-- transaction as the business data it describes.
CREATE TABLE outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  doc_refs TEXT NOT NULL DEFAULT '[]',
  envelope TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SYNCED','FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  synced_at TEXT
);
CREATE INDEX outbox_status_idx ON outbox (status, next_attempt_at, seq);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details TEXT
);

CREATE TABLE doc_counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`,
  },
];
