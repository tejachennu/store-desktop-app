/** All money values are integer paise. */

/** round(a * b / c), half away from zero, computed exactly with BigInt. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (c === 0) throw new Error('Division by zero');
  const num = BigInt(Math.trunc(a)) * BigInt(Math.trunc(b));
  const den = BigInt(Math.trunc(c));
  const neg = num < 0n !== den < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = den < 0n ? -den : den;
  const q = (absNum * 2n + absDen) / (absDen * 2n);
  return Number(neg ? -q : q);
}

/** Convert rupees (may be fractional, e.g. user input "12.50") to paise. */
export function toPaise(rupees: number | string): number {
  const n = typeof rupees === 'string' ? Number(rupees.replace(/,/g, '')) : rupees;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${rupees}`);
  return Math.round(n * 100);
}

export function fromPaise(paise: number): number {
  return paise / 100;
}

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatINR(paise: number): string {
  return inr.format(paise / 100);
}

export function formatRate(bp: number): string {
  return `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 2)}%`;
}

/**
 * Split `total` across `weights` proportionally so the parts sum exactly to `total`
 * (largest-remainder method). Used for bill-level discounts and pro-rata refunds.
 */
export function allocateProportionally(total: number, weights: number[]): number[] {
  const sumW = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0) return [];
  if (sumW <= 0) return weights.map((_, i) => (i === 0 ? total : 0));
  const raw = weights.map((w) => (BigInt(total) * BigInt(w)));
  const bigSum = BigInt(sumW);
  const floors = raw.map((r) => Number(r / bigSum));
  const remainders = raw.map((r, i) => ({ i, rem: Number(r % bigSum) }));
  let leftover = total - floors.reduce((s, f) => s + f, 0);
  remainders.sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    floors[i] += 1;
    leftover -= 1;
  }
  return floors;
}
