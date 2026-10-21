import type { LocationType, TransferStatus } from './enums.js';

export interface TransferRouteSettings {
  /** Branch → branch transfers (optional business feature). */
  branchToBranchEnabled: boolean;
  /** Branch → warehouse returns of excess / slow-moving stock. */
  branchToWarehouseEnabled: boolean;
}

export type RouteCheck = { ok: true } | { ok: false; reason: string };

export function checkTransferRoute(
  source: { id: string; type: LocationType; isActive: boolean },
  dest: { id: string; type: LocationType; isActive: boolean },
  settings: TransferRouteSettings,
): RouteCheck {
  if (source.id === dest.id) return { ok: false, reason: 'Source and destination must be different locations' };
  if (!source.isActive || !dest.isActive) return { ok: false, reason: 'Both locations must be active' };
  if (source.type === 'WAREHOUSE') return { ok: true };
  if (dest.type === 'BRANCH' && !settings.branchToBranchEnabled) {
    return { ok: false, reason: 'Branch-to-branch transfers are disabled' };
  }
  if (dest.type === 'WAREHOUSE' && !settings.branchToWarehouseEnabled) {
    return { ok: false, reason: 'Branch-to-warehouse returns are disabled' };
  }
  return { ok: true };
}

export interface TransferLineQty {
  qtyRequested: number;
  qtyApproved: number;
  qtyDispatched: number;
  qtyReceived: number;
  qtyDamaged: number;
}

/** Derived status for a transfer that has been approved (and is not closed/cancelled). */
export function deriveFulfilmentStatus(lines: TransferLineQty[]): TransferStatus {
  const approved = lines.reduce((s, l) => s + l.qtyApproved, 0);
  const dispatched = lines.reduce((s, l) => s + l.qtyDispatched, 0);
  const accounted = lines.reduce((s, l) => s + l.qtyReceived + l.qtyDamaged, 0);
  if (dispatched === 0) return 'APPROVED';
  if (dispatched < approved) return 'PARTIALLY_DISPATCHED';
  if (accounted === 0) return 'DISPATCHED';
  if (accounted < dispatched) return 'PARTIALLY_RECEIVED';
  return 'RECEIVED';
}

export type TransferAction = 'APPROVE' | 'REJECT' | 'CANCEL' | 'DISPATCH' | 'RECEIVE' | 'CLOSE';

const ALLOWED_FROM: Record<TransferAction, readonly TransferStatus[]> = {
  APPROVE: ['REQUESTED'],
  REJECT: ['REQUESTED'],
  CANCEL: ['REQUESTED', 'APPROVED'],
  DISPATCH: ['APPROVED', 'PARTIALLY_DISPATCHED', 'PARTIALLY_RECEIVED'],
  RECEIVE: ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'PARTIALLY_RECEIVED'],
  CLOSE: ['PARTIALLY_DISPATCHED', 'DISPATCHED', 'PARTIALLY_RECEIVED'],
};

export function canTransition(status: TransferStatus, action: TransferAction): boolean {
  return ALLOWED_FROM[action].includes(status);
}

/** Which side of a transfer is allowed to perform an action (single-owner rule). */
export function actionSide(action: TransferAction): 'SOURCE' | 'DEST' | 'EITHER' {
  switch (action) {
    case 'APPROVE':
    case 'REJECT':
    case 'DISPATCH':
      return 'SOURCE';
    case 'RECEIVE':
    case 'CLOSE':
      return 'DEST';
    case 'CANCEL':
      return 'EITHER';
  }
}

export const TERMINAL_TRANSFER_STATUSES: readonly TransferStatus[] = [
  'REJECTED',
  'CANCELLED',
  'RECEIVED',
  'CLOSED_WITH_DISCREPANCY',
];

export const TRANSFER_STATUS_LABELS: Record<TransferStatus, string> = {
  REQUESTED: 'Requested',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  PARTIALLY_DISPATCHED: 'Partially dispatched',
  DISPATCHED: 'In transit',
  PARTIALLY_RECEIVED: 'Partially received',
  RECEIVED: 'Received',
  CLOSED_WITH_DISCREPANCY: 'Closed with discrepancy',
  CANCELLED: 'Cancelled',
};
