import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import {
  canAccessLocation,
  permissionsFor,
  type DeviceRegistration,
  type LocationRow,
  type LoginResponse,
} from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso } from '../db/connection';
import type { CoreContext, DeviceInfo, Session } from '../context';
import { AppError } from '../errors';
import { ApiClient, HttpError, NetworkError, normaliseServerUrl, toAppError, type FetchLike } from '../sync/api-client';
import { getUserByUsername, mapUser } from './catalog';
import { deleteMeta, getMeta, setMeta } from './meta';
import { auditLocal } from './audit';

const DEVICE_KEY_SECRET = 'device-key';

// ---------------------------------------------------------------------------
// Offline credential verifier (salted scrypt), written after an online login.
// ---------------------------------------------------------------------------

function makeVerifier(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkVerifier(password: string, verifier: string): boolean {
  const [alg, saltB64, hashB64] = verifier.split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Device registration
// ---------------------------------------------------------------------------

export function loadDevice(db: DB): DeviceInfo | null {
  const raw = getMeta(db, 'device');
  return raw ? (JSON.parse(raw) as DeviceInfo) : null;
}

/** Step 1 of setup: sign in as an administrator against the central server. */
export async function setupConnect(serverUrl: string, username: string, password: string, fetchImpl?: FetchLike) {
  const baseUrl = normaliseServerUrl(serverUrl);
  const api = new ApiClient({ baseUrl, fetchImpl });
  try {
    await api.get('/api/health', { timeoutMs: 10_000 });
    const login = await api.post<LoginResponse>('/api/auth/login', { username, password });
    if (!login.user.permissions.includes('locations.manage')) {
      throw new AppError('FORBIDDEN', 'Only a company administrator can register this computer');
    }
    const locations = await api.get<LocationRow[]>('/api/locations', { token: login.accessToken });
    return { serverUrl: baseUrl, token: login.accessToken, locations: locations.filter((l) => l.isActive) };
  } catch (err) {
    throw toAppError(err);
  }
}

/** Step 2: register this PC to one warehouse/branch and store the device key securely. */
export async function setupRegister(
  ctx: CoreContext,
  args: { serverUrl: string; token: string; locationId: string; deviceName: string },
  fetchImpl?: FetchLike,
): Promise<DeviceInfo> {
  if (ctx.device) throw new AppError('CONFLICT', 'This computer is already registered');
  const api = new ApiClient({ baseUrl: normaliseServerUrl(args.serverUrl), fetchImpl });
  let reg: DeviceRegistration;
  try {
    reg = await api.post<DeviceRegistration>('/api/devices/register', { locationId: args.locationId, name: args.deviceName }, { token: args.token });
  } catch (err) {
    throw toAppError(err);
  }
  const device: DeviceInfo = { deviceId: reg.deviceId, deviceNo: reg.deviceNo, locationId: reg.location.id, serverUrl: api.baseUrl };
  ctx.secrets.set(DEVICE_KEY_SECRET, reg.deviceKey);
  setMeta(ctx.db, 'device', JSON.stringify(device));
  setMeta(ctx.db, 'pull_cursor', '0');
  auditLocal(ctx.db, null, 'device.registered', 'device', reg.deviceId, { location: reg.location.name, deviceNo: reg.deviceNo });
  return device;
}

export function getDeviceKey(ctx: Pick<CoreContext, 'secrets'>): string | null {
  return ctx.secrets.get(DEVICE_KEY_SECRET);
}

/** Forget the registration (e.g. PC re-assigned). Requires an empty outbox unless forced. */
export function unregisterDevice(ctx: CoreContext, force = false): void {
  const pending = (ctx.db.prepare(`SELECT count(*) AS n FROM outbox WHERE status <> 'SYNCED'`).get() as { n: number }).n;
  if (pending > 0 && !force) throw new AppError('CONFLICT', `${pending} transaction(s) have not been synchronised yet`);
  ctx.secrets.delete(DEVICE_KEY_SECRET);
  deleteMeta(ctx.db, 'device');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

const failedOffline = new Map<string, { count: number; until: number }>();

function assertUserAllowedHere(user: { allLocations: boolean; locationIds: string[]; isActive: boolean; role: any }, device: DeviceInfo) {
  if (!user.isActive) throw new AppError('UNAUTHORIZED', 'This account is deactivated');
  if (!canAccessLocation(user, device.locationId)) {
    throw new AppError('FORBIDDEN', 'Your account is not assigned to the location of this computer');
  }
}

/**
 * Online-first login. If the server is reachable its answer is final (and a
 * rejected password removes any cached offline verifier). If it is unreachable,
 * fall back to the offline verifier cached from a previous online login.
 */
export async function login(ctx: CoreContext, usernameRaw: string, password: string): Promise<Session> {
  const device = ctx.device;
  if (!device) throw new AppError('NOT_REGISTERED', 'Register this computer first');
  const username = usernameRaw.trim().toLowerCase();
  if (!username || !password) throw new AppError('VALIDATION', 'Enter username and password');
  const db = ctx.db;

  if (ctx.api) {
    try {
      const res = await ctx.api.post<LoginResponse>('/api/auth/login', { username, password }, { timeoutMs: 8_000 });
      assertUserAllowedHere(res.user, device);
      // Refresh cached user row and offline verifier.
      db.prepare(
        `INSERT INTO users (id, username, full_name, role, all_locations, location_ids, is_active) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET username=excluded.username, full_name=excluded.full_name, role=excluded.role,
           all_locations=excluded.all_locations, location_ids=excluded.location_ids, is_active=excluded.is_active`,
      ).run(res.user.id, res.user.username, res.user.fullName, res.user.role, res.user.allLocations ? 1 : 0, JSON.stringify(res.user.locationIds), 1);
      db.prepare(
        `INSERT INTO user_credentials (user_id, verifier, updated_at) VALUES (?,?,?)
         ON CONFLICT(user_id) DO UPDATE SET verifier=excluded.verifier, updated_at=excluded.updated_at`,
      ).run(res.user.id, makeVerifier(password), nowIso());
      auditLocal(db, res.user.id, 'auth.login', 'user', res.user.id, { mode: 'online' });
      return {
        user: { ...res.user, permissions: res.user.permissions as any },
        accessToken: res.accessToken,
        expiresAt: res.expiresAt,
        mode: 'online',
        startedAt: nowIso(),
      };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) {
        const u = getUserByUsername(db, username);
        if (u) db.prepare('DELETE FROM user_credentials WHERE user_id = ?').run(u.id);
        throw new AppError('UNAUTHORIZED', err.message);
      }
      if (err instanceof AppError) throw err;
      if (!(err instanceof NetworkError) && !(err instanceof HttpError && err.status >= 500)) throw toAppError(err);
      // fall through to offline login
    }
  }
  return loginOffline(ctx, username, password);
}

export function loginOffline(ctx: CoreContext, username: string, password: string): Session {
  const device = ctx.device!;
  const db = ctx.db;
  const lock = failedOffline.get(username);
  if (lock && lock.until > Date.now()) throw new AppError('UNAUTHORIZED', 'Too many failed attempts. Wait a few minutes and try again.');
  const row = db.prepare('SELECT u.*, c.verifier FROM users u JOIN user_credentials c ON c.user_id = u.id WHERE u.username = ?').get(username) as any;
  if (!row) {
    throw new AppError('UNAUTHORIZED', 'Cannot reach the central server, and this user has not signed in on this computer before. An online sign-in is needed once.');
  }
  if (!checkVerifier(password, row.verifier)) {
    const count = (lock?.count ?? 0) + 1;
    failedOffline.set(username, { count: count >= 5 ? 0 : count, until: count >= 5 ? Date.now() + 5 * 60_000 : 0 });
    throw new AppError('UNAUTHORIZED', 'Invalid username or password');
  }
  failedOffline.delete(username);
  const user = mapUser(row);
  assertUserAllowedHere(user, device);
  auditLocal(db, user.id, 'auth.login', 'user', user.id, { mode: 'offline' });
  return { user: { ...user, permissions: permissionsFor(user.role) }, accessToken: null, expiresAt: null, mode: 'offline', startedAt: nowIso() };
}

/** Change the signed-in user's password on the central server and refresh the offline verifier. */
export async function changePassword(ctx: CoreContext, currentPassword: string, newPassword: string) {
  const session = ctx.session;
  if (!session?.accessToken || !ctx.api) throw new AppError('OFFLINE', 'Changing the password requires an online sign-in');
  try {
    const res = await ctx.api.post<{ accessToken: string; expiresAt: string }>(
      '/api/auth/change-password',
      { currentPassword, newPassword },
      { token: session.accessToken },
    );
    ctx.db.prepare('UPDATE user_credentials SET verifier = ?, updated_at = ? WHERE user_id = ?').run(makeVerifier(newPassword), nowIso(), session.user.id);
    session.accessToken = res.accessToken;
    session.expiresAt = res.expiresAt;
    auditLocal(ctx.db, session.user.id, 'auth.password_changed', 'user', session.user.id);
  } catch (err) {
    throw toAppError(err);
  }
}
