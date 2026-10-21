# Operations

## Central server

### Requirements

* Node.js 22 LTS, PostgreSQL 14+ (16 recommended), HTTPS termination (reverse proxy
  such as nginx, IIS ARR or a cloud load balancer). Run the API on a private port behind
  the proxy; never expose PostgreSQL to branch PCs.

### Environment variables (`apps/server/.env`)

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgres://store:store@localhost:5432/store` | PostgreSQL connection string |
| `JWT_SECRET` | — (required, ≥ 32 chars) | HMAC key for access tokens. The example value is refused when `NODE_ENV=production` |
| `ACCESS_TOKEN_TTL_MINUTES` | `480` | Session length for online sign-ins |
| `PORT` | `4000` | HTTP port |
| `NODE_ENV` | `development` | `production` in production |
| `CORS_ORIGINS` | empty | Comma-separated origins for browser tools (the Electron app does not need CORS) |
| `LOG_LEVEL` | `info` | pino log level |
| `DB_POOL_MAX` | `20` | PostgreSQL pool size |
| `BUSINESS_TZ` | `Asia/Kolkata` | Time zone used to bucket transactions into business days |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.

### Install / upgrade

```bash
npm ci
npm run build -w @store/server            # bundles to apps/server/dist (migrations copied)
NODE_ENV=production node apps/server/dist/migrate-cli.js
SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD='<strong password>' SEED_COMPANY_NAME='Your Company' SEED_STATE_CODE=36 \
  node apps/server/dist/seed.js             # first install only: company + administrator
NODE_ENV=production node apps/server/dist/index.js
```

The API also applies pending migrations at start-up (under a PostgreSQL advisory lock, so
several instances can start together). Run it under a service manager (systemd, NSSM /
Windows service, Docker) with automatic restart. A `Dockerfile` and `docker-compose.yml`
are provided in `apps/server/` for container deployments.

### Migrations

* SQL files in `apps/server/src/db/migrations/NNN_name.sql`, applied in order, each in a
  transaction, recorded in `schema_migrations`.
* Add a new numbered file for every schema change; never edit an applied one.
* `npm run migrate -w @store/server` (dev) or `node dist/migrate-cli.js` (prod).
* Desktop SQLite migrations live in `apps/desktop/src/core/db/migrations.ts` (versioned by
  `PRAGMA user_version`); the app takes an automatic `pre-migrate` backup before upgrading
  an existing database.

### Initial company set-up

1. Sign in to any desktop as the administrator (or use the API).
2. Administration → **Company & GST**: legal name, GSTIN, state, business rules
   (branch-to-branch transfers, branch returns to warehouses, rounding, negative stock).
3. **Warehouses & branches**: one record per gudovun and per selling branch, with state
   code (place of supply), GSTIN, a short invoice prefix (≤ 3 characters keeps invoice
   numbers within GST's 16-character limit) and whether it may receive supplier goods.
4. **Users & roles**: create users, choose a role and assign locations.
5. Products → categories and products (barcodes, pack barcodes, HSN, GST rate, prices).
6. Opening stock: on each location's PC (Inventory → Opening stock), or centrally with
   `POST /api/stock/opening`.

### Registering PCs

On a new PC, install Store Manager and complete the first-run wizard with an
administrator account: server address → choose the warehouse/branch → computer name.
The PC receives a device key (stored with Windows DPAPI via Electron `safeStorage`) and
downloads master data. Several PCs may be registered to the same branch (one invoice
series per PC). Disable lost or retired PCs under Administration → Registered computers.

## Local data on each PC

`%LOCALAPPDATA%\StoreCo\StoreManager\`

| Path | Content |
|---|---|
| `store.db` (+ `-wal`, `-shm`) | SQLite database (WAL mode, `synchronous=FULL`) |
| `backups\` | automatic, manual, pre-migration and pre-restore backups |
| `secrets.json` | device key encrypted with DPAPI (useless if copied to another Windows account) |
| `logs\main.log` | main-process errors |
| `electron\` | Chromium profile |

The folder is outside the installation directory and is kept by the uninstaller. Grant
the Windows user account that runs the POS exclusive access to it (default for
`%LOCALAPPDATA%`). For encryption at rest enable BitLocker on the PC.

## Backup & restore

### Desktop (automatic)

* A verified online backup (SQLite backup API → `PRAGMA integrity_check`) is taken when
  the app starts if the last one is older than 24 h, and re-checked every 30 minutes.
  The newest 14 automatic backups are kept (configurable in Settings & Backup).
* **Back up now** creates a manual backup (never pruned).
* **Restore**: Settings & Backup → choose a backup → the file is integrity-checked and
  must belong to this PC's registration; restore is blocked while transactions are still
  waiting to upload (sync first). The current database is saved as `*-pre-restore.db`,
  the backup is swapped in, and own stock movements synced after the backup are
  re-downloaded so stock matches the server.
* Tested procedure: `apps/desktop/test/e2e-sync.test.ts` → "backs up and restores…" and
  "rejects a corrupted backup file".

### Central database

Run daily (and before upgrades):

```bash
apps/server/scripts/backup-db.sh            # pg_dump -Fc to $BACKUP_DIR, keeps $KEEP_DAYS days
```

Restore into an empty database:

```bash
createdb store_restored
pg_restore --no-owner --dbname=store_restored /backups/store-YYYYmmdd-HHMMSS.dump
```

then point `DATABASE_URL` at it and start the API. Devices continue from their cursors;
anything committed centrally after the dump is re-sent from the devices' outboxes
only if still pending, so prefer point-in-time recovery (WAL archiving / managed
PostgreSQL PITR) for production. Practise the restore on a staging server regularly.

## Monitoring

* `GET /api/health` for load balancer / uptime checks (checks the database).
* Dashboard "Needs review" and the Sync page show PCs that have not been seen for an
  hour, pending counts reported by each PC and rejected events.
* Server logs are JSON (pino) on stdout.

## Security checklist

* HTTPS only between PCs and the API; strong `JWT_SECRET`; `NODE_ENV=production`.
* Database user for the API owns only the application schema; no remote access to
  PostgreSQL from branch networks.
* Rotate a PC's credentials by disabling the device and registering the PC again.
* Review the audit log (Reports → User activity & audit log) regularly.
