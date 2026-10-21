import { describe, expect, it } from 'vitest';
import {
  allocateProportionally,
  checkPayments,
  computeBill,
  computeLineRefund,
  mulDivRound,
  splitTax,
} from '../src/index.js';

describe('money helpers', () => {
  it('mulDivRound rounds half away from zero exactly', () => {
    expect(mulDivRound(105, 1, 10)).toBe(11);
    expect(mulDivRound(-105, 1, 10)).toBe(-11);
    expect(mulDivRound(104, 1, 10)).toBe(10);
    // beyond 2^53 intermediate
    expect(mulDivRound(9_000_000_000_000, 10000, 11800)).toBe(7_627_118_644_068);
  });

  it('allocateProportionally sums exactly', () => {
    const parts = allocateProportionally(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts).toEqual([34, 33, 33]);
    expect(allocateProportionally(0, [5, 5])).toEqual([0, 0]);
    expect(allocateProportionally(10, [0, 0])).toEqual([10, 0]);
  });
});

describe('computeBill', () => {
  it('carves tax out of inclusive prices (intra-state CGST+SGST)', () => {
    // 2 x ₹118.00 at 18% inclusive → taxable 200.00, tax 36.00
    const bill = computeBill([{ qty: 2, unitPrice: 11800, priceIncludesTax: true, gstRateBp: 1800 }], {
      interState: false,
    });
    expect(bill.taxableTotal).toBe(20000);
    expect(bill.cgstTotal).toBe(1800);
    expect(bill.sgstTotal).toBe(1800);
    expect(bill.igstTotal).toBe(0);
    expect(bill.grandTotal).toBe(23600);
    expect(bill.roundOff).toBe(0);
  });

  it('adds tax on exclusive prices (inter-state IGST)', () => {
    const bill = computeBill([{ qty: 3, unitPrice: 10000, priceIncludesTax: false, gstRateBp: 1200 }], {
      interState: true,
    });
    expect(bill.taxableTotal).toBe(30000);
    expect(bill.igstTotal).toBe(3600);
    expect(bill.cgstTotal + bill.sgstTotal).toBe(0);
    expect(bill.grandTotal).toBe(33600);
  });

  it('applies line percent discount and prorates bill discount', () => {
    const bill = computeBill(
      [
        { qty: 1, unitPrice: 10000, priceIncludesTax: true, gstRateBp: 500, discount: { type: 'PERCENT', valueBp: 1000 } },
        { qty: 1, unitPrice: 30000, priceIncludesTax: true, gstRateBp: 1800 },
      ],
      { interState: false, billDiscount: 3900 },
    );
    // line1 after 10%: 9000; line2 30000; bill discount 3900 split 9000:30000 → 900 / 3000
    expect(bill.lines[0].discount).toBe(1000 + 900);
    expect(bill.lines[1].discount).toBe(3000);
    expect(bill.discountTotal).toBe(4900);
    expect(bill.subtotal).toBe(40000 - 4900);
    expect(bill.lines.every((l) => l.taxableValue + l.taxTotal === l.lineTotal)).toBe(true);
    expect(bill.cgstTotal + bill.sgstTotal).toBe(bill.taxTotal);
  });

  it('caps amount discount at line value and rounds to rupee', () => {
    const bill = computeBill(
      [{ qty: 1, unitPrice: 9999, priceIncludesTax: false, gstRateBp: 1800, discount: { type: 'AMOUNT', value: 50000 } }],
      { interState: false, roundToRupee: true },
    );
    expect(bill.lines[0].lineTotal).toBe(0);
    expect(bill.grandTotal).toBe(0);

    const b2 = computeBill([{ qty: 1, unitPrice: 9999, priceIncludesTax: false, gstRateBp: 1800 }], {
      interState: false,
      roundToRupee: true,
    });
    // 99.99 + 18.00 (17.9982 → 18.00) = 117.99 → 118.00
    expect(b2.subtotal).toBe(11799);
    expect(b2.grandTotal).toBe(11800);
    expect(b2.roundOff).toBe(1);
  });

  it('rejects invalid inputs', () => {
    expect(() => computeBill([{ qty: 0, unitPrice: 1, priceIncludesTax: true, gstRateBp: 0 }], { interState: false })).toThrow();
    expect(() => computeBill([{ qty: 1.5, unitPrice: 1, priceIncludesTax: true, gstRateBp: 0 }], { interState: false })).toThrow();
    expect(() => computeBill([{ qty: 1, unitPrice: 1, priceIncludesTax: true, gstRateBp: 20000 }], { interState: false })).toThrow();
  });

  it('splits odd tax so CGST + SGST equals total tax', () => {
    expect(splitTax(101, false)).toEqual({ cgst: 51, sgst: 50, igst: 0 });
    expect(splitTax(101, true)).toEqual({ cgst: 0, sgst: 0, igst: 101 });
  });
});

describe('computeLineRefund', () => {
  const line = { qtySold: 3, qtyAlreadyReturned: 0, taxableValue: 10000, cgst: 901, sgst: 900, igst: 0, lineTotal: 11801 };

  it('partial returns add up to the original line exactly', () => {
    const r1 = computeLineRefund(line, 1);
    const r2 = computeLineRefund({ ...line, qtyAlreadyReturned: 1 }, 1);
    const r3 = computeLineRefund({ ...line, qtyAlreadyReturned: 2 }, 1);
    expect(r1.total + r2.total + r3.total).toBe(11801);
    expect(r1.taxableValue + r2.taxableValue + r3.taxableValue).toBe(10000);
    expect(r1.cgst + r2.cgst + r3.cgst).toBe(901);
  });

  it('prevents returning more than sold', () => {
    expect(() => computeLineRefund({ ...line, qtyAlreadyReturned: 2 }, 2)).toThrow(/exceeds/);
  });
});

describe('checkPayments', () => {
  it('accepts split payments and computes cash change', () => {
    const r = checkPayments(10000, [
      { method: 'UPI', amount: 6000 },
      { method: 'CASH', amount: 5000 },
    ]);
    expect(r).toEqual({ ok: true, paid: 11000, change: 1000 });
  });

  it('rejects underpayment and card overpayment', () => {
    expect(checkPayments(10000, [{ method: 'CASH', amount: 9999 }]).ok).toBe(false);
    expect(checkPayments(10000, [{ method: 'CARD', amount: 10001 }]).ok).toBe(false);
  });
});
