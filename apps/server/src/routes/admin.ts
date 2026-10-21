import { Router } from 'express';
import { z } from 'zod';
import {
  companySettingsSchema,
  deviceRegisterSchema,
  locationInputSchema,
  userCreateSchema,
  userUpdateSchema,
  uuidv7,
  type DeviceRegistration,
} from '@store/shared';
import type { AppContext } from '../context.js';
import { many, one, withTransaction } from '../db/pool.js';
import { hashDeviceSecret, hashPassword, newDeviceSecret } from '../auth/password.js';
import { requirePermission, requireUser } from '../middleware/auth.js';
import { badRequest, conflict, notFound } from '../middleware/errors.js';
import { audit } from '../services/audit.js';
import { LOCATION_COLS, USER_COLS, getLocation, getSettings, getUser } from '../services/rows.js';
import { parse, uuidParam } from './util.js';

export function adminRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use(requireUser(ctx));

  // ---------------- Company settings ----------------
  r.get('/settings', async (_req, res) => {
    res.json(await getSettings(ctx.db));
  });

  r.put('/settings', requirePermission('settings.manage'), async (req, res) => {
    const s = parse(companySettingsSchema, req.body);
    await ctx.db.query(
      `UPDATE company SET name=$1, gstin=$2, state_code=$3, address=$4, phone=$5, branch_to_branch_enabled=$6,
              branch_to_warehouse_enabled=$7, allow_negative_stock=$8, round_to_rupee=$9, receipt_footer=$10,
              default_low_stock_level=$11, updated_at=now()`,
      [s.name, s.gstin, s.stateCode, s.address, s.phone, s.branchToBranchEnabled, s.branchToWarehouseEnabled,
       s.allowNegativeStock, s.roundToRupee, s.receiptFooter, s.defaultLowStockLevel],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'settings.update', entityType: 'company', details: s, ip: req.ip });
    res.json(await getSettings(ctx.db));
  });

  // ---------------- Locations (warehouses & branches) ----------------
  r.get('/locations', async (_req, res) => {
    res.json(await many(ctx.db, `SELECT ${LOCATION_COLS} FROM locations l ORDER BY l.type DESC, l.name`));
  });

  r.post('/locations', requirePermission('locations.manage'), async (req, res) => {
    const l = parse(locationInputSchema, req.body);
    const id = uuidv7();
    await ctx.db.query(
      `INSERT INTO locations (id, code, name, type, address, state_code, gstin, phone, invoice_prefix, can_receive_purchases, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, l.code, l.name, l.type, l.address, l.stateCode, l.gstin, l.phone, l.invoicePrefix, l.canReceivePurchases, l.isActive],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'location.create', entityType: 'location', entityId: id, details: l, ip: req.ip });
    res.status(201).json(await getLocation(ctx.db, id));
  });

  r.put('/locations/:id', requirePermission('locations.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const l = parse(locationInputSchema, req.body);
    const existing = await getLocation(ctx.db, id);
    if (!existing) throw notFound('Location');
    if (existing.type !== l.type) {
      const used = await one(ctx.db, 'SELECT 1 FROM stock_movements WHERE location_id = $1 LIMIT 1', [id]);
      if (used) throw conflict('Location type cannot be changed after stock has been recorded');
    }
    await ctx.db.query(
      `UPDATE locations SET code=$2, name=$3, type=$4, address=$5, state_code=$6, gstin=$7, phone=$8, invoice_prefix=$9,
              can_receive_purchases=$10, is_active=$11, updated_at=now() WHERE id=$1`,
      [id, l.code, l.name, l.type, l.address, l.stateCode, l.gstin, l.phone, l.invoicePrefix, l.canReceivePurchases, l.isActive],
    );
    await audit(ctx.db, { userId: req.user!.id, action: 'location.update', entityType: 'location', entityId: id, details: l, ip: req.ip });
    res.json(await getLocation(ctx.db, id));
  });

  // ---------------- Users ----------------
  r.get('/users', requirePermission('users.manage'), async (_req, res) => {
    res.json(
      await many(
        ctx.db,
        `SELECT ${USER_COLS}, u.last_login_at AS "lastLoginAt", u.locked_until AS "lockedUntil" FROM users u ORDER BY u.full_name`,
      ),
    );
  });

  const validateUserLocations = async (role: string, allLocations: boolean, locationIds: string[]) => {
    if (role === 'COMPANY_ADMIN' && !allLocations) throw badRequest('Company admins must have access to all locations');
    if (!allLocations && locationIds.length === 0) throw badRequest('Assign at least one location');
    if (locationIds.length) {
      const n = await one<{ n: number }>(ctx.db, 'SELECT count(*)::int AS n FROM locations WHERE id = ANY($1::uuid[])', [locationIds]);
      if (n!.n !== new Set(locationIds).size) throw badRequest('Unknown location in assignment');
    }
  };

  r.post('/users', requirePermission('users.manage'), async (req, res) => {
    const u = parse(userCreateSchema, req.body);
    await validateUserLocations(u.role, u.allLocations, u.locationIds);
    const id = uuidv7();
    const hash = await hashPassword(u.password);
    await withTransaction(ctx.db, async (tx) => {
      await tx.query(
        `INSERT INTO users (id, username, full_name, password_hash, role, all_locations, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, u.username, u.fullName, hash, u.role, u.allLocations, u.isActive],
      );
      for (const loc of new Set(u.locationIds)) {
        await tx.query('INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2)', [id, loc]);
      }
      const { password: _pw, ...details } = u;
      await audit(tx, { userId: req.user!.id, action: 'user.create', entityType: 'user', entityId: id, details, ip: req.ip });
    });
    res.status(201).json(await getUser(ctx.db, id));
  });

  r.put('/users/:id', requirePermission('users.manage'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const u = parse(userUpdateSchema, req.body);
    if (!(await getUser(ctx.db, id))) throw notFound('User');
    if (id === req.user!.id && (!u.isActive || u.role !== 'COMPANY_ADMIN')) {
      throw badRequest('You cannot deactivate or demote your own account');
    }
    await validateUserLocations(u.role, u.allLocations, u.locationIds);
    const hash = u.password ? await hashPassword(u.password) : null;
    await withTransaction(ctx.db, async (tx) => {
      await tx.query(
        `UPDATE users SET full_name=$2, role=$3, all_locations=$4, is_active=$5,
                password_hash = coalesce($6, password_hash),
                token_version = token_version + 1, updated_at = now()
          WHERE id=$1`,
        [id, u.fullName, u.role, u.allLocations, u.isActive, hash],
      );
      await tx.query('DELETE FROM user_locations WHERE user_id = $1', [id]);
      for (const loc of new Set(u.locationIds)) {
        await tx.query('INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2)', [id, loc]);
      }
      const { password: _pw, ...details } = u;
      await audit(tx, {
        userId: req.user!.id,
        action: 'user.update',
        entityType: 'user',
        entityId: id,
        details: { ...details, passwordReset: Boolean(hash) },
        ip: req.ip,
      });
    });
    res.json(await getUser(ctx.db, id));
  });

  // ---------------- Devices ----------------
  r.get('/devices', requirePermission('sync.admin'), async (_req, res) => {
    res.json(
      await many(
        ctx.db,
        `SELECT d.id, d.name, d.device_no AS "deviceNo", d.location_id AS "locationId", l.name AS "locationName",
                d.is_active AS "isActive", d.created_at AS "createdAt", d.last_seen_at AS "lastSeenAt",
                d.last_push_at AS "lastPushAt", d.last_pull_at AS "lastPullAt", d.pending_reported AS "pendingReported",
                d.app_version AS "appVersion",
                (SELECT count(*)::int FROM sync_inbox i WHERE i.device_id = d.id AND i.status = 'REJECTED') AS "rejectedEvents"
           FROM devices d JOIN locations l ON l.id = d.location_id
          ORDER BY l.name, d.device_no`,
      ),
    );
  });

  /** Registers a desktop installation for one location and returns its secret key (shown once). */
  r.post('/devices/register', requirePermission('locations.manage'), async (req, res) => {
    const body = parse(deviceRegisterSchema, req.body);
    const location = await getLocation(ctx.db, body.locationId);
    if (!location) throw notFound('Location');
    if (!location.isActive) throw badRequest('Location is inactive');
    const secret = newDeviceSecret();
    const id = uuidv7();
    const deviceNo = await withTransaction(ctx.db, async (tx) => {
      await tx.query('SELECT 1 FROM locations WHERE id = $1 FOR UPDATE', [body.locationId]);
      const next = await one<{ n: number }>(tx, 'SELECT coalesce(max(device_no), 0) + 1 AS n FROM devices WHERE location_id = $1', [body.locationId]);
      await tx.query(
        `INSERT INTO devices (id, location_id, device_no, name, key_hash, registered_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, body.locationId, next!.n, body.name, hashDeviceSecret(secret), req.user!.id],
      );
      await audit(tx, { userId: req.user!.id, locationId: body.locationId, deviceId: id, action: 'device.register', entityType: 'device', entityId: id, details: { name: body.name }, ip: req.ip });
      return next!.n;
    });
    const out: DeviceRegistration = { deviceId: id, deviceNo, deviceKey: `${id}.${secret}`, location };
    res.status(201).json(out);
  });

  r.put('/devices/:id', requirePermission('sync.admin'), async (req, res) => {
    const { id } = parse(uuidParam, req.params);
    const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
    const upd = await ctx.db.query('UPDATE devices SET is_active = $2 WHERE id = $1', [id, isActive]);
    if (upd.rowCount === 0) throw notFound('Device');
    await audit(ctx.db, { userId: req.user!.id, deviceId: id, action: isActive ? 'device.activate' : 'device.deactivate', entityType: 'device', entityId: id, ip: req.ip });
    res.json({ ok: true });
  });

  // ---------------- Audit log ----------------
  r.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
    const q = parse(
      z.object({
        action: z.string().max(60).optional(),
        userId: z.uuid().optional(),
        locationId: z.uuid().optional(),
        entityId: z.string().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        before: z.coerce.number().int().optional(),
      }),
      req.query,
    );
    const params: unknown[] = [];
    let where = 'WHERE true';
    if (q.action) {
      params.push(`${q.action}%`);
      where += ` AND a.action LIKE $${params.length}`;
    }
    if (q.userId) {
      params.push(q.userId);
      where += ` AND a.user_id = $${params.length}`;
    }
    if (q.locationId) {
      params.push(q.locationId);
      where += ` AND a.location_id = $${params.length}`;
    }
    if (q.entityId) {
      params.push(q.entityId);
      where += ` AND a.entity_id = $${params.length}`;
    }
    if (q.before) {
      params.push(q.before);
      where += ` AND a.id < $${params.length}`;
    }
    params.push(q.limit);
    res.json(
      await many(
        ctx.db,
        `SELECT a.id, a.occurred_at AS "occurredAt", a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
                a.details, a.ip, a.user_id AS "userId", u.full_name AS "userName", a.location_id AS "locationId",
                l.name AS "locationName", a.device_id AS "deviceId"
           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN locations l ON l.id = a.location_id
           ${where} ORDER BY a.id DESC LIMIT $${params.length}`,
        params,
      ),
    );
  });

  return r;
}
