import type { LocationType, MovementType, PurchaseOrderStatus, Role, TransferStatus } from '../enums.js';
import type { CompanySettings } from './master.js';

/** Row shapes shared by the pull API, the desktop cache and the UI. */

export interface LocationRow {
  id: string;
  code: string;
  name: string;
  type: LocationType;
  address: string | null;
  stateCode: string;
  gstin: string | null;
  phone: string | null;
  invoicePrefix: string;
  canReceivePurchases: boolean;
  isActive: boolean;
}

export interface UserRow {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  allLocations: boolean;
  locationIds: string[];
  isActive: boolean;
}

export interface CategoryRow {
  id: string;
  name: string;
  parentId: string | null;
  isActive: boolean;
}

export interface BarcodeRow {
  barcode: string;
  unitLabel: string;
  factor: number;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  categoryId: string | null;
  brand: string | null;
  hsnCode: string | null;
  unit: string;
  gstRateBp: number;
  purchasePrice: number;
  sellingPrice: number;
  mrp: number | null;
  priceIncludesTax: boolean;
  reorderLevel: number;
  variantGroup: string | null;
  variantAttrs: Record<string, string>;
  imageData: string | null;
  isActive: boolean;
  barcodes: BarcodeRow[];
}

export interface SupplierRow {
  id: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  isActive: boolean;
}

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  stateCode: string | null;
  address: string | null;
}

export interface PurchaseOrderLineRow {
  id: string;
  productId: string;
  qty: number;
  qtyReceived: number;
  unitCost: number;
  gstRateBp: number;
}

export interface PurchaseOrderRow {
  id: string;
  poNo: string;
  supplierId: string;
  locationId: string;
  status: PurchaseOrderStatus;
  expectedDate: string | null;
  notes: string | null;
  createdAt: string;
  lines: PurchaseOrderLineRow[];
}

export interface TransferLineRow {
  id: string;
  productId: string;
  qtyRequested: number;
  qtyApproved: number;
  qtyDispatched: number;
  qtyReceived: number;
  qtyDamaged: number;
}

export interface TransferRow {
  id: string;
  transferNo: string;
  sourceLocationId: string;
  destLocationId: string;
  requestedByLocationId: string;
  status: TransferStatus;
  notes: string | null;
  statusReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: TransferLineRow[];
}

export interface MovementRow {
  id: string;
  locationId: string;
  productId: string;
  qtyDelta: number;
  movementType: MovementType;
  refType: string;
  refId: string;
  unitCost: number;
  occurredAt: string;
  deviceId: string | null;
}

export interface PullResponse {
  cursor: string;
  hasMore: boolean;
  settings: CompanySettings | null;
  locations: LocationRow[];
  users: UserRow[];
  categories: CategoryRow[];
  products: ProductRow[];
  suppliers: SupplierRow[];
  customers: CustomerRow[];
  purchaseOrders: PurchaseOrderRow[];
  transfers: TransferRow[];
  movements: MovementRow[];
}

export interface AuthUser extends UserRow {
  permissions: string[];
}

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  user: AuthUser;
}

export interface DeviceRegistration {
  deviceId: string;
  deviceNo: number;
  deviceKey: string;
  location: LocationRow;
}
