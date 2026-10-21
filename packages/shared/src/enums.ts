export const LOCATION_TYPES = ['WAREHOUSE', 'BRANCH'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const ROLES = [
  'COMPANY_ADMIN',
  'WAREHOUSE_MANAGER',
  'BRANCH_MANAGER',
  'SALES_STAFF',
  'PURCHASE_STAFF',
  'ACCOUNTS_STAFF',
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  COMPANY_ADMIN: 'Company Admin',
  WAREHOUSE_MANAGER: 'Warehouse Manager',
  BRANCH_MANAGER: 'Branch Manager',
  SALES_STAFF: 'Sales Staff (POS)',
  PURCHASE_STAFF: 'Purchase Staff',
  ACCOUNTS_STAFF: 'Accounts Staff',
};

export const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * Every stock change is one of these. Sign of qty_delta is determined by the
 * business operation, not by the type, except where noted.
 */
export const MOVEMENT_TYPES = [
  'OPENING', // +, opening stock entered for a location
  'SALE', // -
  'SALE_RETURN', // +, restockable customer returns
  'PURCHASE_RECEIPT', // +, GRN
  'PURCHASE_RETURN', // -, goods returned to supplier
  'TRANSFER_OUT', // -, dispatch at source
  'TRANSFER_IN', // +, receipt at destination
  'TRANSFER_RESOLUTION', // +, missing in-transit stock returned to source by admin resolution
  'ADJUSTMENT', // +/-, with reason
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const ADJUSTMENT_REASONS = [
  'DAMAGE',
  'LOSS',
  'THEFT',
  'EXPIRY',
  'FOUND',
  'COUNT_CORRECTION',
  'OTHER',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const TRANSFER_STATUSES = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'PARTIALLY_DISPATCHED',
  'DISPATCHED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
  'CLOSED_WITH_DISCREPANCY',
  'CANCELLED',
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const PO_STATUSES = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

export const SYNC_STATUSES = ['PENDING', 'SYNCED', 'FAILED'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

export const RECONCILIATION_TYPES = [
  'NEGATIVE_STOCK',
  'TRANSFER_CONFLICT',
  'TRANSFER_DISCREPANCY',
  'REJECTED_EVENT',
] as const;
export type ReconciliationType = (typeof RECONCILIATION_TYPES)[number];

export const UNITS = ['pcs', 'g', 'kg', 'ml', 'l', 'm', 'box', 'pack', 'pair', 'set'] as const;

/** Common Indian GST slabs, in basis points. */
export const GST_RATES_BP = [0, 25, 300, 500, 1200, 1800, 2800] as const;

/** Indian state / UT GST codes. */
export const STATE_CODES: Record<string, string> = {
  '01': 'Jammu & Kashmir',
  '02': 'Himachal Pradesh',
  '03': 'Punjab',
  '04': 'Chandigarh',
  '05': 'Uttarakhand',
  '06': 'Haryana',
  '07': 'Delhi',
  '08': 'Rajasthan',
  '09': 'Uttar Pradesh',
  '10': 'Bihar',
  '11': 'Sikkim',
  '12': 'Arunachal Pradesh',
  '13': 'Nagaland',
  '14': 'Manipur',
  '15': 'Mizoram',
  '16': 'Tripura',
  '17': 'Meghalaya',
  '18': 'Assam',
  '19': 'West Bengal',
  '20': 'Jharkhand',
  '21': 'Odisha',
  '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh',
  '24': 'Gujarat',
  '26': 'Dadra & Nagar Haveli and Daman & Diu',
  '27': 'Maharashtra',
  '29': 'Karnataka',
  '30': 'Goa',
  '31': 'Lakshadweep',
  '32': 'Kerala',
  '33': 'Tamil Nadu',
  '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands',
  '36': 'Telangana',
  '37': 'Andhra Pradesh',
  '38': 'Ladakh',
};
