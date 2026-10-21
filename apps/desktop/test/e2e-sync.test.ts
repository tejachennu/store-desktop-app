import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createTestEnv, PASSWORD, stockOf, type TestEnv } from '../../server/test/helpers';
import { StoreCore } from '../src/core/app';
import type { FetchLike } from '../src/core/sync/api-client';
import { setupConnect } from '../src/core/services/auth';
import { createSale } from '../src/core/services/sales';
import { createAdjustment, onHand } from '../src/core/services/stock';
import {
  approveTransfer,
  cancelTransfer,
  closeTransfer,
  createTransfer,
  dispatchTransfer,
  getTransfer,
  receiveTransfer,
} from '../src/core/services/transfers';
import { createHandlers } from '../src/core/api';
import { cleanupTempDirs, memorySecrets, tempDir } from './helpers';

/**
 * End-to-end: real central API + PostgreSQL, several desktop "PCs" (StoreCore
 * instances with their own SQLite files) and a controllable network.
 */

let env: TestEnv;
let server: Server;
let baseUrl: string;

/** Network switch shared by all simulated PCs. */
const net = { online: true, dropResponses: 0 };
const flakyFetch: FetchLike = async (input, init) => {
  if (!net.online) throw new TypeError('fetch failed: ECONNREFUSED');
  const res = await fetch(input, init);
  if (net.dropResponses > 0) {
    // The server processed the request but the response never arrived.
    net.dropResponses -= 1;
    await res.arrayBuffer();
    throw new TypeError('fetch failed: socket hang up');
  }
  return res;
};

async function registerPc(locationId: string, name: string, dataDir = tempDir(), secrets = memorySecrets()) {
  const core = new StoreCore({ dataDir, secrets, fetchImpl: flakyFetch, manualSync: true });
  const conn = await setupConnect(baseUrl, 'admin', PASSWORD, flakyFetch);
  await core.register({ serverUrl: conn.serverUrl, token: conn.token, locationId, deviceName: name });
  return core;
}

const sync = (...cores: StoreCore[]) => Promise.all(cores.map((c) => c.sync.syncNow({ force: true })));
const pending = (c: StoreCore) => (c.db.prepare(`SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'`).get() as { n: number }).n;

beforeAll(async () => {
  env = await createTestEnv();
  server = env.app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await env.close();
  cleanupTempDirs();
});

describe('device registration and login', () => {
  it('registers a PC, downloads master data and supports online then offline login', async () => {
    const pc = await registerPc(env.ids.b1, 'Counter 1');
    const products = (pc.db.prepare('SELECT count(*) AS n FROM products').get() as { n: number }).n;
    expect(products).toBe(3);
    expect(pc.ctx.device?.locationId).toBe(env.ids.b1);

    // First login must be online (caches the offline verifier)
    net.online = false;
    await expect(pc.login('b1cash', PASSWORD)).rejects.toThrow(/signed in on this computer before/);
    net.online = true;
    const online = await pc.login('b1cash', PASSWORD);
    expect(online.mode).toBe('online');

    // Later, during an internet outage
    net.online = false;
    const offline = await pc.login('b1cash', PASSWORD);
    expect(offline.mode).toBe('offline');
    expect(offline.accessToken).toBeNull();
    await expect(pc.login('b1cash', 'wrong-password1')).rejects.toThrow(/Invalid/);
    net.online = true;

    // Users not assigned to this branch cannot sign in here
    await expect(pc.login('b2cash', PASSWORD)).rejects.toThrow(/not assigned/);
    pc.close();
  });
});

describe('offline sales and synchronisation', () => {
  let t1: StoreCore;
  let t2: StoreCore;

  beforeAll(async () => {
    t1 = await registerPc(env.ids.b1, 'Counter A');
    t2 = await registerPc(env.ids.b1, 'Counter B');
    await t1.login('admin', PASSWORD);
    createAdjustment(t1.ctx, { kind: 'OPENING', reason: 'OPENING', lines: [{ productId: env.ids.soap, qtyDelta: 50, unitCost: 2400 }, { productId: env.ids.rice, qtyDelta: 10, unitCost: 40000 }] });
    await sync(t1);
    await sync(t2);
    await t1.login('b1cash', PASSWORD);
    await t2.login('b1cash', PASSWORD);
  });

  it('keeps selling during an outage and uploads everything exactly once when back online', async () => {
    expect(onHand(t2.db, env.ids.b1, env.ids.soap)).toBe(50); // opening stock fanned out to the sibling terminal
    net.online = false;
    for (let i = 0; i < 3; i++) createSale(t1.ctx, { lines: [{ productId: env.ids.soap, qty: 2 }], payments: [{ method: 'CASH', amount: 7000 }] });
    createSale(t2.ctx, { lines: [{ productId: env.ids.soap, qty: 4 }], payments: [{ method: 'UPI', amount: 14000 }] });
    await sync(t1, t2);
    expect(t1.sync.getStatus().state).toBe('offline');
    expect(pending(t1)).toBe(3);
    expect(pending(t2)).toBe(1);

    net.online = true;
    await sync(t1, t2);
    await sync(t1, t2); // second round fans out each sibling's movements
    expect(pending(t1)).toBe(0);
    expect(pending(t2)).toBe(0);
    const n = await env.db.query('SELECT count(*)::int AS n FROM sales WHERE location_id = $1', [env.ids.b1]);
    expect(n.rows[0].n).toBe(4);
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(40);
    expect(onHand(t1.db, env.ids.b1, env.ids.soap)).toBe(40);
    expect(onHand(t2.db, env.ids.b1, env.ids.soap)).toBe(40);
  });

  it('does not duplicate a sale when the push response is lost', async () => {
    const sale = createSale(t1.ctx, { lines: [{ productId: env.ids.rice, qty: 1 }], payments: [{ method: 'CARD', amount: 52000 }] });
    net.dropResponses = 1;
    await sync(t1);
    expect(pending(t1)).toBe(1); // client does not know the outcome
    const onServer = await env.db.query('SELECT count(*)::int AS n FROM sales WHERE id = $1', [sale.id]);
    expect(onServer.rows[0].n).toBe(1); // ...but the server committed it
    await sync(t1); // retry → DUPLICATE → marked synced
    expect(pending(t1)).toBe(0);
    const again = await env.db.query('SELECT count(*)::int AS n FROM sales WHERE id = $1', [sale.id]);
    expect(again.rows[0].n).toBe(1);
    expect(await stockOf(env.db, env.ids.b1, env.ids.rice)).toBe(9);
    const status = t1.db.prepare(`SELECT status, attempts FROM outbox WHERE type = 'sale.create' ORDER BY seq DESC LIMIT 1`).get() as { status: string; attempts: number };
    expect(status.status).toBe('SYNCED');
  });

  it('backs up and restores the local database, re-downloading what was synced after the backup', async () => {
    const backup = await t1.backupNow('manual');
    createSale(t1.ctx, { lines: [{ productId: env.ids.soap, qty: 5 }], payments: [{ method: 'CASH', amount: 17500 }] });
    await sync(t1);
    expect(onHand(t1.db, env.ids.b1, env.ids.soap)).toBe(35);

    t1.restore(backup.file);
    // The restored file predates the last sale: its movement is re-fetched from the server.
    expect(onHand(t1.db, env.ids.b1, env.ids.soap)).toBe(40);
    await t1.sync.syncNow({ force: true });
    expect(onHand(t1.db, env.ids.b1, env.ids.soap)).toBe(35);
    expect(await stockOf(env.db, env.ids.b1, env.ids.soap)).toBe(35);
    t1.stop();
  });

  it('rejects a corrupted backup file', async () => {
    const { writeFileSync } = await import('node:fs');
    const bad = `${tempDir()}/bad.db`;
    writeFileSync(bad, 'not a database');
    expect(() => t1.restore(bad)).toThrow(/cannot be opened|integrity|not a Store Manager/i);
    // The live database is untouched and still usable
    expect(onHand(t1.db, env.ids.b1, env.ids.soap)).toBe(35);
  });
});

describe('warehouse → branch transfer between two PCs', () => {
  it('runs the full request / approve / dispatch / receive cycle through the server', async () => {
    const wh = await registerPc(env.ids.wA, 'Warehouse PC');
    const br = await registerPc(env.ids.b2, 'Branch 2 PC');
    await wh.login('admin', PASSWORD);
    createAdjustment(wh.ctx, { kind: 'OPENING', reason: 'OPENING', lines: [{ productId: env.ids.oil, qtyDelta: 100, unitCost: 12000 }] });
    await br.login('admin', PASSWORD);

    // Branch requests 30 while offline
    net.online = false;
    const req = createTransfer(br.ctx, { sourceLocationId: env.ids.wA, destLocationId: env.ids.b2, lines: [{ productId: env.ids.oil, qty: 30 }] });
    net.online = true;
    await sync(br, wh);
    await sync(wh);
    const atWh = getTransfer(wh.ctx, req.id);
    expect(atWh.status).toBe('REQUESTED');
    expect(atWh.direction).toBe('OUTGOING');

    // Warehouse approves 25 and dispatches in two trucks
    const lineId = atWh.lines[0].id;
    approveTransfer(wh.ctx, req.id, [{ lineId, qtyApproved: 25 }]);
    dispatchTransfer(wh.ctx, req.id, [{ lineId, qty: 15 }]);
    dispatchTransfer(wh.ctx, req.id, [{ lineId, qty: 10 }]);
    expect(onHand(wh.db, env.ids.wA, env.ids.oil)).toBe(75);
    await sync(wh);
    await sync(br);
    const atBr = getTransfer(br.ctx, req.id);
    expect(atBr.status).toBe('DISPATCHED');
    expect(atBr.lines[0].qtyDispatched).toBe(25);

    // Branch receives 23 good + 1 damaged, then closes (1 missing)
    receiveTransfer(br.ctx, req.id, [{ lineId, qtyReceived: 23, qtyDamaged: 1 }]);
    const closed = closeTransfer(br.ctx, req.id, 'one bottle missing');
    expect(closed.status).toBe('CLOSED_WITH_DISCREPANCY');
    await sync(br);
    await sync(wh);
    expect(getTransfer(wh.ctx, req.id).status).toBe('CLOSED_WITH_DISCREPANCY');

    const server = await env.db.query('SELECT status FROM stock_transfers WHERE id = $1', [req.id]);
    expect(server.rows[0].status).toBe('CLOSED_WITH_DISCREPANCY');
    expect(await stockOf(env.db, env.ids.wA, env.ids.oil)).toBe(75);
    expect(await stockOf(env.db, env.ids.b2, env.ids.oil)).toBe(23);
    expect(onHand(br.db, env.ids.b2, env.ids.oil)).toBe(23);
    const recon = await env.db.query(`SELECT details->>'kind' AS kind, qty FROM reconciliation_items WHERE ref_id = $1 ORDER BY 1`, [req.id]);
    expect(recon.rows).toEqual([{ kind: 'DAMAGED', qty: 1 }, { kind: 'MISSING', qty: 1 }]);
    wh.close();
    br.close();
  });

  it('resolves a cancel/approve race: the losing side is re-synchronised to the server state', async () => {
    const wh = await registerPc(env.ids.wA, 'Warehouse PC 2');
    const br = await registerPc(env.ids.b2, 'Branch 2 PC 2');
    await wh.login('admin', PASSWORD);
    await br.login('admin', PASSWORD);
    const req = createTransfer(br.ctx, { sourceLocationId: env.ids.wA, destLocationId: env.ids.b2, lines: [{ productId: env.ids.oil, qty: 5 }] });
    await sync(br);
    await sync(wh);
    const lineId = getTransfer(wh.ctx, req.id).lines[0].id;
    // Both act while disconnected from each other: branch cancels, warehouse approves.
    cancelTransfer(br.ctx, req.id, 'no longer needed');
    approveTransfer(wh.ctx, req.id, [{ lineId, qtyApproved: 5 }]);
    await sync(br); // cancel reaches the server first
    await sync(wh); // approve is rejected → FAILED, document refreshed from server
    const failed = wh.db.prepare(`SELECT status, last_error AS err FROM outbox WHERE type = 'transfer.approve' ORDER BY seq DESC LIMIT 1`).get() as { status: string; err: string };
    expect(failed.status).toBe('FAILED');
    expect(failed.err).toMatch(/cancelled/);
    expect(getTransfer(wh.ctx, req.id).status).toBe('CANCELLED');
    expect(wh.sync.getStatus().failed).toBeGreaterThan(0);
    wh.close();
    br.close();
  });
});

describe('IPC handler surface', () => {
  it('enforces sign-in and permissions, and proxies central calls with the user token', async () => {
    const pc = await registerPc(env.ids.b1, 'Handlers PC');
    const h = createHandlers(pc);
    expect(() => h['stock.list']({})).toThrow(/sign in/i);
    await h['auth.login']({ username: 'b1cash', password: PASSWORD });
    expect(h['stock.list']({}).length).toBe(3);
    expect(() => h['sync.retry']({})).toThrow(/permission/);
    await expect(h['central.request']({ method: 'GET', path: '/api/users' })).rejects.toThrow(/permission/);
    await expect(h['central.request']({ method: 'POST', path: '/api/sync/push', body: {} })).rejects.toThrow();
    h['auth.logout']();
    await h['auth.login']({ username: 'admin', password: PASSWORD });
    const users = (await h['central.request']({ method: 'GET', path: '/api/users' })) as unknown[];
    expect(users.length).toBeGreaterThan(3);
    const info = h['app.info']();
    expect(info.location?.id).toBe(env.ids.b1);
    expect(info.session?.online).toBe(true);
    pc.close();
  });
});
