import type { Queryable } from '../db/pool.js';

export interface AuditEntry {
  userId?: string | null;
  locationId?: string | null;
  deviceId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
  occurredAt?: string;
}

export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query(
    `INSERT INTO audit_logs (occurred_at, user_id, location_id, device_id, action, entity_type, entity_id, details, ip)
     VALUES (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      e.occurredAt ?? null,
      e.userId ?? null,
      e.locationId ?? null,
      e.deviceId ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      JSON.stringify(e.details ?? {}),
      e.ip ?? null,
    ],
  );
}
