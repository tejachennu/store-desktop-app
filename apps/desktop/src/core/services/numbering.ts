import { financialYearCode, formatDocNumber } from '@store/shared';
import type { DB } from '../db/connection';
import type { LocationRow } from '@store/shared';

export type DocKind = 'SALE' | 'SALE_RETURN' | 'TRANSFER' | 'GRN' | 'ADJUSTMENT' | 'PURCHASE_RETURN';

const PREFIX: Record<DocKind, (l: LocationRow) => string> = {
  SALE: (l) => l.invoicePrefix,
  SALE_RETURN: (l) => `${l.invoicePrefix}R`,
  TRANSFER: (l) => `T${l.code}`,
  GRN: (l) => `G${l.code}`,
  ADJUSTMENT: (l) => `A${l.code}`,
  PURCHASE_RETURN: (l) => `P${l.code}`,
};

/** Next number in this device's series. Call inside the document's transaction. */
export function nextDocNumber(db: DB, kind: DocKind, location: LocationRow, deviceNo: number, date = new Date()): string {
  const fy = financialYearCode(date);
  const key = `${kind}/${fy}`;
  const row = db
    .prepare('INSERT INTO doc_counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1 RETURNING value')
    .get(key) as { value: number };
  return formatDocNumber(PREFIX[kind](location), deviceNo, fy, row.value);
}
