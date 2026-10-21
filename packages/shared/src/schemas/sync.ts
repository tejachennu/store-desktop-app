import { z } from 'zod';
import { ADJUSTMENT_REASONS } from '../enums.js';
import { customerInputSchema, id, isoDate, isoDateTime, optionalText, paise, paymentMethodSchema, rateBp } from './master.js';

const qty = z.number().int().positive();
const qtyNonNeg = z.number().int().min(0);

const taxParts = {
  taxableValue: paise,
  cgst: paise,
  sgst: paise,
  igst: paise,
};

export const saleLineSchema = z.object({
  /** Also the id of the SALE stock movement for this line. */
  id,
  productId: id,
  sku: z.string().max(40),
  name: z.string().max(160),
  hsnCode: z.string().max(8).nullable(),
  qty,
  unitPrice: paise,
  priceIncludesTax: z.boolean(),
  gstRateBp: rateBp,
  discount: paise,
  ...taxParts,
  lineTotal: paise,
});

export const paymentSchema = z.object({
  id,
  method: paymentMethodSchema,
  amount: z.number().int().positive(),
  reference: optionalText(80),
});

export const salePayloadSchema = z.object({
  id,
  invoiceNo: z.string().min(3).max(20),
  customerId: id.nullable(),
  interState: z.boolean(),
  grossTotal: paise,
  discountTotal: paise,
  taxableTotal: paise,
  cgstTotal: paise,
  sgstTotal: paise,
  igstTotal: paise,
  roundOff: z.number().int().min(-100).max(100),
  grandTotal: paise,
  tendered: paise,
  change: paise,
  notes: optionalText(),
  exchangeReturnId: id.nullable().default(null),
  lines: z.array(saleLineSchema).min(1).max(500),
  payments: z.array(paymentSchema).max(10),
});
export type SalePayload = z.infer<typeof salePayloadSchema>;

export const saleReturnPayloadSchema = z.object({
  id,
  returnNo: z.string().min(3).max(20),
  saleId: id,
  reason: z.string().trim().min(2).max(300),
  refundTotal: paise,
  lines: z
    .array(
      z.object({
        /** Also the SALE_RETURN movement id when restocked. */
        id,
        saleLineId: id,
        productId: id,
        qty,
        restock: z.boolean(),
        ...taxParts,
        total: paise,
      }),
    )
    .min(1),
  refunds: z.array(paymentSchema).max(10),
});
export type SaleReturnPayload = z.infer<typeof saleReturnPayloadSchema>;

export const stockAdjustmentPayloadSchema = z.object({
  id,
  adjustmentNo: z.string().min(3).max(20),
  kind: z.enum(['OPENING', 'ADJUSTMENT']),
  reason: z.enum([...ADJUSTMENT_REASONS, 'OPENING']),
  notes: optionalText(),
  lines: z
    .array(
      z.object({
        id,
        productId: id,
        qtyDelta: z.number().int().refine((v) => v !== 0, 'Quantity cannot be zero'),
        unitCost: paise,
      }),
    )
    .min(1),
});
export type StockAdjustmentPayload = z.infer<typeof stockAdjustmentPayloadSchema>;

const purchaseLine = z.object({
  id,
  productId: id,
  qty,
  unitCost: paise,
  gstRateBp: rateBp,
  taxableValue: paise,
  taxTotal: paise,
  total: paise,
});

export const grnPayloadSchema = z.object({
  id,
  grnNo: z.string().min(3).max(20),
  purchaseOrderId: id.nullable(),
  supplierId: id,
  supplierInvoiceNo: optionalText(40),
  supplierInvoiceDate: isoDate.nullable(),
  taxableTotal: paise,
  taxTotal: paise,
  grandTotal: paise,
  notes: optionalText(),
  lines: z.array(purchaseLine.extend({ purchaseOrderLineId: id.nullable() })).min(1),
});
export type GrnPayload = z.infer<typeof grnPayloadSchema>;

export const purchaseReturnPayloadSchema = z.object({
  id,
  returnNo: z.string().min(3).max(20),
  supplierId: id,
  grnId: id.nullable(),
  reason: z.string().trim().min(2).max(300),
  taxableTotal: paise,
  taxTotal: paise,
  grandTotal: paise,
  lines: z.array(purchaseLine).min(1),
});
export type PurchaseReturnPayload = z.infer<typeof purchaseReturnPayloadSchema>;

export const supplierPaymentPayloadSchema = z.object({
  id,
  supplierId: id,
  grnId: id.nullable(),
  amount: z.number().int().positive(),
  method: z.enum(['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'CHEQUE']),
  reference: optionalText(80),
  paidOn: isoDate,
});
export type SupplierPaymentPayload = z.infer<typeof supplierPaymentPayloadSchema>;

export const transferCreatePayloadSchema = z.object({
  id,
  transferNo: z.string().min(3).max(20),
  sourceLocationId: id,
  destLocationId: id,
  notes: optionalText(),
  /** Only allowed when the creating device belongs to the source (direct dispatch). */
  autoApprove: z.boolean(),
  lines: z.array(z.object({ id, productId: id, qtyRequested: qty })).min(1).max(500),
});
export type TransferCreatePayload = z.infer<typeof transferCreatePayloadSchema>;

export const transferApprovePayloadSchema = z.object({
  transferId: id,
  lines: z.array(z.object({ lineId: id, qtyApproved: qtyNonNeg })).min(1),
});
export const transferRejectPayloadSchema = z.object({ transferId: id, reason: z.string().trim().min(2).max(300) });
export const transferCancelPayloadSchema = transferRejectPayloadSchema;
export const transferDispatchPayloadSchema = z.object({
  id,
  transferId: id,
  notes: optionalText(),
  /** Each line id is also the TRANSFER_OUT movement id. */
  lines: z.array(z.object({ id, lineId: id, qty })).min(1),
});
export const transferReceivePayloadSchema = z.object({
  id,
  transferId: id,
  notes: optionalText(),
  /** Each line id is also the TRANSFER_IN movement id (when qtyReceived > 0). */
  lines: z
    .array(z.object({ id, lineId: id, qtyReceived: qtyNonNeg, qtyDamaged: qtyNonNeg }))
    .min(1)
    .refine((ls) => ls.every((l) => l.qtyReceived + l.qtyDamaged > 0), 'Each line must receive a quantity'),
});
export const transferClosePayloadSchema = z.object({ transferId: id, notes: optionalText() });

export type TransferApprovePayload = z.infer<typeof transferApprovePayloadSchema>;
export type TransferRejectPayload = z.infer<typeof transferRejectPayloadSchema>;
export type TransferCancelPayload = z.infer<typeof transferCancelPayloadSchema>;
export type TransferDispatchPayload = z.infer<typeof transferDispatchPayloadSchema>;
export type TransferReceivePayload = z.infer<typeof transferReceivePayloadSchema>;
export type TransferClosePayload = z.infer<typeof transferClosePayloadSchema>;

const envelope = {
  /** Idempotency key. Unique per event, generated when the event is written to the outbox. */
  id,
  locationId: id,
  userId: id,
  occurredAt: isoDateTime,
};

export const syncEventSchema = z.discriminatedUnion('type', [
  z.object({ ...envelope, type: z.literal('customer.upsert'), payload: customerInputSchema }),
  z.object({ ...envelope, type: z.literal('sale.create'), payload: salePayloadSchema }),
  z.object({ ...envelope, type: z.literal('sale_return.create'), payload: saleReturnPayloadSchema }),
  z.object({ ...envelope, type: z.literal('stock_adjustment.create'), payload: stockAdjustmentPayloadSchema }),
  z.object({ ...envelope, type: z.literal('grn.create'), payload: grnPayloadSchema }),
  z.object({ ...envelope, type: z.literal('purchase_return.create'), payload: purchaseReturnPayloadSchema }),
  z.object({ ...envelope, type: z.literal('supplier_payment.create'), payload: supplierPaymentPayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.create'), payload: transferCreatePayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.approve'), payload: transferApprovePayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.reject'), payload: transferRejectPayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.cancel'), payload: transferCancelPayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.dispatch'), payload: transferDispatchPayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.receive'), payload: transferReceivePayloadSchema }),
  z.object({ ...envelope, type: z.literal('transfer.close'), payload: transferClosePayloadSchema }),
]);
export type SyncEvent = z.infer<typeof syncEventSchema>;
export type SyncEventType = SyncEvent['type'];
export type SyncEventOf<T extends SyncEventType> = Extract<SyncEvent, { type: T }>;

export const syncPushRequestSchema = z.object({
  events: z.array(z.unknown()).min(1).max(200),
});

export type SyncPushResult = {
  id: string;
  status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED';
  error?: string;
  /** REJECTED results that can succeed later (e.g. a dependency not yet synced). */
  retryable?: boolean;
};

export interface SyncPushResponse {
  results: SyncPushResult[];
}
