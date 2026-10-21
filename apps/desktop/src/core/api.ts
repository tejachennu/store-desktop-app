import { z } from 'zod';
import { PO_STATUSES, TRANSFER_STATUSES, type Permission } from '@store/shared';
import type { StoreCore } from './app';
import { requirePermission, requireSession } from './context';
import { AppError } from './errors';
import { toAppError } from './sync/api-client';
import { changePassword, setupConnect } from './services/auth';
import * as catalog from './services/catalog';
import * as sales from './services/sales';
import * as stock from './services/stock';
import * as transfers from './services/transfers';
import * as purchases from './services/purchases';
import * as reports from './services/reports';
import { getPrefs, getSettings, setPrefs } from './services/meta';

/**
 * The complete surface the renderer may call (via one IPC channel). Every
 * handler validates its arguments; services enforce role + location permissions.
 */

const id = z.uuid();
const str = (max = 200) => z.string().max(max);

function scoped<T>(core: StoreCore, permission: Permission, fn: (locationId: string) => T): T {
  requirePermission(core.ctx, permission);
  if (!core.ctx.device) throw new AppError('NOT_REGISTERED', 'This computer is not registered');
  return fn(core.ctx.device.locationId);
}

export function createHandlers(core: StoreCore) {
  const db = () => core.ctx.db;
  const handlers = {
    // ------------------------------------------------------------------ app / setup / auth
    'app.info': () => {
      const device = core.ctx.device;
      const location = device ? db().prepare('SELECT * FROM locations WHERE id = ?').get(device.locationId) : null;
      return {
        device,
        location: location ? catalog.mapLocation(location) : null,
        session: core.ctx.session
          ? { user: core.ctx.session.user, mode: core.ctx.session.mode, online: !!core.ctx.session.accessToken, startedAt: core.ctx.session.startedAt }
          : null,
        settings: getSettings(db()),
        sync: core.sync.getStatus(),
        dataDir: core.dbFile,
      };
    },
    'setup.connect': (a: { serverUrl: string; username: string; password: string }) => {
      const p = z.object({ serverUrl: str(300), username: str(60), password: str(200) }).parse(a);
      return setupConnect(p.serverUrl, p.username, p.password);
    },
    'setup.register': (a: { serverUrl: string; token: string; locationId: string; deviceName: string }) => {
      const p = z.object({ serverUrl: str(300), token: str(4000), locationId: id, deviceName: z.string().trim().min(2).max(80) }).parse(a);
      return core.register(p);
    },
    'auth.login': async (a: { username: string; password: string }) => {
      const p = z.object({ username: str(60), password: str(200) }).parse(a);
      const s = await core.login(p.username, p.password);
      return { user: s.user, mode: s.mode };
    },
    'auth.logout': () => {
      core.logout();
      return { ok: true };
    },
    'auth.changePassword': (a: { currentPassword: string; newPassword: string }) => {
      const p = z.object({ currentPassword: str(200), newPassword: str(200) }).parse(a);
      return changePassword(core.ctx, p.currentPassword, p.newPassword);
    },

    // ------------------------------------------------------------------ sync
    'sync.status': () => core.sync.getStatus(),
    'sync.now': async () => {
      requireSession(core.ctx);
      await core.sync.syncNow({ force: true });
      return core.sync.getStatus();
    },
    'sync.outbox': (a: { status?: 'PENDING' | 'FAILED' | 'SYNCED' }) => {
      requireSession(core.ctx);
      const status = z.enum(['PENDING', 'FAILED', 'SYNCED']).optional().parse(a?.status);
      return db()
        .prepare(
          `SELECT seq, id, type, status, attempts, last_error AS lastError, created_at AS createdAt, synced_at AS syncedAt,
                  next_attempt_at AS nextAttemptAt, json_extract(envelope, '$.payload') AS payload
             FROM outbox WHERE (? IS NULL OR status = ?) ORDER BY seq DESC LIMIT 500`,
        )
        .all(status ?? null, status ?? null)
        .map((r: any) => ({ ...r, payload: JSON.parse(r.payload) }));
    },
    'sync.retry': (a: { ids?: string[] }) => {
      requirePermission(core.ctx, 'sync.admin');
      return { requeued: core.sync.retryFailed(z.array(id).optional().parse(a?.ids)) };
    },
    'sync.log': () => {
      requireSession(core.ctx);
      return db().prepare('SELECT * FROM sync_log ORDER BY id DESC LIMIT 300').all();
    },
    /** Compare local stock levels with the central ledger for this location (online). */
    'sync.stockReconcile': async () => {
      requirePermission(core.ctx, 'stock.view');
      const device = core.ctx.device;
      const central = (await centralRequest(core, 'GET', `/api/stock?locationId=${device!.locationId}&limit=2000`)) as { productId: string; qtyOnHand: number; sku: string; name: string }[];
      const local = stock.listStock(db(), device!.locationId, {});
      const centralMap = new Map(central.map((c) => [c.productId, c.qtyOnHand]));
      const pending = db().prepare(`SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'`).get() as { n: number };
      return {
        pendingEvents: pending.n,
        rows: local
          .map((l) => ({ productId: l.productId, sku: l.sku, name: l.name, local: l.qtyOnHand, central: centralMap.get(l.productId) ?? 0 }))
          .filter((r) => r.local !== r.central),
      };
    },

    // ------------------------------------------------------------------ catalogue (local cache)
    'catalog.searchProducts': (a: catalog.ProductSearch) => {
      requirePermission(core.ctx, 'products.view');
      const q = z
        .object({ search: str().optional(), categoryId: id.optional(), activeOnly: z.boolean().optional(), limit: z.number().int().max(500).optional(), offset: z.number().int().min(0).optional() })
        .parse(a ?? {});
      return catalog.searchProducts(db(), { ...q, locationId: core.ctx.device?.locationId });
    },
    'catalog.getProduct': (a: { id: string }) => {
      requirePermission(core.ctx, 'products.view');
      return catalog.getProduct(db(), id.parse(a.id));
    },
    'catalog.findBarcode': (a: { code: string }) => {
      requireSession(core.ctx);
      const hit = catalog.findByBarcode(db(), str(64).parse(a.code));
      if (!hit) return null;
      const qtyOnHand = core.ctx.device ? stock.onHand(db(), core.ctx.device.locationId, hit.product.id) : null;
      return { ...hit, product: { ...hit.product, qtyOnHand } };
    },
    'catalog.categories': () => {
      requireSession(core.ctx);
      return catalog.listCategories(db());
    },
    'catalog.locations': () => {
      requireSession(core.ctx);
      return catalog.listLocations(db());
    },
    'catalog.suppliers': (a: { search?: string }) => {
      requirePermission(core.ctx, 'suppliers.view');
      return catalog.listSuppliers(db(), a?.search);
    },

    // ------------------------------------------------------------------ customers
    'customers.search': (a: { search: string }) => {
      requirePermission(core.ctx, 'customers.view');
      return sales.searchCustomers(db(), str().parse(a?.search ?? ''));
    },
    'customers.save': (a: Parameters<typeof sales.upsertCustomer>[1]) => sales.upsertCustomer(core.ctx, a),
    'customers.history': (a: { id: string }) => {
      requirePermission(core.ctx, 'sales.view');
      return sales.customerHistory(db(), id.parse(a.id));
    },

    // ------------------------------------------------------------------ POS & sales
    'pos.quote': (a: sales.SaleInput) => {
      const { bill, interState } = sales.quoteSale(core.ctx, a);
      return { ...bill, interState };
    },
    'pos.sell': (a: sales.SaleInput) => sales.createSale(core.ctx, a),
    'sales.list': (a: { from?: string; to?: string; search?: string }) => {
      requirePermission(core.ctx, 'sales.view');
      return sales.listSales(db(), z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), search: str().optional() }).parse(a ?? {}));
    },
    'sales.get': (a: { id: string }) => {
      requirePermission(core.ctx, 'sales.view');
      return sales.getSale(db(), id.parse(a.id));
    },
    'sales.findByInvoice': (a: { invoiceNo: string }) => {
      requirePermission(core.ctx, 'sales.view');
      return sales.findSaleByInvoice(db(), str(30).parse(a.invoiceNo));
    },
    'sales.return': (a: sales.ReturnInput) => sales.createReturn(core.ctx, a),
    'sales.getReturn': (a: { id: string }) => {
      requirePermission(core.ctx, 'sales.view');
      return sales.getReturn(db(), id.parse(a.id));
    },
    'sales.returns': () => {
      requirePermission(core.ctx, 'sales.view');
      return sales.listReturns(db());
    },

    // ------------------------------------------------------------------ stock
    'stock.list': (a: { search?: string; lowOnly?: boolean }) =>
      scoped(core, 'stock.view', (loc) => stock.listStock(db(), loc, z.object({ search: str().optional(), lowOnly: z.boolean().optional() }).parse(a ?? {}))),
    'stock.movements': (a: { productId?: string }) =>
      scoped(core, 'stock.view', (loc) => stock.listMovements(db(), loc, { productId: id.optional().parse(a?.productId) })),
    'stock.adjust': (a: stock.AdjustmentInput) => stock.createAdjustment(core.ctx, a),
    'stock.adjustments': () => scoped(core, 'stock.view', (loc) => stock.listAdjustments(db(), loc)),

    // ------------------------------------------------------------------ transfers
    'transfers.list': (a: { status?: string; direction?: 'OUTGOING' | 'INCOMING'; openOnly?: boolean }) =>
      scoped(core, 'transfers.view', (loc) =>
        transfers.listTransfers(
          db(),
          loc,
          z.object({ status: z.enum(TRANSFER_STATUSES).optional(), direction: z.enum(['OUTGOING', 'INCOMING']).optional(), openOnly: z.boolean().optional() }).parse(a ?? {}),
        ),
      ),
    'transfers.get': (a: { id: string }) => {
      requirePermission(core.ctx, 'transfers.view');
      return transfers.getTransfer(core.ctx, id.parse(a.id));
    },
    'transfers.create': (a: transfers.CreateTransferInput) => transfers.createTransfer(core.ctx, a),
    'transfers.approve': (a: { id: string; lines: { lineId: string; qtyApproved: number }[] }) => transfers.approveTransfer(core.ctx, id.parse(a.id), a.lines),
    'transfers.reject': (a: { id: string; reason: string }) => transfers.rejectTransfer(core.ctx, id.parse(a.id), a.reason),
    'transfers.cancel': (a: { id: string; reason: string }) => transfers.cancelTransfer(core.ctx, id.parse(a.id), a.reason),
    'transfers.dispatch': (a: { id: string; lines: { lineId: string; qty: number }[]; notes?: string }) =>
      transfers.dispatchTransfer(core.ctx, id.parse(a.id), a.lines, a.notes),
    'transfers.receive': (a: { id: string; lines: { lineId: string; qtyReceived: number; qtyDamaged: number }[]; notes?: string }) =>
      transfers.receiveTransfer(core.ctx, id.parse(a.id), a.lines, a.notes),
    'transfers.close': (a: { id: string; notes?: string }) => transfers.closeTransfer(core.ctx, id.parse(a.id), a.notes),

    // ------------------------------------------------------------------ purchasing
    'purchases.orders': (a: { status?: string }) =>
      scoped(core, 'purchase.view', (loc) => purchases.listPurchaseOrders(db(), loc, z.enum(PO_STATUSES).optional().parse(a?.status))),
    'purchases.order': (a: { id: string }) => {
      requirePermission(core.ctx, 'purchase.view');
      return purchases.getPurchaseOrder(db(), id.parse(a.id));
    },
    'purchases.createGrn': (a: purchases.GrnInput) => purchases.createGrn(core.ctx, a),
    'purchases.grns': () => scoped(core, 'purchase.view', (loc) => purchases.listGrns(db(), loc)),
    'purchases.grn': (a: { id: string }) => {
      requirePermission(core.ctx, 'purchase.view');
      return purchases.getGrn(db(), id.parse(a.id));
    },
    'purchases.createReturn': (a: purchases.PurchaseReturnInput) => purchases.createPurchaseReturn(core.ctx, a),
    'purchases.returns': () => scoped(core, 'purchase.view', (loc) => purchases.listPurchaseReturns(db(), loc)),
    'purchases.pay': (a: purchases.SupplierPaymentInput) => purchases.recordSupplierPayment(core.ctx, a),
    'purchases.payments': () => {
      requirePermission(core.ctx, 'supplier_payments.manage');
      return purchases.listSupplierPayments(db());
    },

    // ------------------------------------------------------------------ local reports
    'reports.dashboard': () => scoped(core, 'dashboard.view', (loc) => reports.localDashboard(db(), loc)),
    'reports.sales': (a: { from?: string; to?: string; groupBy: 'day' | 'product' | 'payment' | 'user' | 'hsn' }) => {
      requirePermission(core.ctx, 'reports.view');
      const q = z.object({ from: z.iso.date().optional(), to: z.iso.date().optional(), groupBy: z.enum(['day', 'product', 'payment', 'user', 'hsn']) }).parse(a);
      return reports.localSalesReport(db(), q);
    },
    'reports.gst': (a: { from?: string; to?: string }) => {
      requirePermission(core.ctx, 'reports.gst');
      return reports.localGstReport(db(), z.object({ from: z.iso.date().optional(), to: z.iso.date().optional() }).parse(a ?? {}));
    },

    // ------------------------------------------------------------------ central server (online, user token stays in main)
    'central.request': async (a: { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown }) => {
      const p = z
        .object({
          method: z.enum(['GET', 'POST', 'PUT']),
          // Only the user-facing API; device sync endpoints are not reachable from the UI.
          path: z.string().regex(/^\/api\/(?!sync\/(push|pull|refresh|ping))[A-Za-z0-9/_\-?=&%.:]+$/, 'Invalid API path'),
          body: z.unknown().optional(),
        })
        .parse(a);
      const result = await centralRequest(core, p.method, p.path, p.body);
      if (p.method !== 'GET') core.sync.nudge(300); // pull the change back into the local cache
      return result;
    },

    // ------------------------------------------------------------------ backups & preferences
    'backup.list': () => {
      requireSession(core.ctx);
      return core.listBackups();
    },
    'backup.now': () => {
      requireSession(core.ctx);
      return core.backupNow('manual');
    },
    'backup.verify': (a: { file: string }) => {
      requirePermission(core.ctx, 'settings.manage');
      return core.verifyBackup(str(1000).parse(a.file));
    },
    'backup.restore': (a: { file: string; confirm: boolean; force?: boolean }) => {
      requirePermission(core.ctx, 'settings.manage');
      if (!a?.confirm) throw new AppError('VALIDATION', 'Restore must be confirmed');
      const pending = core.ctx.db.prepare(`SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'`).get() as { n: number };
      if (pending.n > 0 && !a.force) {
        throw new AppError('CONFLICT', `${pending.n} transaction(s) on this computer are not synchronised yet. Sync first, or they will be lost by the restore.`);
      }
      return core.restore(str(1000).parse(a.file));
    },
    'prefs.get': () => {
      requireSession(core.ctx);
      return getPrefs(db());
    },
    'prefs.set': (a: Partial<ReturnType<typeof getPrefs>>) => {
      requireSession(core.ctx);
      const p = z
        .object({
          receiptPrinter: z.string().max(200).nullable().optional(),
          silentPrint: z.boolean().optional(),
          receiptWidthMm: z.union([z.literal(58), z.literal(80)]).optional(),
          autoBackupHours: z.number().int().min(1).max(168).optional(),
          backupRetention: z.number().int().min(1).max(365).optional(),
          syncIntervalSec: z.number().int().min(10).max(3600).optional(),
        })
        .parse(a ?? {});
      return setPrefs(db(), p);
    },
  };
  return handlers;
}

async function centralRequest(core: StoreCore, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown) {
  const session = requireSession(core.ctx);
  if (!core.ctx.api || !session.accessToken) {
    throw new AppError('OFFLINE', 'This screen needs an online sign-in to the central server. Sign out and sign in again while connected.');
  }
  try {
    return await core.ctx.api.request(method, path, { token: session.accessToken, body });
  } catch (err) {
    const e = toAppError(err);
    if (e.code === 'UNAUTHORIZED') session.accessToken = null; // expired: further central calls need a fresh sign-in
    throw e;
  }
}

export type Handlers = ReturnType<typeof createHandlers>;
export type ApiMethod = keyof Handlers;
export type ApiArgs<M extends ApiMethod> = Parameters<Handlers[M]>[0];
export type ApiResult<M extends ApiMethod> = Awaited<ReturnType<Handlers[M]>>;
