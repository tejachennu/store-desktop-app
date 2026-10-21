import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { uuidv7 } from '@store/shared';
import { createTestEnv, envelope, login, opening, pull, push, registerDevice, stockOf, type TestEnv } from './helpers.js';

let env: TestEnv;
let waKey: string;
let wbKey: string;
let b1Key: string;
let b2Key: string;

beforeAll(async () => {
  env = await createTestEnv();
  [waKey, wbKey, b1Key, b2Key] = await Promise.all([
    registerDevice(env, env.ids.wA),
    registerDevice(env, env.ids.wB),
    registerDevice(env, env.ids.b1),
    registerDevice(env, env.ids.b2),
  ]);
  const r = await push(env, waKey, [opening(env.ids.wA, env.ids.admin, [{ productId: env.ids.rice, qty: 100, cost: 40000 }, { productId: env.ids.soap, qty: 200, cost: 2400 }])]);
  expect(r.body.results[0].status).toBe('ACCEPTED');
});
afterAll(async () => env.close());

function createTransfer(requesterKey: string, requesterLoc: string, userId: string, src: string, dst: string, lines: { productId: string; qty: number }[], autoApprove = false) {
  const payload = {
    id: uuidv7(),
    transferNo: `TR-${Math.random().toString(36).slice(2, 9)}`,
    sourceLocationId: src,
    destLocationId: dst,
    notes: null,
    autoApprove,
    lines: lines.map((l) => ({ id: uuidv7(), productId: l.productId, qtyRequested: l.qty })),
  };
  return { payload, res: push(env, requesterKey, [envelope('transfer.create', requesterLoc, userId, payload)]) };
}

describe('warehouse → branch transfer lifecycle', () => {
  it('request → approve → partial dispatch → dispatch → partial receipt with damage → close with shortage → resolve', async () => {
    // 1. Branch requests stock from warehouse A
    const { payload: t, res } = createTransfer(b1Key, env.ids.b1, env.ids.b1Mgr, env.ids.wA, env.ids.b1, [
      { productId: env.ids.rice, qty: 30 },
      { productId: env.ids.soap, qty: 50 },
    ]);
    expect((await res).body.results[0].status).toBe('ACCEPTED');
    const [riceLine, soapLine] = t.lines;

    // Branch cannot approve its own request
    const wrongSide = await push(env, b1Key, [
      envelope('transfer.approve', env.ids.b1, env.ids.b1Mgr, { transferId: t.id, lines: [{ lineId: riceLine.id, qtyApproved: 30 }] }),
    ]);
    expect(wrongSide.body.results[0].error).toMatch(/Only the source/);

    // 2. Warehouse approves less rice than requested → reservation
    const approve = await push(env, waKey, [
      envelope('transfer.approve', env.ids.wA, env.ids.whMgr, {
        transferId: t.id,
        lines: [
          { lineId: riceLine.id, qtyApproved: 20 },
          { lineId: soapLine.id, qtyApproved: 50 },
        ],
      }),
    ]);
    expect(approve.body.results[0].status).toBe('ACCEPTED');
    const admin = await login(env.app, 'admin');
    const stock = await request(env.app).get(`/api/stock?locationId=${env.ids.wA}&productId=${env.ids.rice}`).set('Authorization', `Bearer ${admin}`);
    expect(stock.body[0]).toMatchObject({ qtyOnHand: 100, reserved: 20, available: 80 });

    // 3. Partial dispatch then the rest
    const d1 = envelope('transfer.dispatch', env.ids.wA, env.ids.whMgr, {
      id: uuidv7(),
      transferId: t.id,
      notes: 'Truck 1',
      lines: [{ id: uuidv7(), lineId: riceLine.id, qty: 20 }, { id: uuidv7(), lineId: soapLine.id, qty: 30 }],
    });
    expect((await push(env, waKey, [d1])).body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(t.id)).status).toBe('PARTIALLY_DISPATCHED');
    const d2 = envelope('transfer.dispatch', env.ids.wA, env.ids.whMgr, {
      id: uuidv7(), transferId: t.id, notes: 'Truck 2', lines: [{ id: uuidv7(), lineId: soapLine.id, qty: 20 }],
    });
    expect((await push(env, waKey, [d2])).body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(t.id)).status).toBe('DISPATCHED');
    expect(await stockOf(env.db, env.ids.wA, env.ids.rice)).toBe(80);
    expect(await stockOf(env.db, env.ids.wA, env.ids.soap)).toBe(150);
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(0);

    // Cancelling after dispatch is not allowed
    const cancel = await push(env, b1Key, [envelope('transfer.cancel', env.ids.b1, env.ids.b1Mgr, { transferId: t.id, reason: 'too late' })]);
    expect(cancel.body.results[0].status).toBe('REJECTED');

    // Destination sees the transfer through pull
    const pulled = await pull(env, b1Key);
    const seen = pulled.body.transfers.find((x: { id: string }) => x.id === t.id);
    expect(seen.lines.find((l: { id: string }) => l.id === riceLine.id).qtyDispatched).toBe(20);

    // 4. Partial receipt: rice 18 good + 1 damaged, soap all 50
    const rec = envelope('transfer.receive', env.ids.b1, env.ids.b1Mgr, {
      id: uuidv7(),
      transferId: t.id,
      notes: null,
      lines: [
        { id: uuidv7(), lineId: riceLine.id, qtyReceived: 18, qtyDamaged: 1 },
        { id: uuidv7(), lineId: soapLine.id, qtyReceived: 50, qtyDamaged: 0 },
      ],
    });
    expect((await push(env, b1Key, [rec])).body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(t.id)).status).toBe('PARTIALLY_RECEIVED');
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(18);
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(50);

    // Over-receipt is rejected
    const over = await push(env, b1Key, [
      envelope('transfer.receive', env.ids.b1, env.ids.b1Mgr, {
        id: uuidv7(), transferId: t.id, notes: null, lines: [{ id: uuidv7(), lineId: riceLine.id, qtyReceived: 5, qtyDamaged: 0 }],
      }),
    ]);
    expect(over.body.results[0].status).toBe('REJECTED');

    // 5. Close: 1 rice missing → discrepancy
    const close = await push(env, b1Key, [envelope('transfer.close', env.ids.b1, env.ids.b1Mgr, { transferId: t.id, notes: '1 bag missing' })]);
    expect(close.body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(t.id)).status).toBe('CLOSED_WITH_DISCREPANCY');
    const items = await request(env.app).get('/api/reconciliation?type=TRANSFER_DISCREPANCY').set('Authorization', `Bearer ${admin}`);
    const kinds = items.body.filter((i: { refId: string }) => i.refId === t.id).map((i: { details: { kind: string }; qty: number }) => `${i.details.kind}:${i.qty}`).sort();
    expect(kinds).toEqual(['DAMAGED:1', 'MISSING:1']);

    // 6. Admin resolves the missing bag as returned to source → central movement pulled by warehouse
    const missing = items.body.find((i: { refId: string; details: { kind: string } }) => i.refId === t.id && i.details.kind === 'MISSING');
    const cursorBefore = (await pullAllCursor(waKey)).cursor;
    const resolve = await request(env.app)
      .post(`/api/reconciliation/${missing.id}/resolve`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ resolution: 'RETURN_TO_SOURCE', note: 'Found on truck' });
    expect(resolve.status).toBe(200);
    expect(await stockOf(env.db, env.ids.wA, env.ids.rice)).toBe(81);
    const after = await pull(env, waKey, cursorBefore);
    expect(after.body.movements).toHaveLength(1);
    expect(after.body.movements[0]).toMatchObject({ movementType: 'TRANSFER_RESOLUTION', qtyDelta: 1, deviceId: null });

    // Ledger integrity: every level equals the sum of its movements
    const mismatch = await env.db.query(`
      SELECT s.location_id, s.product_id FROM stock_levels s
       WHERE s.qty_on_hand <> (SELECT coalesce(sum(qty_delta),0) FROM stock_movements m WHERE m.location_id = s.location_id AND m.product_id = s.product_id)`);
    expect(mismatch.rows).toEqual([]);
  });
});

describe('transfer rules', () => {
  it('allows warehouse → warehouse direct dispatch', async () => {
    const { payload, res } = createTransfer(waKey, env.ids.wA, env.ids.whMgr, env.ids.wA, env.ids.wB, [{ productId: env.ids.soap, qty: 10 }], true);
    expect((await res).body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(payload.id)).status).toBe('APPROVED');
    const d = await push(env, waKey, [
      envelope('transfer.dispatch', env.ids.wA, env.ids.whMgr, { id: uuidv7(), transferId: payload.id, notes: null, lines: [{ id: uuidv7(), lineId: payload.lines[0].id, qty: 10 }] }),
    ]);
    expect(d.body.results[0].status).toBe('ACCEPTED');
    const r = await push(env, wbKey, [
      envelope('transfer.receive', env.ids.wB, env.ids.whMgr, { id: uuidv7(), transferId: payload.id, notes: null, lines: [{ id: uuidv7(), lineId: payload.lines[0].id, qtyReceived: 10, qtyDamaged: 0 }] }),
    ]);
    expect(r.body.results[0].status).toBe('ACCEPTED');
    expect((await getTransfer(payload.id)).status).toBe('RECEIVED');
    expect(await stockOf(env.db, env.ids.wB, env.ids.soap)).toBe(10);
  });

  it('blocks branch → branch until enabled in settings', async () => {
    const blocked = createTransfer(b2Key, env.ids.b2, env.ids.admin, env.ids.b1, env.ids.b2, [{ productId: env.ids.soap, qty: 1 }]);
    const res = await blocked.res;
    expect(res.body.results[0].status).toBe('REJECTED');
    expect(res.body.results[0].error).toMatch(/Branch-to-branch/);
    await env.db.query('UPDATE company SET branch_to_branch_enabled = true');
    const allowed = createTransfer(b2Key, env.ids.b2, env.ids.admin, env.ids.b1, env.ids.b2, [{ productId: env.ids.soap, qty: 1 }]);
    expect((await allowed.res).body.results[0].status).toBe('ACCEPTED');
  });

  it('a direct dispatch can only be created by the source', async () => {
    const { res } = createTransfer(b1Key, env.ids.b1, env.ids.b1Mgr, env.ids.wA, env.ids.b1, [{ productId: env.ids.soap, qty: 1 }], true);
    expect((await res).body.results[0].error).toMatch(/source/);
  });

  it('accepts a dispatch that arrives after an offline cancel and raises a conflict', async () => {
    const { payload, res } = createTransfer(b1Key, env.ids.b1, env.ids.b1Mgr, env.ids.wA, env.ids.b1, [{ productId: env.ids.soap, qty: 5 }]);
    expect((await res).body.results[0].status).toBe('ACCEPTED');
    expect((await push(env, waKey, [envelope('transfer.approve', env.ids.wA, env.ids.whMgr, { transferId: payload.id, lines: [{ lineId: payload.lines[0].id, qtyApproved: 5 }] })])).body.results[0].status).toBe('ACCEPTED');
    // Branch cancels (synced first), warehouse had already dispatched offline.
    expect((await push(env, b1Key, [envelope('transfer.cancel', env.ids.b1, env.ids.b1Mgr, { transferId: payload.id, reason: 'not needed' })])).body.results[0].status).toBe('ACCEPTED');
    const before = await stockOf(env.db, env.ids.wA, env.ids.soap);
    const d = await push(env, waKey, [
      envelope('transfer.dispatch', env.ids.wA, env.ids.whMgr, { id: uuidv7(), transferId: payload.id, notes: null, lines: [{ id: uuidv7(), lineId: payload.lines[0].id, qty: 5 }] }),
    ]);
    expect(d.body.results[0].status).toBe('ACCEPTED');
    expect(await stockOf(env.db, env.ids.wA, env.ids.soap)).toBe(before - 5);
    expect((await getTransfer(payload.id)).status).toBe('DISPATCHED');
    const conflicts = await env.db.query(`SELECT count(*)::int AS n FROM reconciliation_items WHERE type = 'TRANSFER_CONFLICT' AND ref_id = $1`, [payload.id]);
    expect(conflicts.rows[0].n).toBe(1);
  });
});

async function getTransfer(id: string) {
  const r = await env.db.query('SELECT status FROM stock_transfers WHERE id = $1', [id]);
  return r.rows[0];
}

async function pullAllCursor(key: string) {
  let cursor = '0';
  for (;;) {
    const res = await pull(env, key, cursor);
    cursor = res.body.cursor;
    if (!res.body.hasMore) return { cursor };
  }
}
