import type { LocationRow, Permission, UserRow } from '@store/shared';
import { canAccessLocation, hasPermission } from '@store/shared';
import type { DB } from './db/connection';
import { AppError, forbidden } from './errors';
import type { ApiClient } from './sync/api-client';

export interface DeviceInfo {
  deviceId: string;
  deviceNo: number;
  locationId: string;
  serverUrl: string;
}

export interface SessionUser extends UserRow {
  permissions: Permission[];
}

export interface Session {
  user: SessionUser;
  /** Present after an online login; required for central (master data / consolidated) operations. */
  accessToken: string | null;
  expiresAt: string | null;
  mode: 'online' | 'offline';
  startedAt: string;
}

export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/** Everything a core service needs. Built once by the Electron main process (or by tests). */
export interface CoreContext {
  db: DB;
  secrets: SecretStore;
  device: DeviceInfo | null;
  session: Session | null;
  api: ApiClient | null;
  /** Called after every local write that queued sync events. */
  onLocalWrite: () => void;
}

export function requireDevice(ctx: CoreContext): DeviceInfo {
  if (!ctx.device) throw new AppError('NOT_REGISTERED', 'This computer is not registered to a warehouse or branch yet');
  return ctx.device;
}

export function requireSession(ctx: CoreContext): Session {
  if (!ctx.session) throw new AppError('UNAUTHORIZED', 'Please sign in');
  return ctx.session;
}

/** Permission check at this device's location (the single place where operational work happens). */
export function requireHere(ctx: CoreContext, ...anyOf: Permission[]): { session: Session; device: DeviceInfo } {
  const session = requireSession(ctx);
  const device = requireDevice(ctx);
  if (!canAccessLocation(session.user, device.locationId)) throw forbidden('You are not assigned to this location');
  if (!anyOf.some((p) => hasPermission(session.user, p))) throw forbidden();
  return { session, device };
}

export function requirePermission(ctx: CoreContext, permission: Permission): Session {
  const session = requireSession(ctx);
  if (!hasPermission(session.user, permission)) throw forbidden();
  return session;
}

export function requireOnline(ctx: CoreContext): { api: ApiClient; token: string; session: Session } {
  const session = requireSession(ctx);
  if (!ctx.api || !session.accessToken || (session.expiresAt && new Date(session.expiresAt) < new Date())) {
    throw new AppError('OFFLINE', 'This action needs an online sign-in to the central server. Sign out and sign in again while connected.');
  }
  return { api: ctx.api, token: session.accessToken, session };
}

export type { LocationRow };
