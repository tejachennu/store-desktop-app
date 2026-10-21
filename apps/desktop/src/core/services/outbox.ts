import { uuidv7, type SyncEvent, type SyncEventType } from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso } from '../db/connection';

/**
 * Queue an event for the server. MUST be called inside the same transaction as the
 * business writes it describes, so the two commit or roll back together.
 */
export function enqueue<T extends SyncEventType>(
  db: DB,
  args: { type: T; locationId: string; userId: string; payload: Extract<SyncEvent, { type: T }>['payload']; docRefs?: string[] },
): string {
  const now = nowIso();
  const id = uuidv7();
  const envelope = { id, type: args.type, locationId: args.locationId, userId: args.userId, occurredAt: now, payload: args.payload };
  db.prepare(
    `INSERT INTO outbox (id, type, doc_refs, envelope, status, attempts, next_attempt_at, created_at)
     VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
  ).run(id, args.type, JSON.stringify(args.docRefs ?? []), JSON.stringify(envelope), now, now);
  return id;
}

/** True while unsent local events still reference a document (so pulls must not overwrite it). */
export function hasPendingFor(db: DB, docId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM outbox o, json_each(o.doc_refs) j WHERE o.status = 'PENDING' AND j.value = ? LIMIT 1`,
    )
    .get(docId);
}

export function outboxCounts(db: DB): { pending: number; failed: number; synced: number } {
  const rows = db.prepare('SELECT status, count(*) AS n FROM outbox GROUP BY status').all() as { status: string; n: number }[];
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { pending: get('PENDING'), failed: get('FAILED'), synced: get('SYNCED') };
}
