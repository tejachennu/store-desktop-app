import type { DB } from '../db/connection';
import { nowIso } from '../db/connection';

export function auditLocal(db: DB, userId: string | null, action: string, entityType?: string, entityId?: string, details?: unknown): void {
  db.prepare('INSERT INTO audit_log (at, user_id, action, entity_type, entity_id, details) VALUES (?,?,?,?,?,?)').run(
    nowIso(),
    userId,
    action,
    entityType ?? null,
    entityId ?? null,
    details === undefined ? null : JSON.stringify(details),
  );
}

export function syncLog(db: DB, level: 'info' | 'warn' | 'error', kind: string, message: string, details?: unknown): void {
  db.prepare('INSERT INTO sync_log (at, level, kind, message, details) VALUES (?,?,?,?,?)').run(
    nowIso(),
    level,
    kind,
    message,
    details === undefined ? null : JSON.stringify(details),
  );
  // Keep the log bounded.
  db.prepare('DELETE FROM sync_log WHERE id <= (SELECT max(id) - 5000 FROM sync_log)').run();
}
