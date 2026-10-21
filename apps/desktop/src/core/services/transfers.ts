import { z } from 'zod';
import {
  canTransition,
  checkTransferRoute,
  deriveFulfilmentStatus,
  uuidv7,
  type TransferAction,
  type TransferRow,
  type TransferStatus,
} from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso, tx } from '../db/connection';
import { requireHere, type CoreContext, type DeviceInfo } from '../context';
import { notFound, validation } from '../errors';
import { getLocation, getProductsByIds } from './catalog';
import { getSettings } from './meta';
import { enqueue } from './outbox';
import { nextDocNumber } from './numbering';
import { applyMovement, assertAvailable, avgCost, onHand, reserved } from './stock';
import { auditLocal } from './audit';

export interface TransferDetail extends TransferRow {
  sourceName: string;
  destName: string;
  direction: 'OUTGOING' | 'INCOMING';
  lines: (TransferRow['lines'][number] & { productName: string; sku: string; unit: string; available?: number })[];
  pendingSync: boolean;
}

function loadTransfer(db: DB, id: string): TransferRow {
  const t = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id) as any;
  if (!t) throw notFound('Transfer');
  const lines = db.prepare('SELECT * FROM transfer_lines WHERE transfer_id = ? ORDER BY rowid').all(id) as any[];
  return {
    id: t.id,
    transferNo: t.transfer_no,
    sourceLocationId: t.source_location_id,
    destLocationId: t.dest_location_id,
    requestedByLocationId: t.requested_by_location_id,
    status: t.status,
    notes: t.notes,
    statusReason: t.status_reason,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    lines: lines.map((l) => ({
      id: l.id,
      productId: l.product_id,
      qtyRequested: l.qty_requested,
      qtyApproved: l.qty_approved,
      qtyDispatched: l.qty_dispatched,
      qtyReceived: l.qty_received,
      qtyDamaged: l.qty_damaged,
    })),
  };
}

export function getTransfer(ctx: CoreContext, id: string): TransferDetail {
  const db = ctx.db;
  const t = loadTransfer(db, id);
  const here = ctx.device?.locationId;
  const products = getProductsByIds(db, t.lines.map((l) => l.productId));
  const name = (locId: string) => (db.prepare('SELECT name FROM locations WHERE id = ?').get(locId) as { name: string } | undefined)?.name ?? 'Unknown';
  const pending = !!db
    .prepare(`SELECT 1 FROM outbox o, json_each(o.doc_refs) j WHERE o.status = 'PENDING' AND j.value = ? LIMIT 1`)
    .get(id);
  return {
    ...t,
    sourceName: name(t.sourceLocationId),
    destName: name(t.destLocationId),
    direction: t.sourceLocationId === here ? 'OUTGOING' : 'INCOMING',
    pendingSync: pending,
    lines: t.lines.map((l) => {
      const p = products.get(l.productId);
      return {
        ...l,
        productName: p?.name ?? 'Unknown product',
        sku: p?.sku ?? '',
        unit: p?.unit ?? '',
        available: here === t.sourceLocationId ? onHand(db, here, l.productId) - reserved(db, here, l.productId, t.id) : undefined,
      };
    }),
  };
}

export function listTransfers(db: DB, locationId: string, q: { status?: TransferStatus; direction?: 'OUTGOING' | 'INCOMING'; openOnly?: boolean } = {}) {
  const where: string[] = ['(t.source_location_id = @loc OR t.dest_location_id = @loc)'];
  if (q.status) where.push('t.status = @status');
  if (q.direction === 'OUTGOING') where.push('t.source_location_id = @loc');
  if (q.direction === 'INCOMING') where.push('t.dest_location_id = @loc');
  if (q.openOnly) where.push(`t.status NOT IN ('REJECTED','CANCELLED','RECEIVED','CLOSED_WITH_DISCREPANCY')`);
  return db
    .prepare(
      `SELECT t.id, t.transfer_no AS transferNo, t.status, t.created_at AS createdAt, t.updated_at AS updatedAt,
              t.source_location_id AS sourceLocationId, t.dest_location_id AS destLocationId,
              sl.name AS sourceName, dl.name AS destName,
              CASE WHEN t.source_location_id = @loc THEN 'OUTGOING' ELSE 'INCOMING' END AS direction,
              (SELECT sum(qty_requested) FROM transfer_lines l WHERE l.transfer_id = t.id) AS qtyRequested,
              (SELECT sum(qty_dispatched) FROM transfer_lines l WHERE l.transfer_id = t.id) AS qtyDispatched,
              (SELECT sum(qty_received) FROM transfer_lines l WHERE l.transfer_id = t.id) AS qtyReceived,
              EXISTS (SELECT 1 FROM outbox o, json_each(o.doc_refs) j WHERE o.status = 'PENDING' AND j.value = t.id) AS pendingSync
         FROM stock_transfers t LEFT JOIN locations sl ON sl.id = t.source_location_id LEFT JOIN locations dl ON dl.id = t.dest_location_id
        WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC LIMIT 500`,
    )
    .all({ loc: locationId, status: q.status ?? null });
}

function assertSideHere(t: TransferRow, device: DeviceInfo, action: TransferAction) {
  const isSource = t.sourceLocationId === device.locationId;
  const isDest = t.destLocationId === device.locationId;
  const ok = action === 'CANCEL' ? isSource || isDest : ['APPROVE', 'REJECT', 'DISPATCH'].includes(action) ? isSource : isDest;
  if (!ok) {
    const side = ['RECEIVE', 'CLOSE'].includes(action) ? 'destination' : 'source';
    throw validation(`Only the ${side} location can ${action.toLowerCase()} this transfer`);
  }
  if (!canTransition(t.status, action)) throw validation(`Cannot ${action.toLowerCase()} a transfer that is ${t.status.toLowerCase().replace(/_/g, ' ')}`);
}

function setStatus(db: DB, id: string, status: TransferStatus, reason?: string | null) {
  db.prepare('UPDATE stock_transfers SET status = ?, status_reason = coalesce(?, status_reason), updated_at = ? WHERE id = ?').run(status, reason ?? null, nowIso(), id);
}

// ---------------------------------------------------------------------------

export const createTransferSchema = z.object({
  sourceLocationId: z.uuid(),
  destLocationId: z.uuid(),
  notes: z.string().trim().max(500).nullish(),
  lines: z.array(z.object({ productId: z.uuid(), qty: z.number().int().positive() })).min(1, 'Add at least one product'),
});
export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/**
 * Create a transfer from this location. As the destination it is a stock request
 * (REQUESTED); as the source it is a direct dispatch order (auto-approved).
 */
export function createTransfer(ctx: CoreContext, raw: CreateTransferInput) {
  const input = createTransferSchema.parse(raw);
  const db = ctx.db;
  const asSource = input.sourceLocationId === ctx.device?.locationId;
  const { session, device } = requireHere(ctx, asSource ? 'transfers.dispatch' : 'transfers.request');
  if (!asSource && input.destLocationId !== device.locationId) throw validation('A transfer must start or end at this location');
  if (new Set(input.lines.map((l) => l.productId)).size !== input.lines.length) throw validation('Each product may appear only once');
  const src = getLocation(db, input.sourceLocationId);
  const dst = getLocation(db, input.destLocationId);
  const settings = getSettings(db);
  const route = checkTransferRoute(src, dst, settings);
  if (!route.ok) throw validation(route.reason);
  const products = getProductsByIds(db, input.lines.map((l) => l.productId));
  if (products.size !== input.lines.length) throw validation('Unknown product');

  const result = tx(db, () => {
    if (asSource) {
      assertAvailable(db, device.locationId, new Map(input.lines.map((l) => [l.productId, l.qty])), { names: new Map([...products].map(([k, v]) => [k, v.name])) });
    }
    const id = uuidv7();
    const transferNo = nextDocNumber(db, 'TRANSFER', getLocation(db, device.locationId), device.deviceNo);
    const now = nowIso();
    const status: TransferStatus = asSource ? 'APPROVED' : 'REQUESTED';
    db.prepare(
      `INSERT INTO stock_transfers (id, transfer_no, source_location_id, dest_location_id, requested_by_location_id, status, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(id, transferNo, src.id, dst.id, device.locationId, status, input.notes ?? null, now, now);
    const lines = input.lines.map((l) => ({ id: uuidv7(), productId: l.productId, qtyRequested: l.qty }));
    for (const l of lines) {
      db.prepare('INSERT INTO transfer_lines (id, transfer_id, product_id, qty_requested, qty_approved) VALUES (?,?,?,?,?)').run(
        l.id, id, l.productId, l.qtyRequested, asSource ? l.qtyRequested : 0,
      );
    }
    enqueue(db, {
      type: 'transfer.create',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id, transferNo, sourceLocationId: src.id, destLocationId: dst.id, notes: input.notes ?? null, autoApprove: asSource, lines },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'transfer.create', 'transfer', id, { transferNo, status });
    return { id, transferNo, status };
  });
  ctx.onLocalWrite();
  return result;
}

export function approveTransfer(ctx: CoreContext, id: string, lines: { lineId: string; qtyApproved: number }[]) {
  const { session, device } = requireHere(ctx, 'transfers.approve');
  const db = ctx.db;
  tx(db, () => {
    const t = loadTransfer(db, id);
    assertSideHere(t, device, 'APPROVE');
    const byId = new Map(t.lines.map((l) => [l.id, l]));
    const approved = new Map<string, number>();
    for (const l of lines) {
      const line = byId.get(l.lineId);
      if (!line) throw validation('Line does not belong to this transfer');
      if (!Number.isInteger(l.qtyApproved) || l.qtyApproved < 0 || l.qtyApproved > line.qtyRequested) throw validation('Approved quantity must be between 0 and the requested quantity');
      approved.set(l.lineId, l.qtyApproved);
    }
    if ([...approved.values()].every((q) => q === 0)) throw validation('Approve at least one unit, or reject the request');
    const products = getProductsByIds(db, t.lines.map((l) => l.productId));
    const wanted = new Map<string, number>();
    for (const line of t.lines) wanted.set(line.productId, approved.get(line.id) ?? 0);
    assertAvailable(db, device.locationId, wanted, { excludeTransferId: id, names: new Map([...products].map(([k, v]) => [k, v.name])) });
    for (const line of t.lines) db.prepare('UPDATE transfer_lines SET qty_approved = ? WHERE id = ?').run(approved.get(line.id) ?? 0, line.id);
    setStatus(db, id, 'APPROVED');
    enqueue(db, {
      type: 'transfer.approve',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { transferId: id, lines: t.lines.map((l) => ({ lineId: l.id, qtyApproved: approved.get(l.id) ?? 0 })) },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'transfer.approve', 'transfer', id);
  });
  ctx.onLocalWrite();
  return getTransfer(ctx, id);
}

export function rejectTransfer(ctx: CoreContext, id: string, reason: string) {
  return simpleTransition(ctx, id, 'REJECT', 'REJECTED', reason, 'transfers.approve');
}

export function cancelTransfer(ctx: CoreContext, id: string, reason: string) {
  const db = ctx.db;
  const t = loadTransfer(db, id);
  const perm = t.sourceLocationId === ctx.device?.locationId ? 'transfers.approve' : 'transfers.request';
  return simpleTransition(ctx, id, 'CANCEL', 'CANCELLED', reason, perm);
}

function simpleTransition(
  ctx: CoreContext,
  id: string,
  action: 'REJECT' | 'CANCEL',
  to: TransferStatus,
  reason: string,
  permission: 'transfers.approve' | 'transfers.request',
) {
  const { session, device } = requireHere(ctx, permission);
  const r = z.string().trim().min(2, 'Enter a reason').max(300).parse(reason);
  const db = ctx.db;
  tx(db, () => {
    const t = loadTransfer(db, id);
    assertSideHere(t, device, action);
    setStatus(db, id, to, r);
    enqueue(db, {
      type: action === 'REJECT' ? 'transfer.reject' : 'transfer.cancel',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { transferId: id, reason: r },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, `transfer.${action.toLowerCase()}`, 'transfer', id, { reason: r });
  });
  ctx.onLocalWrite();
  return getTransfer(ctx, id);
}

/** Dispatch (possibly partial) from the source: stock leaves this location now. */
export function dispatchTransfer(ctx: CoreContext, id: string, lines: { lineId: string; qty: number }[], notes?: string | null) {
  const { session, device } = requireHere(ctx, 'transfers.dispatch');
  const db = ctx.db;
  tx(db, () => {
    const t = loadTransfer(db, id);
    assertSideHere(t, device, 'DISPATCH');
    const byId = new Map(t.lines.map((l) => [l.id, { ...l }]));
    const toDispatch = lines.filter((l) => l.qty > 0);
    if (toDispatch.length === 0) throw validation('Enter a quantity to dispatch');
    const wanted = new Map<string, number>();
    for (const l of toDispatch) {
      const line = byId.get(l.lineId);
      if (!line) throw validation('Line does not belong to this transfer');
      if (!Number.isInteger(l.qty) || l.qty > line.qtyApproved - line.qtyDispatched) throw validation('Cannot dispatch more than the approved quantity remaining');
      wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + l.qty);
    }
    const products = getProductsByIds(db, [...wanted.keys()]);
    assertAvailable(db, device.locationId, wanted, { excludeTransferId: id, names: new Map([...products].map(([k, v]) => [k, v.name])) });
    const dispatchId = uuidv7();
    const now = nowIso();
    const payloadLines = toDispatch.map((l) => {
      const line = byId.get(l.lineId)!;
      const movementId = uuidv7();
      line.qtyDispatched += l.qty;
      db.prepare('UPDATE transfer_lines SET qty_dispatched = ? WHERE id = ?').run(line.qtyDispatched, line.id);
      applyMovement(db, {
        id: movementId,
        locationId: device.locationId,
        productId: line.productId,
        qtyDelta: -l.qty,
        movementType: 'TRANSFER_OUT',
        refType: 'TRANSFER',
        refId: id,
        unitCost: avgCost(db, device.locationId, line.productId),
        userId: session.user.id,
        occurredAt: now,
        origin: 'LOCAL',
      });
      return { id: movementId, lineId: l.lineId, qty: l.qty };
    });
    setStatus(db, id, deriveFulfilmentStatus([...byId.values()]));
    enqueue(db, {
      type: 'transfer.dispatch',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id: dispatchId, transferId: id, notes: notes ?? null, lines: payloadLines },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'transfer.dispatch', 'transfer', id, { lines: payloadLines.length });
  });
  ctx.onLocalWrite();
  return getTransfer(ctx, id);
}

/** Receive (possibly partial) at the destination, recording damaged units separately. */
export function receiveTransfer(ctx: CoreContext, id: string, lines: { lineId: string; qtyReceived: number; qtyDamaged: number }[], notes?: string | null) {
  const { session, device } = requireHere(ctx, 'transfers.receive');
  const db = ctx.db;
  tx(db, () => {
    const t = loadTransfer(db, id);
    assertSideHere(t, device, 'RECEIVE');
    const byId = new Map(t.lines.map((l) => [l.id, { ...l }]));
    const toReceive = lines.filter((l) => l.qtyReceived + l.qtyDamaged > 0);
    if (toReceive.length === 0) throw validation('Enter the quantities received');
    const now = nowIso();
    const receiptId = uuidv7();
    const payloadLines = toReceive.map((l) => {
      const line = byId.get(l.lineId);
      if (!line) throw validation('Line does not belong to this transfer');
      if (![l.qtyReceived, l.qtyDamaged].every((n) => Number.isInteger(n) && n >= 0)) throw validation('Quantities must be whole numbers');
      const outstanding = line.qtyDispatched - line.qtyReceived - line.qtyDamaged;
      if (l.qtyReceived + l.qtyDamaged > outstanding) throw validation(`Only ${outstanding} unit(s) of this line are in transit`);
      line.qtyReceived += l.qtyReceived;
      line.qtyDamaged += l.qtyDamaged;
      db.prepare('UPDATE transfer_lines SET qty_received = ?, qty_damaged = ? WHERE id = ?').run(line.qtyReceived, line.qtyDamaged, line.id);
      const movementId = uuidv7();
      if (l.qtyReceived > 0) {
        const cost = (db.prepare('SELECT purchase_price AS c FROM products WHERE id = ?').get(line.productId) as { c: number } | undefined)?.c ?? 0;
        applyMovement(db, {
          id: movementId,
          locationId: device.locationId,
          productId: line.productId,
          qtyDelta: l.qtyReceived,
          movementType: 'TRANSFER_IN',
          refType: 'TRANSFER',
          refId: id,
          unitCost: cost,
          userId: session.user.id,
          occurredAt: now,
          origin: 'LOCAL',
        });
      }
      return { id: movementId, lineId: l.lineId, qtyReceived: l.qtyReceived, qtyDamaged: l.qtyDamaged };
    });
    setStatus(db, id, deriveFulfilmentStatus([...byId.values()]));
    enqueue(db, {
      type: 'transfer.receive',
      locationId: device.locationId,
      userId: session.user.id,
      payload: { id: receiptId, transferId: id, notes: notes ?? null, lines: payloadLines },
      docRefs: [id],
    });
    auditLocal(db, session.user.id, 'transfer.receive', 'transfer', id, { lines: payloadLines });
  });
  ctx.onLocalWrite();
  return getTransfer(ctx, id);
}

/** Destination closes the transfer; any shortfall becomes a discrepancy for review. */
export function closeTransfer(ctx: CoreContext, id: string, notes?: string | null) {
  const { session, device } = requireHere(ctx, 'transfers.receive');
  const db = ctx.db;
  tx(db, () => {
    const t = loadTransfer(db, id);
    assertSideHere(t, device, 'CLOSE');
    const discrepancy = t.lines.some((l) => l.qtyDispatched - l.qtyReceived - l.qtyDamaged > 0 || l.qtyDamaged > 0);
    setStatus(db, id, discrepancy ? 'CLOSED_WITH_DISCREPANCY' : 'RECEIVED', notes ?? null);
    enqueue(db, { type: 'transfer.close', locationId: device.locationId, userId: session.user.id, payload: { transferId: id, notes: notes ?? null }, docRefs: [id] });
    auditLocal(db, session.user.id, 'transfer.close', 'transfer', id, { discrepancy });
  });
  ctx.onLocalWrite();
  return getTransfer(ctx, id);
}
