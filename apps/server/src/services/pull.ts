import type { PullResponse } from '@store/shared';
import { many, one, withTransaction } from '../db/pool.js';
import type { AppContext } from '../context.js';
import type { AuthedDevice } from '../middleware/auth.js';
import {
  CATEGORY_COLS,
  CUSTOMER_COLS,
  LOCATION_COLS,
  MOVEMENT_COLS,
  PO_COLS,
  PRODUCT_COLS,
  SUPPLIER_COLS,
  TRANSFER_COLS,
  USER_COLS,
  getSettings,
} from './rows.js';

/** Max number of change transactions returned per pull page. */
const SEQ_WINDOW = 500;

/**
 * Incremental pull of everything the device needs, scoped to its location.
 * Returns changes with server_seq in (cursor, upto]. Because server_seq is
 * assigned in commit order (see migration 001), every change <= upto is
 * committed and visible in this snapshot.
 */
export async function pull(
  ctx: AppContext,
  device: AuthedDevice,
  cursorRaw: string | undefined,
  opts: { includeOwnMovements?: boolean } = {},
): Promise<PullResponse> {
  const cursor = cursorRaw && /^\d+$/.test(cursorRaw) ? cursorRaw : '0';
  const result = await withTransaction(
    ctx.db,
    async (tx) => {
      const head = await one<{ v: string }>(tx, 'SELECT value::text AS v FROM sync_counter');
      const headSeq = BigInt(head!.v);
      const from = BigInt(cursor);
      const upto = headSeq - from > BigInt(SEQ_WINDOW) ? from + BigInt(SEQ_WINDOW) : headSeq;
      const range = [from.toString(), upto.toString()];
      const loc = device.locationId;

      const company = await one(tx, 'SELECT server_seq FROM company WHERE server_seq > $1 AND server_seq <= $2', range);
      const locations = await many(tx, `SELECT ${LOCATION_COLS} FROM locations l WHERE l.server_seq > $1 AND l.server_seq <= $2`, range);
      // All users (devices decide access from locationIds); password hashes are never sent to devices.
      const users = await many(tx, `SELECT ${USER_COLS} FROM users u WHERE u.server_seq > $1 AND u.server_seq <= $2`, range);
      const categories = await many(tx, `SELECT ${CATEGORY_COLS} FROM categories c WHERE c.server_seq > $1 AND c.server_seq <= $2`, range);
      const products = await many(tx, `SELECT ${PRODUCT_COLS} FROM products p WHERE p.server_seq > $1 AND p.server_seq <= $2`, range);
      const suppliers = await many(tx, `SELECT ${SUPPLIER_COLS} FROM suppliers s WHERE s.server_seq > $1 AND s.server_seq <= $2`, range);
      const customers = await many(tx, `SELECT ${CUSTOMER_COLS} FROM customers c WHERE c.server_seq > $1 AND c.server_seq <= $2`, range);
      const purchaseOrders = await many(tx, `SELECT ${PO_COLS} FROM purchase_orders po WHERE po.server_seq > $1 AND po.server_seq <= $2 AND po.location_id = $3`, [...range, loc]);
      const transfers = await many(
        tx,
        `SELECT ${TRANSFER_COLS} FROM stock_transfers t WHERE t.server_seq > $1 AND t.server_seq <= $2
           AND (t.source_location_id = $3 OR t.dest_location_id = $3)`,
        [...range, loc],
      );
      // Movements for this location written by sibling terminals or centrally (admin).
      // After a local restore from backup the device also re-fetches its own movements.
      const movements = await many(
        tx,
        `SELECT ${MOVEMENT_COLS} FROM stock_movements m WHERE m.location_id = $3 AND m.server_seq > $1 AND m.server_seq <= $2
           AND ($5::boolean OR m.device_id IS DISTINCT FROM $4) ORDER BY m.server_seq, m.id`,
        [...range, loc, device.id, opts.includeOwnMovements ?? false],
      );
      return {
        cursor: upto.toString(),
        hasMore: upto < headSeq,
        settings: company || from === 0n ? await getSettings(tx) : null,
        locations,
        users,
        categories,
        products,
        suppliers,
        customers,
        purchaseOrders,
        transfers,
        movements,
      } as PullResponse;
    },
    'REPEATABLE READ',
  );
  await ctx.db.query('UPDATE devices SET last_pull_at = now() WHERE id = $1', [device.id]);
  return result;
}

/** Current server state of specific documents (used after the server rejected local changes to them). */
export async function refreshDocs(ctx: AppContext, device: AuthedDevice, ids: string[]) {
  const transfers = await many(
    ctx.db,
    `SELECT ${TRANSFER_COLS} FROM stock_transfers t WHERE t.id = ANY($1::uuid[]) AND (t.source_location_id = $2 OR t.dest_location_id = $2)`,
    [ids, device.locationId],
  );
  const purchaseOrders = await many(ctx.db, `SELECT ${PO_COLS} FROM purchase_orders po WHERE po.id = ANY($1::uuid[]) AND po.location_id = $2`, [
    ids,
    device.locationId,
  ]);
  return { transfers, purchaseOrders };
}
