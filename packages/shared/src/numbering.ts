/** Indian financial year (April–March) code, e.g. 2026-10-21 → "2627". */
export function financialYearCode(date: Date = new Date()): string {
  const y = date.getFullYear();
  const start = date.getMonth() >= 3 ? y : y - 1;
  return `${String(start % 100).padStart(2, '0')}${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Document numbers are generated on the device so they work offline. Each device has
 * its own series (prefix + device number), which makes numbers unique company-wide
 * and consecutive per series as GST requires (max 16 chars for invoices).
 * Example: BR1 + device 2, FY 26-27, #42 → "BR12/2627/00042".
 */
export function formatDocNumber(prefix: string, deviceNo: number, fyCode: string, seq: number): string {
  return `${prefix}${deviceNo}/${fyCode}/${String(seq).padStart(5, '0')}`;
}
