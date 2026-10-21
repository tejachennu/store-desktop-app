import type { PullResponse } from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso, tx } from '../db/connection';
import { hasPendingFor } from '../services/outbox';
import { setMeta } from '../services/meta';
import { applyMovement } from '../services/stock';

const b = (v: boolean) => (v ? 1 : 0);

/**
 * Apply one pull page atomically. Master data is upserted; documents that still
 * have unsent local events are left alone (they will be refreshed on a later pull
 * once our events are accepted); movements from sibling terminals or central
 * admin are applied idempotently by id.
 */
export function applyPull(db: DB, page: PullResponse): { movements: number; skippedDocs: number } {
  let movements = 0;
  let skippedDocs = 0;
  tx(db, () => {
    if (page.settings) {
      const { id: _id, ...settings } = page.settings as typeof page.settings & { id?: string };
      setMeta(db, 'settings', JSON.stringify(settings));
    }

    const upLoc = db.prepare(
      `INSERT INTO locations (id, code, name, type, address, state_code, gstin, phone, invoice_prefix, can_receive_purchases, is_active)
       VALUES (@id, @code, @name, @type, @address, @stateCode, @gstin, @phone, @invoicePrefix, @canReceivePurchases, @isActive)
       ON CONFLICT(id) DO UPDATE SET code=excluded.code, name=excluded.name, type=excluded.type, address=excluded.address,
         state_code=excluded.state_code, gstin=excluded.gstin, phone=excluded.phone, invoice_prefix=excluded.invoice_prefix,
         can_receive_purchases=excluded.can_receive_purchases, is_active=excluded.is_active`,
    );
    for (const l of page.locations) upLoc.run({ ...l, canReceivePurchases: b(l.canReceivePurchases), isActive: b(l.isActive) });

    const upUser = db.prepare(
      `INSERT INTO users (id, username, full_name, role, all_locations, location_ids, is_active)
       VALUES (@id, @username, @fullName, @role, @allLocations, @locationIds, @isActive)
       ON CONFLICT(id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, role=excluded.role,
         all_locations=excluded.all_locations, location_ids=excluded.location_ids, is_active=excluded.is_active`,
    );
    for (const u of page.users) {
      upUser.run({ ...u, allLocations: b(u.allLocations), locationIds: JSON.stringify(u.locationIds), isActive: b(u.isActive) });
      // A deactivated user can no longer sign in offline on this PC.
      if (!u.isActive) db.prepare('DELETE FROM user_credentials WHERE user_id = ?').run(u.id);
    }

    const upCat = db.prepare(
      `INSERT INTO categories (id, name, parent_id, is_active) VALUES (@id, @name, @parentId, @isActive)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, parent_id=excluded.parent_id, is_active=excluded.is_active`,
    );
    for (const c of page.categories) upCat.run({ ...c, isActive: b(c.isActive) });

    const upProd = db.prepare(
      `INSERT INTO products (id, sku, name, category_id, brand, hsn_code, unit, gst_rate_bp, purchase_price, selling_price, mrp,
                             price_includes_tax, reorder_level, variant_group, variant_attrs, image_data, is_active)
       VALUES (@id, @sku, @name, @categoryId, @brand, @hsnCode, @unit, @gstRateBp, @purchasePrice, @sellingPrice, @mrp,
               @priceIncludesTax, @reorderLevel, @variantGroup, @variantAttrs, @imageData, @isActive)
       ON CONFLICT(id) DO UPDATE SET sku=excluded.sku, name=excluded.name, category_id=excluded.category_id, brand=excluded.brand,
         hsn_code=excluded.hsn_code, unit=excluded.unit, gst_rate_bp=excluded.gst_rate_bp, purchase_price=excluded.purchase_price,
         selling_price=excluded.selling_price, mrp=excluded.mrp, price_includes_tax=excluded.price_includes_tax,
         reorder_level=excluded.reorder_level, variant_group=excluded.variant_group, variant_attrs=excluded.variant_attrs,
         image_data=excluded.image_data, is_active=excluded.is_active`,
    );
    const delBarcodes = db.prepare('DELETE FROM product_barcodes WHERE product_id = ?');
    const delBarcode = db.prepare('DELETE FROM product_barcodes WHERE barcode = ?');
    const insBarcode = db.prepare('INSERT INTO product_barcodes (barcode, product_id, unit_label, factor) VALUES (?,?,?,?)');
    for (const p of page.products) {
      upProd.run({
        ...p,
        priceIncludesTax: b(p.priceIncludesTax),
        isActive: b(p.isActive),
        variantAttrs: JSON.stringify(p.variantAttrs ?? {}),
      });
      delBarcodes.run(p.id);
      for (const bc of p.barcodes) {
        delBarcode.run(bc.barcode); // barcode may have moved from another product
        insBarcode.run(bc.barcode, p.id, bc.unitLabel, bc.factor);
      }
    }

    const upSup = db.prepare(
      `INSERT INTO suppliers (id, name, gstin, state_code, phone, email, address, is_active)
       VALUES (@id, @name, @gstin, @stateCode, @phone, @email, @address, @isActive)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, gstin=excluded.gstin, state_code=excluded.state_code, phone=excluded.phone,
         email=excluded.email, address=excluded.address, is_active=excluded.is_active`,
    );
    for (const s of page.suppliers) upSup.run({ ...s, isActive: b(s.isActive) });

    const upCust = db.prepare(
      `INSERT INTO customers (id, name, phone, email, gstin, state_code, address, updated_at)
       VALUES (@id, @name, @phone, @email, @gstin, @stateCode, @address, @now)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name, phone=excluded.phone, email=excluded.email, gstin=excluded.gstin,
         state_code=excluded.state_code, address=excluded.address`,
    );
    for (const c of page.customers) if (!hasPendingFor(db, c.id)) upCust.run({ ...c, now: nowIso() });

    for (const po of page.purchaseOrders) {
      if (hasPendingFor(db, po.id)) {
        skippedDocs++;
        continue;
      }
      db.prepare(
        `INSERT INTO purchase_orders (id, po_no, supplier_id, location_id, status, expected_date, notes, created_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET po_no=excluded.po_no, supplier_id=excluded.supplier_id, status=excluded.status,
           expected_date=excluded.expected_date, notes=excluded.notes`,
      ).run(po.id, po.poNo, po.supplierId, po.locationId, po.status, po.expectedDate, po.notes, new Date(po.createdAt).toISOString());
      db.prepare('DELETE FROM purchase_order_lines WHERE purchase_order_id = ?').run(po.id);
      const ins = db.prepare('INSERT INTO purchase_order_lines (id, purchase_order_id, product_id, qty, qty_received, unit_cost, gst_rate_bp) VALUES (?,?,?,?,?,?,?)');
      for (const l of po.lines) ins.run(l.id, po.id, l.productId, l.qty, l.qtyReceived, l.unitCost, l.gstRateBp);
    }

    for (const t of page.transfers) {
      if (hasPendingFor(db, t.id)) {
        skippedDocs++;
        continue;
      }
      db.prepare(
        `INSERT INTO stock_transfers (id, transfer_no, source_location_id, dest_location_id, requested_by_location_id, status, notes, status_reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, notes=excluded.notes, status_reason=excluded.status_reason, updated_at=excluded.updated_at`,
      ).run(
        t.id, t.transferNo, t.sourceLocationId, t.destLocationId, t.requestedByLocationId, t.status, t.notes, t.statusReason,
        new Date(t.createdAt).toISOString(), new Date(t.updatedAt).toISOString(),
      );
      const upLine = db.prepare(
        `INSERT INTO transfer_lines (id, transfer_id, product_id, qty_requested, qty_approved, qty_dispatched, qty_received, qty_damaged)
         VALUES (@id, @transferId, @productId, @qtyRequested, @qtyApproved, @qtyDispatched, @qtyReceived, @qtyDamaged)
         ON CONFLICT(id) DO UPDATE SET qty_approved=excluded.qty_approved, qty_dispatched=excluded.qty_dispatched,
           qty_received=excluded.qty_received, qty_damaged=excluded.qty_damaged`,
      );
      for (const l of t.lines) upLine.run({ ...l, transferId: t.id });
    }

    for (const m of page.movements) {
      const applied = applyMovement(db, {
        id: m.id,
        locationId: m.locationId,
        productId: m.productId,
        qtyDelta: m.qtyDelta,
        movementType: m.movementType,
        refType: m.refType,
        refId: m.refId,
        unitCost: m.unitCost,
        occurredAt: new Date(m.occurredAt).toISOString(),
        origin: 'REMOTE',
      });
      if (applied) movements++;
    }

    if (page.cursor) {
      setMeta(db, 'pull_cursor', page.cursor);
      setMeta(db, 'last_pull_at', nowIso());
    }
  });
  return { movements, skippedDocs };
}

/** Overwrite local copies of documents with the server's current state (after a rejection). */
export function applyDocRefresh(db: DB, docs: Pick<PullResponse, 'transfers' | 'purchaseOrders'>) {
  return applyPull(db, {
    cursor: '',
    hasMore: false,
    settings: null,
    locations: [],
    users: [],
    categories: [],
    products: [],
    suppliers: [],
    customers: [],
    movements: [],
    transfers: docs.transfers,
    purchaseOrders: docs.purchaseOrders,
  });
}
