import { financialYearCode } from '@store/shared';
import { one, type Queryable } from '../db/pool.js';

/** Central document numbers, e.g. PO/2627/00012. Row-locked counter per prefix and FY. */
export async function nextCentralNumber(q: Queryable, prefix: string, date = new Date()): Promise<string> {
  const fy = financialYearCode(date);
  const key = `${prefix}/${fy}`;
  const row = await one<{ value: number }>(
    q,
    `INSERT INTO doc_counters (key, value) VALUES ($1, 1)
     ON CONFLICT (key) DO UPDATE SET value = doc_counters.value + 1 RETURNING value`,
    [key],
  );
  return `${key}/${String(row!.value).padStart(5, '0')}`;
}
