import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations';

export type DB = Database.Database;

export interface OpenOptions {
  /** Called with the open database before pending migrations run (e.g. to take a backup). */
  beforeMigrate?: (db: DB, fromVersion: number, toVersion: number) => void;
}

export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  const db = new Database(file);
  // WAL for concurrent readers; FULL sync so a committed sale survives power loss.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, opts);
  return db;
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

export function migrate(db: DB, opts: OpenOptions = {}): void {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return;
  if (current > 0) opts.beforeMigrate?.(db, current, pending[pending.length - 1].version);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
}

/** Run fn in an IMMEDIATE transaction (takes the write lock up front). */
export function tx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn).immediate();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export const bool = (v: unknown): boolean => v === 1 || v === true;
