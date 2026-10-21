# Store Manager — offline multi-warehouse & multi-branch store management

Windows desktop application (Electron + React + TypeScript + MUI) with a local
SQLite database on every warehouse/branch PC, and a central Node.js API backed by
PostgreSQL for consolidation, administration and reporting.

* Multiple **warehouses (gudovuns)** and multiple **selling branches**. There is **no
  main store / head store**: the central database is a logical system, it never holds stock.
* Every PC keeps working without internet: POS billing, returns, goods receipts,
  stock adjustments and every transfer step are committed locally and synchronised later.
* Each sale is one atomic SQLite transaction (sale, payments, stock movements and its
  sync event) with a unique UUIDv7 id that doubles as the idempotency key, so a sale is
  never lost and never duplicated during retries.

```
packages/shared   Domain rules shared by server and desktop: Zod schemas, GST engine,
                  permissions, transfer state machine, UUIDv7, document numbering
apps/server       Central REST API (Express, pg, Zod) + PostgreSQL migrations, seed, tests
apps/desktop      Electron app: core/ (SQLite, services, sync, backups), electron/ (main,
                  preload), renderer/ (React + MUI screens), tests
docs/             Architecture, sync protocol, API, operations, testing, packaging
```

## Quick start (development)

Requirements: Node.js 22+, PostgreSQL 14+ (16 recommended).

```bash
npm install

# 1. Central database and API
createdb store                       # or: psql -c "create database store"
cp apps/server/.env.example apps/server/.env    # set DATABASE_URL and JWT_SECRET
npm run seed -w @store/server -- --demo         # migrations + demo company, locations, users, products
npm run server:dev                              # http://localhost:4000

# 2. Desktop app
npm run desktop:dev
```

In the app's first-run wizard enter `http://localhost:4000`, sign in as `admin` /
`Admin@1234` (demo seed) and register the PC to a warehouse or branch. Demo users
(`whmanager`, `br1manager`, `br1cashier`, `br2cashier`, `purchase`, `accounts`) use the
password `Demo@1234`.

SQLite access uses `better-sqlite3`, whose Node-API prebuilt binaries load in both Node
(tests) and Electron without rebuilding.

### Running on macOS (development / evaluation)

The production target is Windows, but the app runs on macOS (Intel and Apple Silicon)
for development and demos:

```bash
brew install node@22 postgresql@16
brew services start postgresql@16
psql postgres -c "CREATE USER store WITH PASSWORD 'store' CREATEDB;" -c "CREATE DATABASE store OWNER store;"

git clone https://github.com/tejachennu/store-desktop-app.git && cd store-desktop-app
npm install
cp apps/server/.env.example apps/server/.env
npm run seed -w @store/server -- --demo
npm run server:dev        # terminal 1 — API on http://localhost:4000
npm run desktop:dev       # terminal 2 — first run downloads Electron (~100 MB)
```

On macOS the local data lives in `~/Library/Application Support/StoreCo/StoreManager`
(delete that folder to start the first-run wizard again) and the device key is stored in
the macOS Keychain. Stop the API (Ctrl+C in terminal 1) to try offline billing; restart it
and the app synchronises automatically.

## Tests

```bash
npm run typecheck
npm test          # shared unit tests, server integration tests (PostgreSQL), desktop core + end-to-end sync tests
```

The server and desktop suites need a reachable PostgreSQL; see [docs/TESTING.md](docs/TESTING.md).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, key decisions, data model, offline stock rules, roles |
| [docs/SYNC.md](docs/SYNC.md) | Outbox/inbox protocol, idempotency, ordering, retries, conflicts, reconciliation |
| [docs/API.md](docs/API.md) | REST endpoints and permissions |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Server deployment, environment variables, migrations, device registration, backup & restore |
| [docs/TESTING.md](docs/TESTING.md) | Test suites, what they cover, UI smoke test |
| [docs/PACKAGING.md](docs/PACKAGING.md) | Building and signing the Windows installer, upgrades, data location |

## Modules

Dashboard · Point of sale (barcode, GST invoice, discounts, cash/UPI/card and split
payments, receipts) · Sales returns, refunds & exchanges · Products, categories, SKUs,
barcodes, pack units, variants, images · Inventory ledger, adjustments, opening stock,
valuation · Stock transfers (warehouse↔warehouse, warehouse→branch, optional
branch↔branch, partial dispatch/receipt, discrepancies) · Purchase orders, GRN,
purchase returns, supplier payments & ledger · Customers · Users, roles & location
permissions · Reports (sales, GST, stock, purchases, transfers, returns, audit) ·
Synchronisation console · Local backups & restore.
