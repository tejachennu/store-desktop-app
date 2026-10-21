import type { Role } from './enums.js';

export const PERMISSIONS = [
  'dashboard.view',
  'products.view',
  'products.manage',
  'stock.view',
  'stock.view_all',
  'stock.adjust',
  'stock.opening',
  'pos.sell',
  'pos.discount',
  'pos.return',
  'sales.view',
  'customers.view',
  'customers.manage',
  'transfers.view',
  'transfers.request',
  'transfers.approve',
  'transfers.dispatch',
  'transfers.receive',
  'transfers.resolve',
  'purchase.view',
  'purchase.order',
  'purchase.receive',
  'purchase.return',
  'suppliers.view',
  'suppliers.manage',
  'supplier_payments.manage',
  'reports.view',
  'reports.consolidated',
  'reports.gst',
  'users.manage',
  'locations.manage',
  'settings.manage',
  'sync.admin',
  'audit.view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  COMPANY_ADMIN: ALL,
  WAREHOUSE_MANAGER: [
    'dashboard.view',
    'products.view',
    'stock.view',
    'stock.adjust',
    'stock.opening',
    'transfers.view',
    'transfers.request',
    'transfers.approve',
    'transfers.dispatch',
    'transfers.receive',
    'purchase.view',
    'purchase.receive',
    'purchase.return',
    'suppliers.view',
    'reports.view',
  ],
  BRANCH_MANAGER: [
    'dashboard.view',
    'products.view',
    'stock.view',
    'stock.adjust',
    'pos.sell',
    'pos.discount',
    'pos.return',
    'sales.view',
    'customers.view',
    'customers.manage',
    'transfers.view',
    'transfers.request',
    'transfers.approve',
    'transfers.dispatch',
    'transfers.receive',
    'purchase.view',
    'purchase.receive',
    'suppliers.view',
    'reports.view',
  ],
  SALES_STAFF: [
    'products.view',
    'stock.view',
    'pos.sell',
    'pos.discount',
    'pos.return',
    'sales.view',
    'customers.view',
    'customers.manage',
  ],
  PURCHASE_STAFF: [
    'dashboard.view',
    'products.view',
    'stock.view',
    'suppliers.view',
    'suppliers.manage',
    'purchase.view',
    'purchase.order',
    'purchase.receive',
    'purchase.return',
    'reports.view',
  ],
  ACCOUNTS_STAFF: [
    'dashboard.view',
    'products.view',
    'stock.view',
    'sales.view',
    'customers.view',
    'suppliers.view',
    'purchase.view',
    'supplier_payments.manage',
    'reports.view',
    'reports.gst',
  ],
};

export interface AccessSubject {
  role: Role;
  /** Company admins (and anyone flagged) can act at every location. */
  allLocations: boolean;
  locationIds: readonly string[];
}

export function hasPermission(subject: Pick<AccessSubject, 'role'>, permission: Permission): boolean {
  return ROLE_PERMISSIONS[subject.role].includes(permission);
}

export function canAccessLocation(subject: AccessSubject, locationId: string): boolean {
  return subject.allLocations || subject.locationIds.includes(locationId);
}

/** Permission check scoped to a location — the rule used for every location-bound action. */
export function canAt(subject: AccessSubject, permission: Permission, locationId: string): boolean {
  return hasPermission(subject, permission) && canAccessLocation(subject, locationId);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
