import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';
import type { DB } from './db/connection';
import { schemaVersion } from './db/connection';
import { AppError } from './errors';

export interface BackupInfo {
  file: string;
  name: string;
  sizeBytes: number;
  createdAt: string;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Verifies a SQLite file is intact and looks like a store database. Throws otherwise. */
export function verifyDatabaseFile(file: string): { schemaVersion: number; sales: number; pendingEvents: number; deviceId: string | null } {
  if (!existsSync(file)) throw new AppError('NOT_FOUND', 'Backup file not found');
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const check = db.pragma('integrity_check', { simple: true });
    if (check !== 'ok') throw new AppError('CORRUPT', `Backup failed integrity check: ${check}`);
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sales','outbox','stock_movements','meta')`).all();
    if (tables.length !== 4) throw new AppError('INVALID', 'File is not a Store Manager database');
    const sales = (db.prepare('SELECT count(*) AS n FROM sales').get() as { n: number }).n;
    const pendingEvents = (db.prepare(`SELECT count(*) AS n FROM outbox WHERE status = 'PENDING'`).get() as { n: number }).n;
    const device = db.prepare(`SELECT value FROM meta WHERE key = 'device'`).get() as { value: string } | undefined;
    const deviceId = device ? (JSON.parse(device.value).deviceId as string) : null;
    return { schemaVersion: db.pragma('user_version', { simple: true }) as number, sales, pendingEvents, deviceId };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('CORRUPT', `Backup cannot be opened: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
}

/** Online, consistent backup of the live database (SQLite backup API), verified after writing. */
export async function createBackup(db: DB, dir: string, label = 'auto'): Promise<BackupInfo> {
  mkdirSync(dir, { recursive: true });
  const name = `store-${stamp()}-${label}.db`;
  const tmp = join(dir, `${name}.partial`);
  const file = join(dir, name);
  await db.backup(tmp);
  verifyDatabaseFile(tmp);
  renameSync(tmp, file);
  const st = statSync(file);
  return { file, name, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
}

/** Synchronous variant used right before schema migrations. */
export function createBackupSync(db: DB, dir: string, label: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `store-${stamp()}-${label}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  return file;
}

export function listBackups(dir: string): BackupInfo[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^store-.*\.db$/.test(f))
    .map((f) => {
      const st = statSync(join(dir, f));
      return { file: join(dir, f), name: f, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep the newest `keep` automatic backups; manual/pre-* backups are never pruned. */
export function pruneBackups(dir: string, keep: number): number {
  const autos = listBackups(dir).filter((b) => b.name.endsWith('-auto.db'));
  let removed = 0;
  for (const b of autos.slice(keep)) {
    rmSync(b.file, { force: true });
    removed++;
  }
  return removed;
}

/**
 * Replace the database file with a verified backup. The caller must have closed
 * the live connection. The current file is preserved as a pre-restore backup.
 */
export function restoreBackup(dbFile: string, backupFile: string, backupDir: string): { preRestoreFile: string } {
  const info = verifyDatabaseFile(backupFile);
  if (info.schemaVersion < 1) throw new AppError('INVALID', 'Backup has no schema');
  mkdirSync(backupDir, { recursive: true });
  const preRestoreFile = join(backupDir, `store-${stamp()}-pre-restore.db`);
  if (existsSync(dbFile)) {
    // Checkpoint-free copy: the live connection is closed, so WAL content is already merged.
    copyFileSync(dbFile, preRestoreFile);
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  const tmp = `${dbFile}.restoring`;
  copyFileSync(backupFile, tmp);
  renameSync(tmp, dbFile);
  verifyDatabaseFile(dbFile);
  return { preRestoreFile };
}

export function backupName(file: string): string {
  return basename(file);
}

export { schemaVersion };
