import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { permissionsFor, uuidv7, type PullResponse, type Role } from '@store/shared';
import { StoreCore } from '../src/core/app';
import type { SecretStore } from '../src/core/context';
import type { FetchLike } from '../src/core/sync/api-client';
import { applyPull } from '../src/core/sync/apply-pull';
import { setMeta } from '../src/core/services/meta';

export function memorySecrets(): SecretStore {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), delete: (k) => void m.delete(k) };
}

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'store-core-'));
  dirs.push(d);
  return d;
}
export function cleanupTempDirs() {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function makeCore(opts: { dataDir?: string; fetchImpl?: FetchLike; secrets?: SecretStore } = {}) {
  return new StoreCore({ dataDir: opts.dataDir ?? tempDir(), secrets: opts.secrets ?? memorySecrets(), fetchImpl: opts.fetchImpl, manualSync: true });
}

export const ids = {
  b1: uuidv7(),
  wa: uuidv7(),
  b2: uuidv7(),
  admin: uuidv7(),
  cashier: uuidv7(),
  whmgr: uuidv7(),
  rice: uuidv7(),
  soap: uuidv7(),
  oil: uuidv7(),
  customerOtherState: uuidv7(),
  supplier: uuidv7(),
};

export function fixture(): PullResponse {
  const loc = (id: string, code: string, type: 'WAREHOUSE' | 'BRANCH') => ({
    id, code, name: `${code} name`, type, address: null, stateCode: '36', gstin: null, phone: null,
    invoicePrefix: code, canReceivePurchases: type === 'WAREHOUSE', isActive: true,
  });
  const product = (id: string, sku: string, rate: number, cost: number, price: number, barcode: string) => ({
    id, sku, name: sku, categoryId: null, brand: null, hsnCode: '1006', unit: 'pcs', gstRateBp: rate, purchasePrice: cost,
    sellingPrice: price, mrp: null, priceIncludesTax: true, reorderLevel: 5, variantGroup: null, variantAttrs: {}, imageData: null,
    isActive: true, barcodes: [{ barcode, unitLabel: 'pcs', factor: 1 }, { barcode: `${barcode}-BOX`, unitLabel: 'box', factor: 10 }],
  });
  return {
    cursor: '1',
    hasMore: false,
    settings: {
      name: 'Test Co', gstin: null, stateCode: '36', address: null, phone: null, branchToBranchEnabled: false,
      branchToWarehouseEnabled: true, allowNegativeStock: false, roundToRupee: true, receiptFooter: null, defaultLowStockLevel: 5,
    },
    locations: [loc(ids.b1, 'B1', 'BRANCH'), loc(ids.wa, 'WA', 'WAREHOUSE'), loc(ids.b2, 'B2', 'BRANCH')],
    users: [
      { id: ids.admin, username: 'admin', fullName: 'Admin', role: 'COMPANY_ADMIN', allLocations: true, locationIds: [], isActive: true },
      { id: ids.cashier, username: 'cash', fullName: 'Cashier', role: 'SALES_STAFF', allLocations: false, locationIds: [ids.b1], isActive: true },
      { id: ids.whmgr, username: 'whmgr', fullName: 'WH Manager', role: 'WAREHOUSE_MANAGER', allLocations: false, locationIds: [ids.wa], isActive: true },
    ],
    categories: [],
    products: [product(ids.rice, 'RICE', 500, 40000, 52000, '1001'), product(ids.soap, 'SOAP', 1800, 2400, 11800, '1002'), product(ids.oil, 'OIL', 500, 12000, 15500, '1003')],
    suppliers: [{ id: ids.supplier, name: 'Supplier', gstin: null, stateCode: '36', phone: null, email: null, address: null, isActive: true }],
    customers: [{ id: ids.customerOtherState, name: 'Karnataka Buyer', phone: '9000000000', email: null, gstin: '29ABCDE1234F1Z5', stateCode: '29', address: null }],
    purchaseOrders: [],
    transfers: [],
    movements: [],
  };
}

/** A core registered to `locationId` with fixture master data and a signed-in user (no server). */
export function offlineCore(locationId: string, userId: string, role: Role) {
  const core = makeCore();
  setMeta(core.db, 'device', JSON.stringify({ deviceId: uuidv7(), deviceNo: 1, locationId, serverUrl: 'http://127.0.0.1:9' }));
  core.ctx.device = { deviceId: 'x', deviceNo: 1, locationId, serverUrl: 'http://127.0.0.1:9' };
  applyPull(core.db, fixture());
  signIn(core, userId, role);
  return core;
}

export function signIn(core: StoreCore, userId: string, role: Role) {
  const u = fixture().users.find((x) => x.id === userId)!;
  core.ctx.session = {
    user: { ...u, role, permissions: permissionsFor(role) },
    accessToken: null,
    expiresAt: null,
    mode: 'offline',
    startedAt: new Date().toISOString(),
  };
}

export function count(core: StoreCore, table: string): number {
  return (core.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
