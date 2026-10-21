/**
 * UI smoke test of the packaged-mode Electron app against a real central API.
 *
 *   createdb store_ui_smoke
 *   npm run build -w @store/desktop
 *   DATABASE_URL=postgres://store:store@localhost:5432/store_ui_smoke node apps/desktop/e2e-ui/smoke.mjs
 *   (Linux without a display: prefix with `xvfb-run -a`)
 *
 * The script seeds the (empty) database with demo data, starts the API on UI_SMOKE_PORT
 * (default 4100), stops/starts it to simulate an outage, and writes screenshots to
 * apps/desktop/e2e-ui/output. Exit code is non-zero on any failure.
 */
import { _electron as electron } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../../..');
const OUT = join(here, 'output');
const PORT = process.env.UI_SMOKE_PORT ?? '4100';
const API = `http://localhost:${PORT}`;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('Set DATABASE_URL to an empty PostgreSQL database');
mkdirSync(OUT, { recursive: true });

const serverEnv = { ...process.env, PORT, DATABASE_URL, JWT_SECRET: 'ui-smoke-secret-0123456789-0123456789-abc', LOG_LEVEL: 'warn' };
const tsx = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
execFileSync(tsx, ['src/db/seed.ts', '--demo'], { cwd: join(ROOT, 'apps/server'), env: serverEnv, stdio: 'inherit' });

let server = null;
const startServer = () => {
  // Own process group so the whole tree (tsx wrapper + node) can be stopped together.
  server = spawn(tsx, ['src/index.ts'], { cwd: join(ROOT, 'apps/server'), env: serverEnv, stdio: 'inherit', detached: process.platform !== 'win32' });
};
const stopServer = () => {
  if (!server || server.exitCode !== null) return;
  if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else process.kill(-server.pid, 'SIGTERM');
  server = null;
};
const waitServer = async (up) => {
  for (let i = 0; i < 120; i++) {
    const ok = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API did not become ${up ? 'available' : 'unavailable'}`);
};

const require = createRequire(import.meta.url);
const electronPath = require('electron'); // path to the Electron binary
const appData = mkdtempSync(join(tmpdir(), 'store-ui-smoke-'));
const launch = () =>
  electron.launch({
    executablePath: electronPath,
    args: [...(process.platform === 'linux' ? ['--no-sandbox'] : []), join(ROOT, 'apps/desktop/out/main/index.js')],
    env: { ...process.env, LOCALAPPDATA: appData },
  });

const errors = [];
async function withApp(fn) {
  const app = await launch();
  const page = await app.firstWindow();
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await fn(page);
  } finally {
    await app.close();
  }
}
const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`) });
const status = async (page) => (await page.evaluate(() => window.storeApi.invoke('sync.status'))).data;
const log = (m) => console.log(`[ui-smoke] ${m}`);

startServer();
await waitServer(true);
try {
  await withApp(async (page) => {
    log('first-run setup');
    await page.getByLabel('Central server address').fill(API);
    await page.getByLabel('Administrator username').fill('admin');
    await page.getByLabel('Password').fill('Admin@1234');
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('combobox', { name: 'This computer belongs to' }).click();
    await page.getByRole('option', { name: /Branch 1/ }).click();
    await page.getByLabel('Computer name').fill('Counter 1');
    await page.getByRole('button', { name: 'Register this computer' }).click();

    log('online sign-in');
    await page.getByLabel('Username').waitFor({ timeout: 60000 });
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('Admin@1234');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Company-wide (central server)').waitFor({ timeout: 30000 });
    await shot(page, '01-dashboard');

    log('opening stock');
    await page.getByRole('link', { name: 'Inventory' }).click();
    await page.getByRole('button', { name: 'Opening stock' }).click();
    const picker = page.getByRole('dialog').getByLabel('Scan barcode or search product');
    for (const code of ['8901000000011', '8901000000059', '8901000000042']) {
      await picker.fill(code);
      await picker.press('Enter');
      await page.waitForTimeout(200);
    }
    const qty = page.getByRole('dialog').locator('tbody tr td:nth-child(2) input');
    for (let i = 0; i < 3; i++) await qty.nth(i).fill('25');
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await page.getByText(/Opening stock .* saved/).waitFor();

    log('POS sale (online)');
    await page.getByRole('link', { name: 'Point of Sale' }).click();
    const scan = page.getByLabel('Scan barcode or search product');
    for (const code of ['8901000000011', '8901000000059', '8901000000059']) {
      await scan.fill(code);
      await scan.press('Enter');
    }
    await page.waitForTimeout(500);
    await shot(page, '02-pos');
    await page.keyboard.press('F8');
    await page.getByRole('button', { name: 'Full UPI' }).click();
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await page.getByText(/Sale .* saved/).waitFor({ timeout: 15000 });

    log('transfer request');
    await page.getByRole('link', { name: 'Stock Transfers' }).click();
    await page.getByRole('button', { name: 'Request stock' }).click();
    await page.getByRole('combobox', { name: 'Request from' }).click();
    await page.getByRole('option', { name: /Gudovun A/ }).click();
    const tp = page.getByRole('dialog').getByLabel('Scan barcode or search product');
    await tp.fill('8901000000028');
    await tp.press('Enter');
    await page.getByRole('button', { name: 'Send request' }).click();
    await page.getByText(/Stock request .* created/).waitFor();
    await page.keyboard.press('Escape');

    log('reports, backup');
    await page.getByRole('link', { name: 'Reports' }).click();
    await page.getByRole('tab', { name: /Company-wide/ }).click();
    await page.getByText('Branch 1 - Ameerpet').waitFor({ timeout: 20000 });
    await shot(page, '03-reports');
    await page.getByRole('link', { name: 'Settings & Backup' }).click();
    await page.getByRole('button', { name: 'Back up now' }).click();
    await page.getByText(/Backup created/).waitFor();
    await page.getByRole('link', { name: 'Synchronisation' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await page.getByText(/Synchronised with the central server/).waitFor({ timeout: 30000 });
    const s = await status(page);
    if (s.pending !== 0 || s.failed !== 0) throw new Error(`Expected everything synced, got ${JSON.stringify(s)}`);
  });

  log('outage: offline sign-in and sale');
  stopServer();
  await waitServer(false);
  await withApp(async (page) => {
    await page.getByLabel('Username').fill('admin');
    await page.getByLabel('Password').fill('Admin@1234');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Offline sign-in').waitFor({ timeout: 30000 });
    await page.getByRole('link', { name: 'Point of Sale' }).click();
    const scan = page.getByLabel('Scan barcode or search product');
    await scan.fill('8901000000059');
    await scan.press('Enter');
    // Pay is enabled once the main process has priced the cart.
    await page.getByRole('button', { name: /Pay \(F8\)/ }).click();
    await page.getByLabel('Amount (₹)').fill('100');
    await page.getByRole('button', { name: /Complete sale/ }).click();
    await page.getByText(/Sale .* saved/).waitFor({ timeout: 15000 });
    await page.waitForTimeout(2500);
    await shot(page, '04-offline-sale');
    let s = await status(page);
    if (s.state !== 'offline' || s.pending !== 1) throw new Error(`Expected offline with 1 pending, got ${JSON.stringify(s)}`);

    log('back online');
    startServer();
    await waitServer(true);
    await page.getByRole('link', { name: 'Synchronisation' }).click();
    await page.getByRole('button', { name: 'Sync now' }).click();
    await page.getByText(/Synchronised with the central server/).waitFor({ timeout: 30000 });
    s = await status(page);
    if (s.pending !== 0 || s.failed !== 0) throw new Error(`Expected everything synced after reconnect, got ${JSON.stringify(s)}`);
    await shot(page, '05-back-online');
  });
  if (errors.length) throw new Error(`Renderer errors: ${errors.join(' | ')}`);
  log(`passed — screenshots in ${OUT}`);
} finally {
  stopServer();
}
