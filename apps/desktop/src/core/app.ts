import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { DB } from './db/connection';
import { openDatabase } from './db/connection';
import type { CoreContext, DeviceInfo, SecretStore, Session } from './context';
import { ApiClient, type FetchLike } from './sync/api-client';
import { SyncEngine, type SyncStatus } from './sync/sync-engine';
import { getDeviceKey, loadDevice, login as doLogin, setupRegister } from './services/auth';
import { getMeta, getPrefs, setMeta } from './services/meta';
import { auditLocal, syncLog } from './services/audit';
import { createBackup, createBackupSync, listBackups, pruneBackups, restoreBackup, verifyDatabaseFile } from './backup';
import { AppError } from './errors';

export interface StoreCoreOptions {
  dataDir: string;
  secrets: SecretStore;
  fetchImpl?: FetchLike;
  appVersion?: string;
  /** Disable background timers (tests drive sync explicitly). */
  manualSync?: boolean;
  onSyncStatus?: (s: SyncStatus) => void;
  onDataChanged?: () => void;
}

/**
 * The desktop application's domain runtime: owns the SQLite connection, the
 * device registration, the signed-in session and the sync engine. Electron's
 * main process creates exactly one instance; tests create as many as they like.
 */
export class StoreCore {
  readonly dbFile: string;
  readonly backupDir: string;
  ctx: CoreContext;
  sync: SyncEngine;
  private backupTimer: NodeJS.Timeout | null = null;

  constructor(private opts: StoreCoreOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.dbFile = join(opts.dataDir, 'store.db');
    this.backupDir = join(opts.dataDir, 'backups');
    const db = this.open();
    this.ctx = {
      db,
      secrets: opts.secrets,
      device: loadDevice(db),
      session: null,
      api: null,
      onLocalWrite: () => this.sync.nudge(),
    };
    this.ctx.api = this.makeApi(this.ctx.device);
    this.sync = this.makeSyncEngine();
  }

  private open(): DB {
    return openDatabase(this.dbFile, {
      beforeMigrate: (db, from, to) => createBackupSync(db, this.backupDir, `pre-migrate-v${from}-to-v${to}`),
    });
  }

  private makeApi(device: DeviceInfo | null): ApiClient | null {
    return device ? new ApiClient({ baseUrl: device.serverUrl, fetchImpl: this.opts.fetchImpl, appVersion: this.opts.appVersion }) : null;
  }

  private makeSyncEngine(): SyncEngine {
    const prefs = getPrefs(this.ctx.db);
    return new SyncEngine({
      db: this.ctx.db,
      getApi: () => this.ctx.api,
      getDeviceKey: () => getDeviceKey(this.ctx),
      onStatus: this.opts.onSyncStatus,
      onPulled: this.opts.onDataChanged,
      intervalMs: prefs.syncIntervalSec * 1000,
    });
  }

  get db(): DB {
    return this.ctx.db;
  }

  start(): void {
    if (this.opts.manualSync) return;
    this.sync.start();
    this.scheduleBackups();
  }

  stop(): void {
    this.sync.stop();
    if (this.backupTimer) clearInterval(this.backupTimer);
  }

  close(): void {
    this.stop();
    this.ctx.db.close();
  }

  // ------------------------------------------------------------------ device & session

  async register(args: { serverUrl: string; token: string; locationId: string; deviceName: string }): Promise<DeviceInfo> {
    const device = await setupRegister(this.ctx, args, this.opts.fetchImpl);
    this.ctx.device = device;
    this.ctx.api = this.makeApi(device);
    // Initial download of master data so the PC can work offline straight away.
    await this.sync.syncNow({ force: true });
    if (this.sync.getStatus().state !== 'idle') {
      throw new AppError('SYNC_FAILED', `Registered, but the initial download failed: ${this.sync.getStatus().lastError}. It will retry automatically.`);
    }
    return device;
  }

  async login(username: string, password: string): Promise<Session> {
    const session = await doLogin(this.ctx, username, password);
    this.ctx.session = session;
    if (session.mode === 'online') this.sync.nudge(100);
    return session;
  }

  logout(): void {
    if (this.ctx.session) auditLocal(this.ctx.db, this.ctx.session.user.id, 'auth.logout');
    this.ctx.session = null;
  }

  // ------------------------------------------------------------------ backups

  private scheduleBackups(): void {
    const check = () => {
      const prefs = getPrefs(this.ctx.db);
      const last = getMeta(this.ctx.db, 'last_backup_at');
      if (!last || Date.now() - new Date(last).getTime() >= prefs.autoBackupHours * 3600_000) {
        void this.backupNow('auto').catch((err) => syncLog(this.ctx.db, 'error', 'backup', `Automatic backup failed: ${(err as Error).message}`));
      }
    };
    check();
    this.backupTimer = setInterval(check, 30 * 60_000);
  }

  async backupNow(label: 'auto' | 'manual' = 'manual') {
    const info = await createBackup(this.ctx.db, this.backupDir, label);
    setMeta(this.ctx.db, 'last_backup_at', new Date().toISOString());
    pruneBackups(this.backupDir, getPrefs(this.ctx.db).backupRetention);
    syncLog(this.ctx.db, 'info', 'backup', `Backup created: ${info.name}`);
    return info;
  }

  listBackups() {
    return listBackups(this.backupDir);
  }

  verifyBackup(file: string) {
    return verifyDatabaseFile(file);
  }

  /**
   * Restore a verified backup. Transactions synced after the backup was taken are
   * re-downloaded (own stock movements included) so local stock matches the server.
   */
  restore(file: string): { preRestoreFile: string } {
    const user = this.ctx.session?.user.id ?? null;
    const info = verifyDatabaseFile(file);
    if (this.ctx.device && info.deviceId && info.deviceId !== this.ctx.device.deviceId) {
      throw new AppError('INVALID', 'This backup belongs to a different computer registration and cannot be restored here');
    }
    this.stop();
    this.ctx.db.close();
    let result: { preRestoreFile: string };
    try {
      result = restoreBackup(this.dbFile, file, this.backupDir);
    } finally {
      this.ctx.db = this.open();
    }
    setMeta(this.ctx.db, 'pull_cursor', '0');
    setMeta(this.ctx.db, 'pull_include_own', '1');
    auditLocal(this.ctx.db, user, 'backup.restore', 'backup', file, result);
    this.ctx.device = loadDevice(this.ctx.db);
    this.ctx.api = this.makeApi(this.ctx.device);
    this.sync = this.makeSyncEngine();
    this.start();
    return result;
  }
}
