import type { CompanySettings } from '@store/shared';
import type { DB } from '../db/connection';

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function deleteMeta(db: DB, key: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(key);
}

export const DEFAULT_SETTINGS: CompanySettings = {
  name: 'Company',
  gstin: null,
  stateCode: '36',
  address: null,
  phone: null,
  branchToBranchEnabled: false,
  branchToWarehouseEnabled: true,
  allowNegativeStock: false,
  roundToRupee: true,
  receiptFooter: null,
  defaultLowStockLevel: 5,
};

export function getSettings(db: DB): CompanySettings {
  const raw = getMeta(db, 'settings');
  return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
}

/** Per-PC preferences (not synced). */
export interface LocalPrefs {
  receiptPrinter: string | null;
  silentPrint: boolean;
  receiptWidthMm: 58 | 80;
  autoBackupHours: number;
  backupRetention: number;
  syncIntervalSec: number;
}

export const DEFAULT_PREFS: LocalPrefs = {
  receiptPrinter: null,
  silentPrint: false,
  receiptWidthMm: 80,
  autoBackupHours: 24,
  backupRetention: 14,
  syncIntervalSec: 30,
};

export function getPrefs(db: DB): LocalPrefs {
  const raw = getMeta(db, 'prefs');
  return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
}

export function setPrefs(db: DB, prefs: Partial<LocalPrefs>): LocalPrefs {
  const next = { ...getPrefs(db), ...prefs };
  setMeta(db, 'prefs', JSON.stringify(next));
  return next;
}
