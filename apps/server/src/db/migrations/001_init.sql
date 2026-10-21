-- Central database schema. Single company per deployment.
-- Money: bigint paise. Rates: integer basis points. Quantities: integer base units.

-- ---------------------------------------------------------------------------
-- Change sequence used by incremental pull.
-- One sequence value per writing transaction, taken from a single counter row.
-- The row lock is held until commit, so sequence order == commit order and a
-- client that has pulled up to N can never miss a later-committed change <= N.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_counter (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  value bigint NOT NULL
);
INSERT INTO sync_counter (id, value) VALUES (true, 0);

CREATE FUNCTION next_tx_seq() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE
  v text;
  n bigint;
BEGIN
  v := current_setting('app.tx_seq', true);
  IF v IS NULL OR v = '' THEN
    UPDATE sync_counter SET value = value + 1 RETURNING value INTO n;
    PERFORM set_config('app.tx_seq', n::text, true);
    RETURN n;
  END IF;
  RETURN v::bigint;
END $$;

CREATE FUNCTION touch_server_seq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.server_seq := next_tx_seq();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Company & locations
-- ---------------------------------------------------------------------------
CREATE TABLE company (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  gstin text,
  state_code char(2) NOT NULL,
  address text,
  phone text,
  branch_to_branch_enabled boolean NOT NULL DEFAULT false,
  branch_to_warehouse_enabled boolean NOT NULL DEFAULT true,
  allow_negative_stock boolean NOT NULL DEFAULT false,
  round_to_rupee boolean NOT NULL DEFAULT true,
  receipt_footer text,
  default_low_stock_level integer NOT NULL DEFAULT 5,
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER company_seq BEFORE INSERT OR UPDATE ON company FOR EACH ROW EXECUTE FUNCTION touch_server_seq();

-- A location is either a WAREHOUSE (gudovun) or a selling BRANCH. There is
-- intentionally no "main store" type: the central database holds no stock.
CREATE TABLE locations (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('WAREHOUSE', 'BRANCH')),
  address text,
  state_code char(2) NOT NULL,
  gstin text,
  phone text,
  invoice_prefix text NOT NULL UNIQUE,
  can_receive_purchases boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER locations_seq BEFORE INSERT OR UPDATE ON locations FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX locations_seq_idx ON locations (server_seq);

-- ---------------------------------------------------------------------------
-- Users, devices
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  full_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('COMPANY_ADMIN','WAREHOUSE_MANAGER','BRANCH_MANAGER','SALES_STAFF','PURCHASE_STAFF','ACCOUNTS_STAFF')),
  all_locations boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  -- bumped on password change / deactivation to invalidate issued tokens
  token_version integer NOT NULL DEFAULT 0,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER users_seq BEFORE INSERT OR UPDATE OF username, full_name, role, all_locations, is_active, updated_at ON users FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX users_seq_idx ON users (server_seq);

CREATE TABLE user_locations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id),
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES locations(id),
  device_no integer NOT NULL,
  name text NOT NULL,
  key_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  registered_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  last_push_at timestamptz,
  last_pull_at timestamptz,
  pending_reported integer NOT NULL DEFAULT 0,
  app_version text,
  UNIQUE (location_id, device_no)
);

-- ---------------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------------
CREATE TABLE categories (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  parent_id uuid REFERENCES categories(id),
  is_active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX categories_name_uq ON categories (lower(name), coalesce(parent_id, '00000000-0000-0000-0000-000000000000'));
CREATE TRIGGER categories_seq BEFORE INSERT OR UPDATE ON categories FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX categories_seq_idx ON categories (server_seq);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category_id uuid REFERENCES categories(id),
  brand text,
  hsn_code text,
  unit text NOT NULL,
  gst_rate_bp integer NOT NULL CHECK (gst_rate_bp BETWEEN 0 AND 10000),
  purchase_price bigint NOT NULL CHECK (purchase_price >= 0),
  selling_price bigint NOT NULL CHECK (selling_price >= 0),
  mrp bigint,
  price_includes_tax boolean NOT NULL DEFAULT true,
  reorder_level integer NOT NULL DEFAULT 0,
  variant_group text,
  variant_attrs jsonb NOT NULL DEFAULT '{}',
  image_data text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER products_seq BEFORE INSERT OR UPDATE ON products FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX products_seq_idx ON products (server_seq);
CREATE INDEX products_name_idx ON products (lower(name));

-- Barcodes (EAN/UPC/QR payload/internal). A pack barcode carries a factor,
-- e.g. a box barcode with factor 12 adds 12 base units when scanned.
CREATE TABLE product_barcodes (
  barcode text PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit_label text NOT NULL DEFAULT 'pcs',
  factor integer NOT NULL DEFAULT 1 CHECK (factor >= 1)
);
CREATE INDEX product_barcodes_product_idx ON product_barcodes (product_id);

-- ---------------------------------------------------------------------------
-- Partners
-- ---------------------------------------------------------------------------
CREATE TABLE suppliers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  gstin text,
  state_code char(2),
  phone text,
  email text,
  address text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER suppliers_seq BEFORE INSERT OR UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX suppliers_seq_idx ON suppliers (server_seq);

CREATE TABLE customers (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  phone text,
  email text,
  gstin text,
  state_code char(2),
  address text,
  created_at_location uuid REFERENCES locations(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER customers_seq BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX customers_seq_idx ON customers (server_seq);
CREATE INDEX customers_phone_idx ON customers (phone);

-- ---------------------------------------------------------------------------
-- Inventory ledger
-- ---------------------------------------------------------------------------
CREATE TABLE stock_levels (
  location_id uuid NOT NULL REFERENCES locations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_on_hand bigint NOT NULL DEFAULT 0,
  avg_cost bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, product_id)
);

-- Append-only. The id equals the id of the document line that caused it, which
-- makes movements idempotent across devices and retries.
CREATE TABLE stock_movements (
  id uuid PRIMARY KEY,
  location_id uuid NOT NULL REFERENCES locations(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_delta integer NOT NULL CHECK (qty_delta <> 0),
  movement_type text NOT NULL CHECK (movement_type IN ('OPENING','SALE','SALE_RETURN','PURCHASE_RECEIPT','PURCHASE_RETURN','TRANSFER_OUT','TRANSFER_IN','TRANSFER_RESOLUTION','ADJUSTMENT')),
  ref_type text NOT NULL,
  ref_id uuid NOT NULL,
  unit_cost bigint NOT NULL DEFAULT 0,
  reason text,
  user_id uuid REFERENCES users(id),
  -- NULL for movements created centrally (opening stock entered by admin, discrepancy resolution)
  device_id uuid REFERENCES devices(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER stock_movements_seq BEFORE INSERT ON stock_movements FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX stock_movements_loc_seq_idx ON stock_movements (location_id, server_seq);
CREATE INDEX stock_movements_product_idx ON stock_movements (product_id, location_id, occurred_at);
CREATE INDEX stock_movements_ref_idx ON stock_movements (ref_type, ref_id);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE stock_adjustments (
  id uuid PRIMARY KEY,
  adjustment_no text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES locations(id),
  kind text NOT NULL CHECK (kind IN ('OPENING','ADJUSTMENT')),
  reason text NOT NULL,
  notes text,
  user_id uuid REFERENCES users(id),
  device_id uuid REFERENCES devices(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stock_adjustment_lines (
  id uuid PRIMARY KEY,
  adjustment_id uuid NOT NULL REFERENCES stock_adjustments(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_delta integer NOT NULL,
  unit_cost bigint NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- Sales
-- ---------------------------------------------------------------------------
CREATE TABLE sales (
  id uuid PRIMARY KEY,
  invoice_no text NOT NULL UNIQUE,
  location_id uuid NOT NULL REFERENCES locations(id),
  device_id uuid REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  customer_id uuid REFERENCES customers(id),
  inter_state boolean NOT NULL,
  gross_total bigint NOT NULL,
  discount_total bigint NOT NULL,
  taxable_total bigint NOT NULL,
  cgst_total bigint NOT NULL,
  sgst_total bigint NOT NULL,
  igst_total bigint NOT NULL,
  round_off integer NOT NULL,
  grand_total bigint NOT NULL,
  tendered bigint NOT NULL,
  change_due bigint NOT NULL,
  notes text,
  exchange_return_id uuid,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_location_time_idx ON sales (location_id, occurred_at);
CREATE INDEX sales_customer_idx ON sales (customer_id);

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES sales(id),
  product_id uuid NOT NULL REFERENCES products(id),
  sku text NOT NULL,
  name text NOT NULL,
  hsn_code text,
  qty integer NOT NULL CHECK (qty > 0),
  qty_returned integer NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),
  unit_price bigint NOT NULL,
  price_includes_tax boolean NOT NULL,
  gst_rate_bp integer NOT NULL,
  discount bigint NOT NULL,
  taxable_value bigint NOT NULL,
  cgst bigint NOT NULL,
  sgst bigint NOT NULL,
  igst bigint NOT NULL,
  line_total bigint NOT NULL,
  CHECK (qty_returned <= qty)
);
CREATE INDEX sale_lines_sale_idx ON sale_lines (sale_id);
CREATE INDEX sale_lines_product_idx ON sale_lines (product_id);

CREATE TABLE sale_returns (
  id uuid PRIMARY KEY,
  return_no text NOT NULL UNIQUE,
  sale_id uuid NOT NULL REFERENCES sales(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  device_id uuid REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  refund_total bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sale_returns_location_time_idx ON sale_returns (location_id, occurred_at);

CREATE TABLE sale_return_lines (
  id uuid PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES sale_returns(id),
  sale_line_id uuid NOT NULL REFERENCES sale_lines(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  restock boolean NOT NULL,
  taxable_value bigint NOT NULL,
  cgst bigint NOT NULL,
  sgst bigint NOT NULL,
  igst bigint NOT NULL,
  total bigint NOT NULL
);

-- Customer payments (SALE) and refunds (SALE_RETURN). Amount is always positive.
CREATE TABLE payments (
  id uuid PRIMARY KEY,
  ref_type text NOT NULL CHECK (ref_type IN ('SALE','SALE_RETURN')),
  ref_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES locations(id),
  method text NOT NULL CHECK (method IN ('CASH','UPI','CARD')),
  amount bigint NOT NULL CHECK (amount > 0),
  reference text,
  occurred_at timestamptz NOT NULL
);
CREATE INDEX payments_ref_idx ON payments (ref_type, ref_id);
CREATE INDEX payments_location_time_idx ON payments (location_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Purchasing
-- ---------------------------------------------------------------------------
CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY,
  po_no text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  status text NOT NULL CHECK (status IN ('DRAFT','ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED')),
  expected_date date,
  notes text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0
);
CREATE TRIGGER purchase_orders_seq BEFORE INSERT OR UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX purchase_orders_loc_seq_idx ON purchase_orders (location_id, server_seq);

CREATE TABLE purchase_order_lines (
  id uuid PRIMARY KEY,
  purchase_order_id uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  qty_received integer NOT NULL DEFAULT 0,
  unit_cost bigint NOT NULL,
  gst_rate_bp integer NOT NULL
);
CREATE INDEX purchase_order_lines_po_idx ON purchase_order_lines (purchase_order_id);

-- A goods received note doubles as the record of the supplier's purchase invoice.
CREATE TABLE goods_receipts (
  id uuid PRIMARY KEY,
  grn_no text NOT NULL UNIQUE,
  purchase_order_id uuid REFERENCES purchase_orders(id),
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  device_id uuid REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  supplier_invoice_no text,
  supplier_invoice_date date,
  taxable_total bigint NOT NULL,
  tax_total bigint NOT NULL,
  grand_total bigint NOT NULL,
  notes text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goods_receipts_location_time_idx ON goods_receipts (location_id, occurred_at);
CREATE INDEX goods_receipts_supplier_idx ON goods_receipts (supplier_id);

CREATE TABLE goods_receipt_lines (
  id uuid PRIMARY KEY,
  grn_id uuid NOT NULL REFERENCES goods_receipts(id),
  purchase_order_line_id uuid REFERENCES purchase_order_lines(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_cost bigint NOT NULL,
  gst_rate_bp integer NOT NULL,
  taxable_value bigint NOT NULL,
  tax_total bigint NOT NULL,
  total bigint NOT NULL
);
CREATE INDEX goods_receipt_lines_product_idx ON goods_receipt_lines (product_id);

CREATE TABLE purchase_returns (
  id uuid PRIMARY KEY,
  return_no text NOT NULL UNIQUE,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  grn_id uuid REFERENCES goods_receipts(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  device_id uuid REFERENCES devices(id),
  user_id uuid NOT NULL REFERENCES users(id),
  reason text NOT NULL,
  taxable_total bigint NOT NULL,
  tax_total bigint NOT NULL,
  grand_total bigint NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE purchase_return_lines (
  id uuid PRIMARY KEY,
  return_id uuid NOT NULL REFERENCES purchase_returns(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0),
  unit_cost bigint NOT NULL,
  gst_rate_bp integer NOT NULL,
  taxable_value bigint NOT NULL,
  tax_total bigint NOT NULL,
  total bigint NOT NULL
);

CREATE TABLE supplier_payments (
  id uuid PRIMARY KEY,
  supplier_id uuid NOT NULL REFERENCES suppliers(id),
  grn_id uuid REFERENCES goods_receipts(id),
  location_id uuid NOT NULL REFERENCES locations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  amount bigint NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  reference text,
  paid_on date NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX supplier_payments_supplier_idx ON supplier_payments (supplier_id);

-- ---------------------------------------------------------------------------
-- Stock transfers
-- ---------------------------------------------------------------------------
CREATE TABLE stock_transfers (
  id uuid PRIMARY KEY,
  transfer_no text NOT NULL UNIQUE,
  source_location_id uuid NOT NULL REFERENCES locations(id),
  dest_location_id uuid NOT NULL REFERENCES locations(id),
  requested_by_location_id uuid NOT NULL REFERENCES locations(id),
  status text NOT NULL CHECK (status IN ('REQUESTED','APPROVED','REJECTED','PARTIALLY_DISPATCHED','DISPATCHED','PARTIALLY_RECEIVED','RECEIVED','CLOSED_WITH_DISCREPANCY','CANCELLED')),
  notes text,
  status_reason text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  server_seq bigint NOT NULL DEFAULT 0,
  CHECK (source_location_id <> dest_location_id)
);
CREATE TRIGGER stock_transfers_seq BEFORE INSERT OR UPDATE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION touch_server_seq();
CREATE INDEX stock_transfers_source_idx ON stock_transfers (source_location_id, server_seq);
CREATE INDEX stock_transfers_dest_idx ON stock_transfers (dest_location_id, server_seq);

CREATE TABLE transfer_lines (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_requested integer NOT NULL CHECK (qty_requested > 0),
  qty_approved integer NOT NULL DEFAULT 0 CHECK (qty_approved >= 0),
  qty_dispatched integer NOT NULL DEFAULT 0 CHECK (qty_dispatched >= 0),
  qty_received integer NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_damaged integer NOT NULL DEFAULT 0 CHECK (qty_damaged >= 0),
  CHECK (qty_received + qty_damaged <= qty_dispatched)
);
CREATE INDEX transfer_lines_transfer_idx ON transfer_lines (transfer_id);

CREATE TABLE transfer_dispatches (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid REFERENCES devices(id),
  notes text,
  occurred_at timestamptz NOT NULL
);
CREATE TABLE transfer_dispatch_lines (
  id uuid PRIMARY KEY,
  dispatch_id uuid NOT NULL REFERENCES transfer_dispatches(id),
  transfer_line_id uuid NOT NULL REFERENCES transfer_lines(id),
  qty integer NOT NULL CHECK (qty > 0)
);
CREATE TABLE transfer_receipts (
  id uuid PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  device_id uuid REFERENCES devices(id),
  notes text,
  occurred_at timestamptz NOT NULL
);
CREATE TABLE transfer_receipt_lines (
  id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES transfer_receipts(id),
  transfer_line_id uuid NOT NULL REFERENCES transfer_lines(id),
  qty_received integer NOT NULL CHECK (qty_received >= 0),
  qty_damaged integer NOT NULL CHECK (qty_damaged >= 0)
);

CREATE TABLE transfer_history (
  id bigserial PRIMARY KEY,
  transfer_id uuid NOT NULL REFERENCES stock_transfers(id),
  action text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  user_id uuid REFERENCES users(id),
  location_id uuid REFERENCES locations(id),
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL
);
CREATE INDEX transfer_history_transfer_idx ON transfer_history (transfer_id, id);

-- ---------------------------------------------------------------------------
-- Reconciliation: things a human must review (negative stock after offline
-- sales, transfer conflicts, transfer shortages/damages).
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_items (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('NEGATIVE_STOCK','TRANSFER_CONFLICT','TRANSFER_DISCREPANCY','REJECTED_EVENT')),
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  location_id uuid REFERENCES locations(id),
  product_id uuid REFERENCES products(id),
  ref_type text,
  ref_id uuid,
  qty integer,
  details jsonb NOT NULL DEFAULT '{}',
  resolution text,
  resolution_note text,
  resolved_by uuid REFERENCES users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reconciliation_open_idx ON reconciliation_items (status, created_at);

-- ---------------------------------------------------------------------------
-- Sync inbox: one row per event id (idempotency key) ever received.
-- ---------------------------------------------------------------------------
CREATE TABLE sync_inbox (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices(id),
  event_type text NOT NULL,
  location_id uuid,
  user_id uuid,
  occurred_at timestamptz,
  status text NOT NULL CHECK (status IN ('PROCESSING','ACCEPTED','REJECTED')),
  error text,
  attempts integer NOT NULL DEFAULT 1,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX sync_inbox_status_idx ON sync_inbox (status, received_at);
CREATE INDEX sync_inbox_device_idx ON sync_inbox (device_id, received_at);

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  location_id uuid,
  device_id uuid,
  action text NOT NULL,
  entity_type text,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  ip text
);
CREATE INDEX audit_logs_time_idx ON audit_logs (occurred_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Counters for centrally numbered documents (purchase orders, admin adjustments).
CREATE TABLE doc_counters (
  key text PRIMARY KEY,
  value integer NOT NULL
);
