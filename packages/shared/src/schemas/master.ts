import { z } from 'zod';
import { LOCATION_TYPES, PAYMENT_METHODS, PO_STATUSES, ROLES } from '../enums.js';

export const id = z.uuid();
export const paise = z.number().int().min(0).max(1_000_000_000_00);
export const rateBp = z.number().int().min(0).max(10000);
export const stateCode = z.string().regex(/^\d{2}$/, 'State code must be 2 digits');
export const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Invalid GSTIN');
export const optionalText = (max = 500) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
export const isoDateTime = z.iso.datetime({ offset: true });
export const isoDate = z.iso.date();

export const companySettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  gstin: gstin.nullish().transform((v) => v ?? null),
  stateCode,
  address: optionalText(),
  phone: optionalText(30),
  branchToBranchEnabled: z.boolean(),
  branchToWarehouseEnabled: z.boolean(),
  allowNegativeStock: z.boolean(),
  roundToRupee: z.boolean(),
  receiptFooter: optionalText(300),
  defaultLowStockLevel: z.number().int().min(0).max(1_000_000),
});
export type CompanySettings = z.infer<typeof companySettingsSchema>;

export const locationInputSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,6}$/, 'Code must be 2-6 letters/digits'),
  name: z.string().trim().min(2).max(120),
  type: z.enum(LOCATION_TYPES),
  address: optionalText(),
  stateCode,
  gstin: gstin.nullish().transform((v) => v ?? null),
  phone: optionalText(30),
  invoicePrefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,5}$/, 'Prefix must be 1-5 letters/digits'),
  canReceivePurchases: z.boolean(),
  isActive: z.boolean().default(true),
});
export type LocationInput = z.infer<typeof locationInputSchema>;

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a digit');

export const userCreateSchema = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9._-]{3,40}$/, 'Username: 3-40 chars, letters, digits, . _ -'),
  fullName: z.string().trim().min(2).max(120),
  password: passwordSchema,
  role: z.enum(ROLES),
  allLocations: z.boolean().default(false),
  locationIds: z.array(id).default([]),
  isActive: z.boolean().default(true),
});
export const userUpdateSchema = userCreateSchema.omit({ username: true, password: true }).extend({
  password: passwordSchema.optional(),
});
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  parentId: id.nullish().transform((v) => v ?? null),
  isActive: z.boolean().default(true),
});
export type CategoryInput = z.infer<typeof categoryInputSchema>;

export const barcodeInputSchema = z.object({
  barcode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9\-.$/+%: ]{3,64}$/, 'Invalid barcode'),
  unitLabel: z.string().trim().min(1).max(20).default('pcs'),
  factor: z.number().int().min(1).max(100000).default(1),
});

export const productInputSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9\-_.]{2,40}$/, 'SKU: 2-40 chars, letters, digits, - _ .'),
    name: z.string().trim().min(2).max(160),
    categoryId: id.nullish().transform((v) => v ?? null),
    brand: optionalText(80),
    hsnCode: z
      .string()
      .trim()
      .regex(/^\d{4,8}$/, 'HSN/SAC must be 4-8 digits')
      .nullish()
      .transform((v) => v ?? null),
    unit: z.string().trim().min(1).max(10),
    gstRateBp: rateBp,
    purchasePrice: paise,
    sellingPrice: paise,
    mrp: paise.nullish().transform((v) => v ?? null),
    priceIncludesTax: z.boolean().default(true),
    reorderLevel: z.number().int().min(0).max(10_000_000).default(0),
    variantGroup: optionalText(80),
    variantAttrs: z.record(z.string().max(40), z.string().max(80)).default({}),
    imageData: z
      .string()
      .max(700_000, 'Image too large (max ~500 KB)')
      .regex(/^data:image\/(png|jpeg|webp);base64,/, 'Image must be PNG, JPEG or WEBP')
      .nullish()
      .transform((v) => v ?? null),
    isActive: z.boolean().default(true),
    barcodes: z.array(barcodeInputSchema).max(20).default([]),
  })
  .refine((p) => p.mrp == null || p.sellingPrice <= p.mrp, {
    message: 'Selling price cannot exceed MRP',
    path: ['sellingPrice'],
  })
  .refine((p) => new Set(p.barcodes.map((b) => b.barcode)).size === p.barcodes.length, {
    message: 'Duplicate barcodes',
    path: ['barcodes'],
  });
export type ProductInput = z.infer<typeof productInputSchema>;

export const supplierInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  gstin: gstin.nullish().transform((v) => v ?? null),
  stateCode: stateCode.nullish().transform((v) => v ?? null),
  phone: optionalText(30),
  email: z.email().nullish().transform((v) => v ?? null),
  address: optionalText(),
  isActive: z.boolean().default(true),
});
export type SupplierInput = z.infer<typeof supplierInputSchema>;

export const customerInputSchema = z.object({
  id,
  name: z.string().trim().min(1).max(160),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9+\- ]{6,20}$/, 'Invalid phone number')
    .nullish()
    .transform((v) => v ?? null),
  email: z.email().nullish().transform((v) => v ?? null),
  gstin: gstin.nullish().transform((v) => v ?? null),
  stateCode: stateCode.nullish().transform((v) => v ?? null),
  address: optionalText(),
});
export type CustomerInput = z.infer<typeof customerInputSchema>;

export const purchaseOrderInputSchema = z.object({
  id,
  supplierId: id,
  locationId: id,
  expectedDate: isoDate.nullish().transform((v) => v ?? null),
  notes: optionalText(),
  status: z.enum(PO_STATUSES).refine((s) => s === 'DRAFT' || s === 'ORDERED', 'New orders must be DRAFT or ORDERED'),
  lines: z
    .array(
      z.object({
        id,
        productId: id,
        qty: z.number().int().positive(),
        unitCost: paise,
        gstRateBp: rateBp,
      }),
    )
    .min(1, 'Add at least one product'),
});
export type PurchaseOrderInput = z.infer<typeof purchaseOrderInputSchema>;

export const paymentMethodSchema = z.enum(PAYMENT_METHODS);

export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1),
  password: z.string().min(1),
});

export const deviceRegisterSchema = z.object({
  locationId: id,
  name: z.string().trim().min(2).max(80),
});

export const openingStockSchema = z.object({
  locationId: id,
  lines: z
    .array(z.object({ productId: id, qty: z.number().int().positive(), unitCost: paise }))
    .min(1),
});
