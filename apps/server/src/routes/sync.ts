import { Router } from 'express';
import { z } from 'zod';
import { syncPushRequestSchema, type SyncPushResponse } from '@store/shared';
import type { AppContext } from '../context.js';
import { many } from '../db/pool.js';
import { requireDevice, requirePermission, requireUser } from '../middleware/auth.js';
import { processPush } from '../services/sync-processor.js';
import { pull, refreshDocs } from '../services/pull.js';
import { parse } from './util.js';

export function syncRoutes(ctx: AppContext): Router {
  const r = Router();

  // ---------------- Device endpoints (X-Device-Key) ----------------
  r.post('/push', requireDevice(ctx), async (req, res) => {
    const body = parse(syncPushRequestSchema, req.body);
    const pending = Number(req.header('x-pending-count') ?? '');
    if (Number.isInteger(pending) && pending >= 0) {
      await ctx.db.query('UPDATE devices SET pending_reported = $2 WHERE id = $1', [req.device!.id, pending]);
    }
    const results = await processPush(ctx, req.device!, body.events);
    const out: SyncPushResponse = { results };
    res.json(out);
  });

  r.get('/pull', requireDevice(ctx), async (req, res) => {
    const { cursor, includeOwn } = parse(z.object({ cursor: z.string().regex(/^\d+$/).optional(), includeOwn: z.enum(['0', '1']).optional() }), req.query);
    res.json(await pull(ctx, req.device!, cursor, { includeOwnMovements: includeOwn === '1' }));
  });

  r.post('/refresh', requireDevice(ctx), async (req, res) => {
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(200) }), req.body);
    res.json(await refreshDocs(ctx, req.device!, ids));
  });

  r.get('/ping', requireDevice(ctx), async (req, res) => {
    res.json({ ok: true, serverTime: new Date().toISOString(), deviceId: req.device!.id, locationId: req.device!.locationId });
  });

  // ---------------- Admin sync console ----------------
  r.get('/inbox', requireUser(ctx), requirePermission('sync.admin'), async (req, res) => {
    const q = parse(
      z.object({ status: z.enum(['REJECTED', 'ACCEPTED', 'PROCESSING']).default('REJECTED'), deviceId: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
      req.query,
    );
    const params: unknown[] = [q.status];
    let where = 'WHERE i.status = $1';
    if (q.deviceId) {
      params.push(q.deviceId);
      where += ` AND i.device_id = $${params.length}`;
    }
    params.push(q.limit);
    res.json(
      await many(
        ctx.db,
        `SELECT i.id, i.event_type AS "eventType", i.status, i.error, i.attempts, i.received_at AS "receivedAt",
                i.processed_at AS "processedAt", i.occurred_at AS "occurredAt", i.device_id AS "deviceId", d.name AS "deviceName",
                l.name AS "locationName", u.full_name AS "userName", i.payload
           FROM sync_inbox i JOIN devices d ON d.id = i.device_id JOIN locations l ON l.id = d.location_id
           LEFT JOIN users u ON u.id = i.user_id
           ${where} ORDER BY i.received_at DESC LIMIT $${params.length}`,
        params,
      ),
    );
  });

  return r;
}
