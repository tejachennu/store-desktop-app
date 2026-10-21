import type { PullResponse, SyncPushResponse, SyncPushResult } from '@store/shared';
import type { DB } from '../db/connection';
import { nowIso, tx } from '../db/connection';
import { getMeta, setMeta } from '../services/meta';
import { outboxCounts } from '../services/outbox';
import { syncLog } from '../services/audit';
import { ApiClient, HttpError, NetworkError } from './api-client';
import { applyDocRefresh, applyPull } from './apply-pull';

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'offline' | 'error' | 'unregistered';
  online: boolean;
  pending: number;
  failed: number;
  lastSyncAt: string | null;
  lastPullAt: string | null;
  lastError: string | null;
  nextRetryAt: string | null;
}

export interface SyncEngineOptions {
  db: DB;
  getApi: () => ApiClient | null;
  getDeviceKey: () => string | null;
  /** Called whenever status changes (UI indicator). */
  onStatus?: (s: SyncStatus) => void;
  /** Called after a pull applied changes (UI refresh). */
  onPulled?: () => void;
  batchSize?: number;
  intervalMs?: number;
  /** Retryable server rejections give up after this many attempts and become FAILED. */
  maxAttempts?: number;
  now?: () => number;
  random?: () => number;
}

/** Exponential backoff with jitter: 2s, 4s, 8s … capped at 15 minutes. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(2000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
  return Math.round(base * (0.75 + random() * 0.5));
}

/**
 * Background synchronisation: push the outbox (in order, idempotently), then pull
 * incremental changes. Safe to call `syncNow` concurrently; runs are serialised.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private debounce: NodeJS.Timeout | null = null;
  private failures = 0;
  private blockedUntil = 0;
  private status: SyncStatus;
  // Background timers only run between start() and stop(); syncNow() always works.
  private stopped = true;

  constructor(private o: SyncEngineOptions) {
    const c = outboxCounts(o.db);
    this.status = {
      state: 'idle',
      online: false,
      pending: c.pending,
      failed: c.failed,
      lastSyncAt: getMeta(o.db, 'last_sync_at'),
      lastPullAt: getMeta(o.db, 'last_pull_at'),
      lastError: null,
      nextRetryAt: null,
    };
  }

  private now() {
    return this.o.now?.() ?? Date.now();
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  private update(patch: Partial<SyncStatus>) {
    const c = outboxCounts(this.o.db);
    this.status = { ...this.status, pending: c.pending, failed: c.failed, ...patch };
    this.o.onStatus?.(this.getStatus());
  }

  start(): void {
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.syncNow().finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, this.o.intervalMs ?? 30_000);
      });
    };
    tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
  }

  /** Schedule a sync shortly after local writes (coalesces bursts of POS activity). */
  nudge(delayMs = 1500): void {
    this.update({});
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), delayMs);
  }

  /** Run one push+pull cycle (or join the one in progress). */
  syncNow(opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    if (!opts.force && this.now() < this.blockedUntil) return Promise.resolve();
    this.running = this.cycle().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async cycle(): Promise<void> {
    const api = this.o.getApi();
    const key = this.o.getDeviceKey();
    if (!api || !key) {
      this.update({ state: 'unregistered', online: false });
      return;
    }
    this.update({ state: 'syncing' });
    try {
      await this.pushAll(api, key);
      await this.pullAll(api, key);
      this.failures = 0;
      this.blockedUntil = 0;
      const at = nowIso();
      setMeta(this.o.db, 'last_sync_at', at);
      this.update({ state: 'idle', online: true, lastSyncAt: at, lastPullAt: getMeta(this.o.db, 'last_pull_at'), lastError: null, nextRetryAt: null });
    } catch (err) {
      this.failures += 1;
      const wait = backoffMs(this.failures, this.o.random);
      this.blockedUntil = this.now() + wait;
      const offline = err instanceof NetworkError || (err instanceof HttpError && err.status >= 500);
      const message = err instanceof Error ? err.message : String(err);
      syncLog(this.o.db, offline ? 'warn' : 'error', 'cycle', message);
      this.update({
        state: offline ? 'offline' : 'error',
        online: !offline && !(err instanceof NetworkError),
        lastError: offline ? 'Central server unreachable — working offline' : message,
        nextRetryAt: new Date(this.now() + wait).toISOString(),
      });
    }
  }

  /** Push pending events in creation order. Transport errors abort the run (retried with backoff). */
  async pushAll(api: ApiClient, key: string): Promise<void> {
    const db = this.o.db;
    const batchSize = this.o.batchSize ?? 50;
    for (;;) {
      const rows = db
        .prepare(`SELECT seq, id, envelope, attempts, doc_refs FROM outbox WHERE status = 'PENDING' AND next_attempt_at <= ? ORDER BY seq LIMIT ?`)
        .all(new Date(this.now()).toISOString(), batchSize) as { seq: number; id: string; envelope: string; attempts: number; doc_refs: string }[];
      if (rows.length === 0) return;
      const pendingTotal = outboxCounts(db).pending;
      const res = await api.post<SyncPushResponse>(
        '/api/sync/push',
        { events: rows.map((r) => JSON.parse(r.envelope)) },
        { deviceKey: key, headers: { 'X-Pending-Count': String(pendingTotal) }, timeoutMs: 60_000 },
      );
      const byId = new Map<string, SyncPushResult>(res.results.map((r) => [r.id, r]));
      let deferred = 0;
      const rejectedDocs = new Set<string>();
      tx(db, () => {
        for (const row of rows) {
          const r = byId.get(row.id);
          if (!r) continue; // not processed; stays pending
          if (r.status === 'ACCEPTED' || r.status === 'DUPLICATE') {
            db.prepare(`UPDATE outbox SET status = 'SYNCED', synced_at = ?, last_error = NULL, attempts = attempts + 1 WHERE id = ?`).run(nowIso(), row.id);
          } else if (r.retryable && row.attempts + 1 < (this.o.maxAttempts ?? 20)) {
            deferred++;
            const next = new Date(this.now() + backoffMs(row.attempts + 1, this.o.random)).toISOString();
            db.prepare(`UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?`).run(r.error ?? 'Deferred', next, row.id);
          } else {
            db.prepare(`UPDATE outbox SET status = 'FAILED', attempts = attempts + 1, last_error = ? WHERE id = ?`).run(r.error ?? 'Rejected', row.id);
            for (const d of JSON.parse(row.doc_refs) as string[]) rejectedDocs.add(d);
            syncLog(db, 'error', 'push', `Event ${row.id} rejected: ${r.error}`, { eventId: row.id });
          }
        }
      });
      if (rejectedDocs.size) {
        // The server refused local changes to these documents: resynchronise them to the server's state.
        const docs = await api.post<Pick<PullResponse, 'transfers' | 'purchaseOrders'>>('/api/sync/refresh', { ids: [...rejectedDocs].slice(0, 200) }, { deviceKey: key });
        applyDocRefresh(db, docs);
      }
      this.update({});
      if (rows.length < batchSize || deferred === rows.length) return;
    }
  }

  async pullAll(api: ApiClient, key: string): Promise<void> {
    let changed = false;
    for (let page = 0; page < 1000; page++) {
      const cursor = getMeta(this.o.db, 'pull_cursor') ?? '0';
      const includeOwn = getMeta(this.o.db, 'pull_include_own') === '1' ? '&includeOwn=1' : '';
      const res = await api.get<PullResponse>(`/api/sync/pull?cursor=${encodeURIComponent(cursor)}${includeOwn}`, { deviceKey: key, timeoutMs: 120_000 });
      const counts =
        res.products.length + res.users.length + res.locations.length + res.transfers.length + res.movements.length + res.purchaseOrders.length + res.customers.length + res.suppliers.length + res.categories.length;
      if (counts > 0 || res.settings) changed = true;
      applyPull(this.o.db, res);
      if (!res.hasMore) break;
    }
    if (getMeta(this.o.db, 'pull_include_own') === '1') setMeta(this.o.db, 'pull_include_own', '0');
    if (changed) this.o.onPulled?.();
  }

  // ------------------------------------------------------------------ admin tools

  retryFailed(ids?: string[]): number {
    const db = this.o.db;
    const now = nowIso();
    const r = ids?.length
      ? db.prepare(`UPDATE outbox SET status = 'PENDING', attempts = 0, next_attempt_at = ? WHERE status = 'FAILED' AND id IN (SELECT value FROM json_each(?))`).run(now, JSON.stringify(ids))
      : db.prepare(`UPDATE outbox SET status = 'PENDING', attempts = 0, next_attempt_at = ? WHERE status = 'FAILED'`).run(now);
    syncLog(db, 'info', 'admin', `Re-queued ${r.changes} failed event(s)`);
    this.blockedUntil = 0;
    this.nudge(100);
    return r.changes;
  }
}
