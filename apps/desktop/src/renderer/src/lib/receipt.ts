import { formatINR, formatRate, STATE_CODES, type CompanySettings, type LocationRow } from '@store/shared';
import type { ApiResult } from '../../../core/api';

type Sale = ApiResult<'sales.get'>;

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts: string[] = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(r < 20 ? ONES[r] : `${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`);
  return parts.join(' ');
}

/** Indian numbering system: 1,23,45,678 → "One Crore Twenty Three Lakh …". */
export function rupeesInWords(paise: number): string {
  const rupees = Math.floor(Math.abs(paise) / 100);
  const p = Math.abs(paise) % 100;
  if (rupees === 0 && p === 0) return 'Zero Rupees Only';
  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1000);
  const rest = rupees % 1000;
  const parts: string[] = [];
  if (crore) parts.push(`${below1000(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (rest) parts.push(below1000(rest));
  let words = parts.length ? `${parts.join(' ')} Rupees` : '';
  if (p) words += `${words ? ' and ' : ''}${below1000(p)} Paise`;
  return `${words} Only`;
}

interface Ctx {
  settings: CompanySettings;
  location: LocationRow;
}

/** Thermal receipt (58/80 mm). */
export function receiptHtml(sale: Sale, ctx: Ctx, widthMm: 58 | 80 = 80): string {
  const w = widthMm === 58 ? 54 : 76;
  const lines = sale.lines
    .map(
      (l) => `<tr><td colspan="3">${esc(l.name)}</td></tr>
      <tr><td>${l.qty} × ${formatINR(l.unitPrice)}</td><td class="r">${l.discount ? '-' + formatINR(l.discount) : ''}</td><td class="r">${formatINR(l.lineTotal)}</td></tr>`,
    )
    .join('');
  const taxRows = sale.interState
    ? `<tr><td>IGST</td><td class="r" colspan="2">${formatINR(sale.igstTotal)}</td></tr>`
    : `<tr><td>CGST</td><td class="r" colspan="2">${formatINR(sale.cgstTotal)}</td></tr><tr><td>SGST</td><td class="r" colspan="2">${formatINR(sale.sgstTotal)}</td></tr>`;
  const pays = sale.payments.map((p) => `<tr><td>${esc(p.method)}</td><td class="r" colspan="2">${formatINR(p.amount)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${widthMm}mm auto; margin: 2mm; }
    body { font-family: 'Consolas', 'Courier New', monospace; font-size: 11px; width: ${w}mm; margin: 0; color: #000; }
    h1 { font-size: 14px; text-align: center; margin: 2px 0; } .c { text-align: center; } .r { text-align: right; }
    table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; }
    hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; } .big { font-size: 14px; font-weight: bold; }
  </style></head><body>
    <h1>${esc(ctx.settings.name)}</h1>
    <div class="c">${esc(ctx.location.name)}</div>
    ${ctx.location.address ? `<div class="c">${esc(ctx.location.address)}</div>` : ''}
    ${ctx.location.gstin || ctx.settings.gstin ? `<div class="c">GSTIN: ${esc(ctx.location.gstin ?? ctx.settings.gstin)}</div>` : ''}
    <div class="c"><b>TAX INVOICE</b></div><hr>
    <div>Invoice: <b>${esc(sale.invoiceNo)}</b></div>
    <div>Date: ${new Date(sale.occurredAt).toLocaleString('en-IN')}</div>
    ${sale.customer ? `<div>Customer: ${esc(sale.customer.name)}${sale.customer.phone ? ' (' + esc(sale.customer.phone) + ')' : ''}</div>` : ''}
    ${sale.customer?.gstin ? `<div>Cust. GSTIN: ${esc(sale.customer.gstin)}</div>` : ''}
    <div>Cashier: ${esc(sale.userName)}</div><hr>
    <table>${lines}</table><hr>
    <table>
      <tr><td>Taxable value</td><td class="r" colspan="2">${formatINR(sale.taxableTotal)}</td></tr>
      ${taxRows}
      ${sale.discountTotal ? `<tr><td>You saved</td><td class="r" colspan="2">${formatINR(sale.discountTotal)}</td></tr>` : ''}
      ${sale.roundOff ? `<tr><td>Round off</td><td class="r" colspan="2">${formatINR(sale.roundOff)}</td></tr>` : ''}
      <tr class="big"><td>TOTAL</td><td class="r" colspan="2">${formatINR(sale.grandTotal)}</td></tr>
    </table><hr>
    <table>${pays}${sale.change ? `<tr><td>Change</td><td class="r" colspan="2">${formatINR(sale.change)}</td></tr>` : ''}</table><hr>
    <div class="c">${esc(ctx.settings.receiptFooter ?? 'Thank you! Visit again.')}</div>
  </body></html>`;
}

/** A4 GST tax invoice with HSN-wise tax summary. */
export function invoiceHtml(sale: Sale, ctx: Ctx): string {
  const rows = sale.lines
    .map(
      (l, i) => `<tr><td>${i + 1}</td><td>${esc(l.name)}<br><small>${esc(l.sku)}</small></td><td>${esc(l.hsnCode ?? '')}</td><td class="r">${l.qty}</td>
      <td class="r">${formatINR(l.unitPrice)}</td><td class="r">${formatINR(l.discount)}</td><td class="r">${formatINR(l.taxableValue)}</td>
      <td class="r">${formatRate(l.gstRateBp)}</td><td class="r">${formatINR(l.cgst + l.sgst + l.igst)}</td><td class="r">${formatINR(l.lineTotal)}</td></tr>`,
    )
    .join('');
  const hsn = new Map<string, { taxable: number; cgst: number; sgst: number; igst: number; rate: number }>();
  for (const l of sale.lines) {
    const k = `${l.hsnCode ?? 'NA'}|${l.gstRateBp}`;
    const e = hsn.get(k) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0, rate: l.gstRateBp };
    e.taxable += l.taxableValue;
    e.cgst += l.cgst;
    e.sgst += l.sgst;
    e.igst += l.igst;
    hsn.set(k, e);
  }
  const hsnRows = [...hsn.entries()]
    .map(([k, e]) => `<tr><td>${esc(k.split('|')[0])}</td><td class="r">${formatRate(e.rate)}</td><td class="r">${formatINR(e.taxable)}</td><td class="r">${formatINR(e.cgst)}</td><td class="r">${formatINR(e.sgst)}</td><td class="r">${formatINR(e.igst)}</td></tr>`)
    .join('');
  const pos = sale.customer?.stateCode ?? ctx.location.stateCode;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: A4; margin: 12mm; } body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px; color: #111; }
    h1 { font-size: 18px; margin: 0; color: #1565c0; } h2 { font-size: 14px; text-align: center; margin: 8px 0; letter-spacing: 1px; }
    table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #999; padding: 4px; } th { background: #e8f0fb; }
    .r { text-align: right; } .grid { display: flex; gap: 16px; } .grid > div { flex: 1; border: 1px solid #999; padding: 6px; }
    .tot td { border: none; padding: 2px 4px; } small { color: #555; }
  </style></head><body>
    <h1>${esc(ctx.settings.name)}</h1>
    <div>${esc(ctx.location.name)}${ctx.location.address ? ', ' + esc(ctx.location.address) : ''}</div>
    <div>GSTIN: ${esc(ctx.location.gstin ?? ctx.settings.gstin ?? '—')} · State: ${esc(STATE_CODES[ctx.location.stateCode] ?? ctx.location.stateCode)} (${esc(ctx.location.stateCode)})</div>
    <h2>TAX INVOICE</h2>
    <div class="grid">
      <div><b>Invoice No:</b> ${esc(sale.invoiceNo)}<br><b>Date:</b> ${new Date(sale.occurredAt).toLocaleString('en-IN')}<br>
        <b>Place of supply:</b> ${esc(STATE_CODES[pos] ?? pos)} (${esc(pos)})</div>
      <div><b>Bill to:</b> ${esc(sale.customer?.name ?? 'Walk-in customer')}<br>${sale.customer?.address ? esc(sale.customer.address) + '<br>' : ''}
        ${sale.customer?.gstin ? '<b>GSTIN:</b> ' + esc(sale.customer.gstin) + '<br>' : ''}${sale.customer?.phone ? 'Ph: ' + esc(sale.customer.phone) : ''}</div>
    </div><br>
    <table><thead><tr><th>#</th><th>Item</th><th>HSN</th><th>Qty</th><th>Rate</th><th>Disc.</th><th>Taxable</th><th>GST</th><th>Tax</th><th>Amount</th></tr></thead>
    <tbody>${rows}</tbody></table><br>
    <div class="grid"><div>
      <table><thead><tr><th>HSN</th><th>Rate</th><th>Taxable</th><th>CGST</th><th>SGST</th><th>IGST</th></tr></thead><tbody>${hsnRows}</tbody></table>
      <p><b>Amount in words:</b> ${rupeesInWords(sale.grandTotal)}</p>
    </div><div>
      <table class="tot">
        <tr><td>Taxable value</td><td class="r">${formatINR(sale.taxableTotal)}</td></tr>
        <tr><td>CGST</td><td class="r">${formatINR(sale.cgstTotal)}</td></tr>
        <tr><td>SGST</td><td class="r">${formatINR(sale.sgstTotal)}</td></tr>
        <tr><td>IGST</td><td class="r">${formatINR(sale.igstTotal)}</td></tr>
        <tr><td>Round off</td><td class="r">${formatINR(sale.roundOff)}</td></tr>
        <tr><td><b>Grand total</b></td><td class="r"><b>${formatINR(sale.grandTotal)}</b></td></tr>
        <tr><td>Paid (${esc(sale.payments.map((p) => p.method).join(' + ') || '—')})</td><td class="r">${formatINR(sale.tendered)}</td></tr>
      </table>
    </div></div>
    <p style="margin-top:32px;text-align:right">For ${esc(ctx.settings.name)}<br><br><br>Authorised signatory</p>
  </body></html>`;
}

/** Credit note for a sales return. */
export function creditNoteHtml(ret: ApiResult<'sales.getReturn'>, ctx: Ctx, widthMm: 58 | 80 = 80): string {
  const w = widthMm === 58 ? 54 : 76;
  const lines = (ret.lines as { name: string; qty: number; total: number; restock: number }[])
    .map((l) => `<tr><td>${esc(l.name)} × ${l.qty}${l.restock ? '' : ' (damaged)'}</td><td class="r">${formatINR(l.total)}</td></tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${widthMm}mm auto; margin: 2mm; } body { font-family: Consolas, monospace; font-size: 11px; width: ${w}mm; margin: 0; }
    .c { text-align: center; } .r { text-align: right; } table { width: 100%; } hr { border: 0; border-top: 1px dashed #000; }
  </style></head><body>
    <div class="c"><b>${esc(ctx.settings.name)}</b><br>${esc(ctx.location.name)}<br><b>CREDIT NOTE</b></div><hr>
    <div>No: ${esc(ret.returnNo)}<br>Against invoice: ${esc(ret.invoiceNo)}<br>Date: ${new Date(ret.occurredAt).toLocaleString('en-IN')}<br>Reason: ${esc(ret.reason)}</div><hr>
    <table>${lines}</table><hr>
    <table><tr><td><b>Refund</b></td><td class="r"><b>${formatINR(ret.refundTotal)}</b></td></tr>
    ${(ret.refunds as { method: string; amount: number }[]).map((r) => `<tr><td>${esc(r.method)}</td><td class="r">${formatINR(r.amount)}</td></tr>`).join('')}</table>
  </body></html>`;
}
