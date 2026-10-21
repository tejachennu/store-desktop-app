import { allocateProportionally, mulDivRound } from './money.js';

export type DiscountInput = { type: 'PERCENT'; valueBp: number } | { type: 'AMOUNT'; value: number };

export interface BillingLineInput {
  qty: number;
  /** Price per base unit in paise, as charged (tax inclusive or exclusive per flag). */
  unitPrice: number;
  priceIncludesTax: boolean;
  gstRateBp: number;
  discount?: DiscountInput | null;
}

export interface BillingOptions {
  /** Bill-level discount in paise, prorated across lines after line discounts. */
  billDiscount?: number;
  /** IGST when place of supply differs from the seller's state, else CGST + SGST. */
  interState: boolean;
  /** Round grand total to the nearest rupee (round-off line on the invoice). */
  roundToRupee?: boolean;
}

export interface BilledLine {
  gross: number;
  discount: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  taxTotal: number;
  lineTotal: number;
}

export interface BillTotals {
  lines: BilledLine[];
  grossTotal: number;
  discountTotal: number;
  taxableTotal: number;
  cgstTotal: number;
  sgstTotal: number;
  igstTotal: number;
  taxTotal: number;
  /** Sum of line totals before round-off. */
  subtotal: number;
  roundOff: number;
  grandTotal: number;
}

function lineDiscount(gross: number, d: DiscountInput | null | undefined): number {
  if (!d) return 0;
  const amount = d.type === 'PERCENT' ? mulDivRound(gross, d.valueBp, 10000) : d.value;
  return Math.max(0, Math.min(gross, amount));
}

export function splitTax(tax: number, interState: boolean): { cgst: number; sgst: number; igst: number } {
  if (interState) return { cgst: 0, sgst: 0, igst: tax };
  const cgst = Math.round(tax / 2);
  return { cgst, sgst: tax - cgst, igst: 0 };
}

/**
 * GST-compliant bill computation. Inclusive prices keep the line total equal to the
 * shelf price after discounts (tax is carved out); exclusive prices add tax on top.
 */
export function computeBill(inputs: BillingLineInput[], opts: BillingOptions): BillTotals {
  for (const l of inputs) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new Error('Quantity must be a positive integer');
    if (!Number.isInteger(l.unitPrice) || l.unitPrice < 0) throw new Error('Unit price must be non-negative paise');
    if (!Number.isInteger(l.gstRateBp) || l.gstRateBp < 0 || l.gstRateBp > 10000) throw new Error('Invalid GST rate');
  }
  const grosses = inputs.map((l) => l.qty * l.unitPrice);
  const afterLine = inputs.map((l, i) => grosses[i] - lineDiscount(grosses[i], l.discount));
  const afterLineSum = afterLine.reduce((s, v) => s + v, 0);
  const billDiscount = Math.max(0, Math.min(opts.billDiscount ?? 0, afterLineSum));
  const billAlloc = allocateProportionally(billDiscount, afterLine);

  const lines: BilledLine[] = inputs.map((l, i) => {
    const net = afterLine[i] - billAlloc[i];
    let taxableValue: number;
    let taxTotal: number;
    if (l.priceIncludesTax) {
      taxableValue = mulDivRound(net, 10000, 10000 + l.gstRateBp);
      taxTotal = net - taxableValue;
    } else {
      taxableValue = net;
      taxTotal = mulDivRound(net, l.gstRateBp, 10000);
    }
    const split = splitTax(taxTotal, opts.interState);
    return {
      gross: grosses[i],
      discount: grosses[i] - net,
      taxableValue,
      ...split,
      taxTotal,
      lineTotal: taxableValue + taxTotal,
    };
  });

  const sum = (k: keyof BilledLine) => lines.reduce((s, l) => s + l[k], 0);
  const subtotal = sum('lineTotal');
  const grandTotal = opts.roundToRupee ? Math.round(subtotal / 100) * 100 : subtotal;
  return {
    lines,
    grossTotal: sum('gross'),
    discountTotal: sum('discount'),
    taxableTotal: sum('taxableValue'),
    cgstTotal: sum('cgst'),
    sgstTotal: sum('sgst'),
    igstTotal: sum('igst'),
    taxTotal: sum('taxTotal'),
    subtotal,
    roundOff: grandTotal - subtotal,
    grandTotal,
  };
}

export interface RefundableLine {
  qtySold: number;
  qtyAlreadyReturned: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  lineTotal: number;
}

export interface LineRefund {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
}

/**
 * Pro-rata refund for returning `qty` units of a sold line. Computed as the
 * difference between cumulative shares so repeated partial returns sum exactly to
 * the original line amounts.
 */
export function computeLineRefund(line: RefundableLine, qty: number): LineRefund {
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('Return quantity must be a positive integer');
  if (line.qtyAlreadyReturned + qty > line.qtySold) throw new Error('Return quantity exceeds quantity sold');
  const share = (amount: number, q: number) => mulDivRound(amount, q, line.qtySold);
  const before = line.qtyAlreadyReturned;
  const after = before + qty;
  const part = (amount: number) => share(amount, after) - share(amount, before);
  const taxableValue = part(line.taxableValue);
  const cgst = part(line.cgst);
  const sgst = part(line.sgst);
  const igst = part(line.igst);
  return { taxableValue, cgst, sgst, igst, total: taxableValue + cgst + sgst + igst };
}

export interface PaymentInput {
  method: 'CASH' | 'UPI' | 'CARD';
  amount: number;
}

export interface PaymentCheck {
  ok: boolean;
  paid: number;
  change: number;
  error?: string;
}

/** Split payments: non-cash may not exceed the bill; only cash produces change. */
export function checkPayments(grandTotal: number, payments: PaymentInput[]): PaymentCheck {
  if (payments.some((p) => !Number.isInteger(p.amount) || p.amount <= 0)) {
    return { ok: false, paid: 0, change: 0, error: 'Payment amounts must be positive' };
  }
  const paid = payments.reduce((s, p) => s + p.amount, 0);
  const nonCash = payments.filter((p) => p.method !== 'CASH').reduce((s, p) => s + p.amount, 0);
  if (nonCash > grandTotal) return { ok: false, paid, change: 0, error: 'Card/UPI amount exceeds bill total' };
  if (paid < grandTotal) return { ok: false, paid, change: 0, error: 'Payment is less than bill total' };
  return { ok: true, paid, change: paid - grandTotal };
}
