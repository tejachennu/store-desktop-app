# Testing

```bash
npm run typecheck     # all workspaces (server, shared, desktop main/core and renderer)
npm test              # all suites below
```

| Suite | Command | Needs | Runs against |
|---|---|---|---|
| Shared domain | `npm test -w @store/shared` | — | pure functions |
| Central API | `npm test -w @store/server` | PostgreSQL (`TEST_DATABASE_URL`, default `postgres://store:store@localhost:5432/store_test`) | Express app + real database, schema dropped and migrated per file |
| Desktop core + end-to-end sync | `npm test -w @store/desktop` | PostgreSQL (`TEST_E2E_DATABASE_URL`, default `…/store_test_e2e`, created automatically) | SQLite files in a temp dir; several simulated PCs syncing through a real API server on a random port |
| Electron UI smoke | `npm run test:ui -w @store/desktop` (see below) | PostgreSQL, a display (or `xvfb-run`) | the built Electron app driven by Playwright |

Create the role and databases once:

```sql
CREATE USER store WITH PASSWORD 'store' CREATEDB;
CREATE DATABASE store_test OWNER store;
```

`better-sqlite3` is a native module. Electron and Node need different builds:
`npm run rebuild:electron -w @store/desktop` before running the app,
`npm run rebuild:node -w @store/desktop` before the Node test suites (the desktop
`test` script does this automatically).

## Requirement → test map

| Requirement | Where it is tested |
|---|---|
| Offline POS sale, atomic commit with movements + sync event | `desktop/test/core-offline.test.ts` "commits sale, payments, stock movements and the sync event atomically" |
| GST (inclusive/exclusive, CGST/SGST vs IGST, rounding), discounts, split payments | `shared/test/gst.test.ts`; desktop "charges IGST…", "validates payments"; server "produces dashboard and GST figures" |
| Stock updates & concurrent transactions | server "processes concurrent deliveries of the same event exactly once"; "accepts offline sales that drive central stock negative and flags them"; ledger integrity check (levels = Σ movements) in `transfers.test.ts` |
| Warehouse → warehouse transfers | server "allows warehouse → warehouse direct dispatch" |
| Warehouse → branch transfers, partial dispatch/receipt, discrepancies | server "request → approve → partial dispatch → … → resolve"; desktop e2e "runs the full request / approve / dispatch / receive cycle through the server" |
| Optional branch → branch | server "blocks branch → branch until enabled in settings"; desktop "branch-to-branch is gated by settings" |
| Returns & refunds | server "handles partial returns with exact refunds…"; desktop "refunds pro-rata, restocks good items and blocks over-returns" |
| Duplicate synchronisation prevention | server "is idempotent on replay"; desktop e2e "does not duplicate a sale when the push response is lost" |
| Network interruption & recovery | desktop e2e "keeps selling during an outage and uploads everything exactly once"; UI smoke outage step |
| Crash during a transaction | desktop "rolls back completely if the process fails mid-transaction" (injected I/O error) |
| Conflicts | server "accepts a dispatch that arrives after an offline cancel…"; desktop e2e "resolves a cancel/approve race…" |
| Location-based permissions | shared "scopes permissions to assigned locations"; server auth/sync/report scoping tests; desktop "blocks users not assigned to this location", IPC handler surface test |
| Authentication | server `auth.test.ts` (lockout, token invalidation, role checks); desktop e2e online/offline login |
| Backup & restore | desktop e2e "backs up and restores the local database…", "rejects a corrupted backup file"; central: `apps/server/scripts/backup-db.sh` verifies with `pg_restore --list` |

## Electron UI smoke test

```bash
createdb store_ui_smoke            # must be empty; the script seeds demo data
npm run rebuild:electron -w @store/desktop
npm run build -w @store/desktop
DATABASE_URL=postgres://store:store@localhost:5432/store_ui_smoke npm run test:ui -w @store/desktop
# Linux CI without a display: xvfb-run -a npm run test:ui -w @store/desktop
```

It registers a PC, signs in online, enters opening stock, bills a sale by barcode with a
UPI payment, raises a transfer request, opens consolidated reports, takes a backup and
syncs; then it stops the API, signs in offline, bills a cash sale with change, restarts
the API and verifies everything uploads with no failures. Screenshots go to
`apps/desktop/e2e-ui/output/`.
