import type { Request, RequestHandler } from 'express';
import { canAccessLocation, hasPermission, type Permission, type Role } from '@store/shared';
import type { AppContext } from '../context.js';
import { one } from '../db/pool.js';
import { hashDeviceSecret, safeEqualHex } from '../auth/password.js';
import { forbidden, unauthorized } from './errors.js';

export interface AuthedUser {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  allLocations: boolean;
  locationIds: string[];
}

export interface AuthedDevice {
  id: string;
  locationId: string;
  deviceNo: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthedUser;
    device?: AuthedDevice;
  }
}

export async function loadAuthedUser(ctx: AppContext, userId: string): Promise<(AuthedUser & { tokenVersion: number; isActive: boolean }) | null> {
  return one(
    ctx.db,
    `SELECT u.id, u.username, u.full_name AS "fullName", u.role, u.all_locations AS "allLocations",
            u.token_version AS "tokenVersion", u.is_active AS "isActive",
            coalesce(array_agg(ul.location_id) FILTER (WHERE ul.location_id IS NOT NULL), '{}') AS "locationIds"
       FROM users u LEFT JOIN user_locations ul ON ul.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id`,
    [userId],
  );
}

export function requireUser(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) throw unauthorized();
    let claims;
    try {
      claims = await ctx.tokens.verify(token);
    } catch {
      throw unauthorized('Session expired or invalid. Please sign in again.');
    }
    const user = await loadAuthedUser(ctx, claims.sub);
    if (!user || !user.isActive || user.tokenVersion !== claims.ver) {
      throw unauthorized('Session is no longer valid. Please sign in again.');
    }
    req.user = {
      id: user.id,
      username: user.username,
      fullName: user.fullName,
      role: user.role,
      allLocations: user.allLocations,
      locationIds: user.locationIds,
    };
    next();
  };
}

/** Device key header: X-Device-Key: <deviceId>.<secret> */
export function requireDevice(ctx: AppContext): RequestHandler {
  return async (req, _res, next) => {
    const key = req.header('x-device-key') ?? '';
    const dot = key.indexOf('.');
    if (dot <= 0) throw unauthorized('Device key required');
    const deviceId = key.slice(0, dot);
    const secret = key.slice(dot + 1);
    if (!/^[0-9a-f-]{36}$/i.test(deviceId)) throw unauthorized('Invalid device key');
    const device = await one<{ id: string; locationId: string; deviceNo: number; keyHash: string; isActive: boolean; locActive: boolean }>(
      ctx.db,
      `SELECT d.id, d.location_id AS "locationId", d.device_no AS "deviceNo", d.key_hash AS "keyHash",
              d.is_active AS "isActive", l.is_active AS "locActive"
         FROM devices d JOIN locations l ON l.id = d.location_id WHERE d.id = $1`,
      [deviceId],
    );
    if (!device || !safeEqualHex(device.keyHash, hashDeviceSecret(secret))) throw unauthorized('Invalid device key');
    if (!device.isActive) throw forbidden('This device has been deactivated by the administrator');
    if (!device.locActive) throw forbidden('This location has been deactivated');
    req.device = { id: device.id, locationId: device.locationId, deviceNo: device.deviceNo };
    await ctx.db.query('UPDATE devices SET last_seen_at = now(), app_version = coalesce($2, app_version) WHERE id = $1', [
      device.id,
      req.header('x-app-version') ?? null,
    ]);
    next();
  };
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) throw unauthorized();
    if (!hasPermission(req.user, permission)) throw forbidden();
    next();
  };
}

export function assertPermission(req: Request, permission: Permission, locationId?: string | null): AuthedUser {
  const user = req.user;
  if (!user) throw unauthorized();
  if (!hasPermission(user, permission)) throw forbidden();
  if (locationId && !canAccessLocation(user, locationId)) {
    throw forbidden('You do not have access to this location');
  }
  return user;
}

/** Location ids a user may see for read queries (null = all). */
export function locationScope(user: AuthedUser): string[] | null {
  return user.allLocations ? null : user.locationIds;
}
