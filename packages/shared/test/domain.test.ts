import { describe, expect, it } from 'vitest';
import {
  canAt,
  canTransition,
  checkTransferRoute,
  deriveFulfilmentStatus,
  financialYearCode,
  formatDocNumber,
  productInputSchema,
  syncEventSchema,
  uuidv7,
  UUID_RE,
} from '../src/index.js';

const W = (id: string) => ({ id, type: 'WAREHOUSE' as const, isActive: true });
const B = (id: string) => ({ id, type: 'BRANCH' as const, isActive: true });

describe('transfer routes', () => {
  const off = { branchToBranchEnabled: false, branchToWarehouseEnabled: true };
  it('allows warehouse → warehouse and warehouse → branch', () => {
    expect(checkTransferRoute(W('a'), W('b'), off).ok).toBe(true);
    expect(checkTransferRoute(W('a'), B('b'), off).ok).toBe(true);
  });
  it('gates branch → branch on the setting', () => {
    expect(checkTransferRoute(B('a'), B('b'), off).ok).toBe(false);
    expect(checkTransferRoute(B('a'), B('b'), { ...off, branchToBranchEnabled: true }).ok).toBe(true);
  });
  it('rejects same location and inactive locations', () => {
    expect(checkTransferRoute(W('a'), W('a'), off).ok).toBe(false);
    expect(checkTransferRoute(W('a'), { ...B('b'), isActive: false }, off).ok).toBe(false);
  });
});

describe('transfer state machine', () => {
  const line = (a: number, d: number, r: number, dmg = 0) => ({
    qtyRequested: a,
    qtyApproved: a,
    qtyDispatched: d,
    qtyReceived: r,
    qtyDamaged: dmg,
  });
  it('derives fulfilment status from quantities', () => {
    expect(deriveFulfilmentStatus([line(10, 0, 0)])).toBe('APPROVED');
    expect(deriveFulfilmentStatus([line(10, 4, 0)])).toBe('PARTIALLY_DISPATCHED');
    expect(deriveFulfilmentStatus([line(10, 10, 0)])).toBe('DISPATCHED');
    expect(deriveFulfilmentStatus([line(10, 10, 6)])).toBe('PARTIALLY_RECEIVED');
    expect(deriveFulfilmentStatus([line(10, 10, 8, 2)])).toBe('RECEIVED');
  });
  it('guards transitions', () => {
    expect(canTransition('REQUESTED', 'APPROVE')).toBe(true);
    expect(canTransition('DISPATCHED', 'CANCEL')).toBe(false);
    expect(canTransition('RECEIVED', 'RECEIVE')).toBe(false);
    expect(canTransition('CANCELLED', 'DISPATCH')).toBe(false);
  });
});

describe('permissions', () => {
  it('scopes permissions to assigned locations', () => {
    const staff = { role: 'SALES_STAFF' as const, allLocations: false, locationIds: ['b1'] };
    expect(canAt(staff, 'pos.sell', 'b1')).toBe(true);
    expect(canAt(staff, 'pos.sell', 'b2')).toBe(false);
    expect(canAt(staff, 'stock.adjust', 'b1')).toBe(false);
    const admin = { role: 'COMPANY_ADMIN' as const, allLocations: true, locationIds: [] };
    expect(canAt(admin, 'users.manage', 'anything')).toBe(true);
  });
});

describe('ids and numbering', () => {
  it('generates unique, time-ordered UUIDv7', () => {
    const ids = Array.from({ length: 2000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((i) => UUID_RE.test(i) && i[14] === '7')).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });
  it('formats financial year and document numbers', () => {
    expect(financialYearCode(new Date(2026, 9, 21))).toBe('2627');
    expect(financialYearCode(new Date(2027, 2, 31))).toBe('2627');
    expect(financialYearCode(new Date(2027, 3, 1))).toBe('2728');
    expect(formatDocNumber('BR1', 2, '2627', 42)).toBe('BR12/2627/00042');
  });
});

describe('schemas', () => {
  it('validates products', () => {
    const ok = productInputSchema.safeParse({
      sku: 'rice-5kg',
      name: 'Basmati Rice 5kg',
      unit: 'pcs',
      gstRateBp: 500,
      purchasePrice: 40000,
      sellingPrice: 52000,
      mrp: 55000,
      barcodes: [{ barcode: '8901234567890' }],
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.sku).toBe('RICE-5KG');
    const bad = productInputSchema.safeParse({
      sku: 'X1',
      name: 'Bad',
      unit: 'pcs',
      gstRateBp: 500,
      purchasePrice: 1,
      sellingPrice: 200,
      mrp: 100,
    });
    expect(bad.success).toBe(false);
  });

  it('validates sync events by type', () => {
    const r = syncEventSchema.safeParse({
      id: uuidv7(),
      type: 'transfer.reject',
      locationId: uuidv7(),
      userId: uuidv7(),
      occurredAt: new Date().toISOString(),
      payload: { transferId: uuidv7(), reason: 'No stock' },
    });
    expect(r.success).toBe(true);
    const bad = syncEventSchema.safeParse({
      id: uuidv7(),
      type: 'transfer.reject',
      locationId: uuidv7(),
      userId: uuidv7(),
      occurredAt: new Date().toISOString(),
      payload: { transferId: 'nope' },
    });
    expect(bad.success).toBe(false);
  });
});
