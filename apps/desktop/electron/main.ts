import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StoreCore } from '../src/core/app';
import { createHandlers } from '../src/core/api';
import { AppError } from '../src/core/errors';
import { SafeStorageSecretStore } from './secret-store';

/**
 * Data lives in %LOCALAPPDATA%\StoreCo\StoreManager (never in the install folder):
 *   store.db (+ -wal/-shm), backups\, logs\, secrets.json, electron\ (Chromium profile)
 */
const COMPANY_DIR = 'StoreCo';
const APP_DIR = 'StoreManager';
const dataDir = join(process.env.LOCALAPPDATA ?? app.getPath('appData'), COMPANY_DIR, APP_DIR);
mkdirSync(join(dataDir, 'logs'), { recursive: true });
app.setPath('userData', join(dataDir, 'electron'));

const isDev = !app.isPackaged;
const logFile = join(dataDir, 'logs', 'main.log');
function log(level: string, msg: string, extra?: unknown) {
  const line = `${new Date().toISOString()} ${level} ${msg}${extra ? ` ${JSON.stringify(extra, Object.getOwnPropertyNames(extra as object))}` : ''}\n`;
  try {
    appendFileSync(logFile, line);
  } catch {
    /* ignore */
  }
  if (isDev) console.log(line.trim());
}
process.on('uncaughtException', (err) => log('FATAL', 'uncaughtException', err));
process.on('unhandledRejection', (err) => log('ERROR', 'unhandledRejection', err));

if (!app.requestSingleInstanceLock()) {
  // A second copy would open the same SQLite file and run a second sync engine.
  app.quit();
}

let win: BrowserWindow | null = null;
let core: StoreCore | null = null;

function broadcast(channel: string, payload?: unknown) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1366,
    height: 860,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: 'Store Manager',
    backgroundColor: '#f4f7fb',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => {
    win?.maximize();
    win?.show();
  });
  // The renderer is a local single-page app: no navigation, no new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function isTrustedSender(frameUrl: string | undefined): boolean {
  if (!frameUrl) return false;
  if (frameUrl.startsWith('file://')) return true;
  return isDev && !!process.env.ELECTRON_RENDERER_URL && frameUrl.startsWith(process.env.ELECTRON_RENDERER_URL);
}

/** Print a receipt / invoice given as a complete HTML document. */
async function printHtml(html: string, opts: { silent?: boolean; deviceName?: string | null; widthMm?: number }) {
  const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await printWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      printWin.webContents.print(
        {
          silent: !!opts.silent,
          deviceName: opts.deviceName ?? undefined,
          printBackground: true,
          margins: { marginType: 'none' },
          ...(opts.widthMm ? { pageSize: { width: opts.widthMm * 1000, height: 297000 } } : {}),
        },
        (ok, failureReason) => resolve(ok ? { ok } : { ok, error: failureReason }),
      );
    });
  } finally {
    printWin.destroy();
  }
}

app.whenReady().then(async () => {
  // Strict CSP for the renderer (no remote code; API calls go through the main process).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          isDev && process.env.ELECTRON_RENDERER_URL
            ? "default-src 'self' 'unsafe-inline' http://localhost:* ws://localhost:*; img-src 'self' data: blob:"
            : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:",
        ],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  if (!isDev) Menu.setApplicationMenu(null);

  core = new StoreCore({
    dataDir,
    secrets: new SafeStorageSecretStore(join(dataDir, 'secrets.json')),
    fetchImpl: (input, init) => net.fetch(input, init as RequestInit),
    appVersion: app.getVersion(),
    onSyncStatus: (s) => broadcast('sync-status', s),
    onDataChanged: () => broadcast('data-changed'),
  });
  log('INFO', `Store Manager ${app.getVersion()} started; data dir ${dataDir}`);

  const handlers: Record<string, (args: any) => unknown> = {
    ...createHandlers(core),
    'print.html': (a: { html: string; silent?: boolean; widthMm?: number }) => {
      const prefs = createHandlers(core!)['prefs.get']();
      return printHtml(String(a.html), { silent: a.silent ?? prefs.silentPrint, deviceName: prefs.receiptPrinter, widthMm: a.widthMm });
    },
    'print.printers': async () => (await win!.webContents.getPrintersAsync()).map((p) => ({ name: p.name, isDefault: (p as { isDefault?: boolean }).isDefault ?? false })),
    'app.openDataDir': () => shell.openPath(dataDir),
    'app.version': () => ({ version: app.getVersion(), electron: process.versions.electron, dataDir }),
    'backup.chooseFile': async () => {
      const r = await dialog.showOpenDialog(win!, {
        title: 'Choose a backup to restore',
        defaultPath: join(dataDir, 'backups'),
        filters: [{ name: 'Store backups', extensions: ['db'] }],
        properties: ['openFile'],
      });
      return r.canceled ? null : r.filePaths[0];
    },
    'app.saveCsv': async (a: { name: string; content: string }) => {
      const r = await dialog.showSaveDialog(win!, { defaultPath: a.name, filters: [{ name: 'CSV', extensions: ['csv'] }] });
      if (r.canceled || !r.filePath) return { saved: false };
      const { writeFileSync } = await import('node:fs');
      writeFileSync(r.filePath, '﻿' + a.content, 'utf8'); // BOM so Excel detects UTF-8 (₹)
      return { saved: true, path: r.filePath };
    },
  };

  ipcMain.handle('api', async (event, method: string, args: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Untrusted sender' } };
    const fn = handlers[method];
    if (!fn) return { ok: false, error: { code: 'NOT_FOUND', message: `Unknown method ${method}` } };
    try {
      return { ok: true, data: await fn(args) };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, error: { code: err.code, message: err.message, details: err.details } };
      if ((err as { name?: string }).name === 'ZodError') {
        const issues = (err as { issues: { path: (string | number)[]; message: string }[] }).issues;
        return { ok: false, error: { code: 'VALIDATION', message: issues.map((i) => (i.path.length ? `${i.path.join('.')}: ` : '') + i.message).join('; '), details: issues } };
      }
      log('ERROR', `handler ${method} failed`, err);
      return { ok: false, error: { code: 'INTERNAL', message: (err as Error).message ?? 'Unexpected error' } };
    }
  });

  createWindow();
  core.start();
});

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  try {
    core?.close();
  } catch (err) {
    log('ERROR', 'close failed', err);
  }
});
