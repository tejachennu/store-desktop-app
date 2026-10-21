# Architecture

Offline-first store management for a company that operates **multiple warehouses
(gudovuns)** and **multiple selling branches**. There is no main store, head store
or central retail inventory. The central PostgreSQL database is a *logical*
consolidation and administration system, never a stock-holding location.

```
┌──────────────────────── Windows PC (one per warehouse / branch terminal) ────────────────────────┐
│  Electron renderer (React + TS + MUI)                                                            │
│      │  window.api.invoke(channel, payload)   (contextIsolation, no Node in renderer)            │
│  Electron preload  ── IPC ──►  Electron main process                                              │
│                                   ├─ core/services   (POS, inventory, transfers, purchases …)    │
│                                   ├─ core/db         (better-sqlite3, migrations, WAL)            │
│                                   ├─ core/sync       (outbox push, incremental pull, backoff)     │
│                                   ├─ core/backup     (online SQLite backups, verified restore)    │
│                                   └─ core/api-client (REST → central server, JWT / device key)    │
│  %LOCALAPPDATA%/StoreCo/StoreManager/store.db (+ backups/, logs/)                                 │
└───────────────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                │ HTTPS REST (never direct DB access)
┌───────────────────────────────────────────────▼──────────────────────────────────────────────────┐
│  Central API (Node.js + Express + Zod)                                                           │
│     /api/auth  /api/admin/*  /api/products …  /api/sync/push  /api/sync/pull  /api/reports/*      │
│  PostgreSQL: consolidated ledger, documents, users, devices, sync inbox, conflicts, audit log     │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Monorepo layout

```
packages/shared        Zod schemas, enums, GST engine, permissions, transfer state machine, UUIDv7
apps/server            Central REST API + PostgreSQL migrations, seed, reports, sync inbox
apps/desktop           Electron app
  electron/            main.ts (window, IPC wiring, secure storage), preload.ts
  src/core/            Node-side domain: SQLite db, services, sync engine, backups (unit-tested, no Electron)
  src/renderer/        React UI (MUI), pages per module
docs/                  Architecture, sync, operations, packaging
```

The desktop domain layer (`src/core`) is plain Node so it is fully testable without
Electron. Electron main only wires IPC channels to core services and enforces the
logged-in session's permissions on every call.

## Key decisions

| Topic | Decision | Why |
|---|---|---|
| Data access | Hand-written parameterised SQL (`pg`, `better-sqlite3`) + versioned SQL migrations | Two dialects (PG + SQLite) with ledger logic that must be explicit and atomic; avoids an ORM engine binary in the Windows installer. Every query is parameterised. |
| IDs | UUIDv7 generated on the client for every document, line, movement and sync event | Globally unique while offline, time-ordered for index locality, doubles as idempotency key. |
| Money | Integer paise; GST rates in basis points (1800 = 18%) | No floating point in invoices. |
| Quantity | Integer in the product's base unit (pcs, g, ml) | Exact ledger arithmetic. Alternate pack units (box of 12) are barcodes with a factor. |
| Stock | Append-only `stock_movements` ledger + derived `stock_levels` updated in the same transaction | "Never change stock without a movement" is enforced by having one function that does both. |
| Master data | Authored centrally (online) and cached on every device via incremental pull | Products/users/locations must be consistent company-wide. |
| Operational data | Authored locally (offline) and pushed as idempotent events | Sales, returns, GRNs, adjustments, transfer steps never need the network. |

## Offline stock allocation & reconciliation rules

Locally cached inventory is **not** global stock. The rules that keep the ledger sound:

1. **Single owner per location ledger.** Stock at location *L* only changes through
   events created by devices registered to *L* (sales, returns, GRNs, adjustments,
   transfer dispatch/receipt) or through central admin movements targeted at *L*
   (opening stock, discrepancy resolution). The server rejects an event that tries
   to move stock at a location other than the sending device's location.
2. **A location only sells/dispatches its own stock.** POS validates against the local
   `stock_levels` of its own location. Other locations' stock shown in the app is a
   read-only, timestamped snapshot from the server.
3. **Movements fan out to sibling terminals.** If a branch runs several POS terminals,
   each terminal pulls the other terminals' movements for its location (by movement id,
   idempotent), so local stock converges as soon as any terminal is online.
4. **Sales are facts.** A synced sale is never rejected because central stock would go
   negative (goods have already left the counter). The server accepts it and opens a
   `NEGATIVE_STOCK` reconciliation item for the admin. Local POS blocks overselling
   by default (`allowNegativeStock` setting can relax this per location).
5. **Transfers are owned per step.** Request/cancel by the requester, approve/reject/
   dispatch by the source, receive/close by the destination. The server validates
   each step against the transfer state machine. A dispatch (physical fact) is never
   rejected: if it arrives after an offline cancel, the transfer is re-opened as
   dispatched and a `TRANSFER_CONFLICT` item is raised. Other invalid transitions
   are rejected and the device is resynchronised to the server's state.
6. **In-transit stock** lives in no location: dispatch posts `TRANSFER_OUT` at the
   source, receipt posts `TRANSFER_IN` at the destination. Shortages and damages on
   receipt create a transfer discrepancy for review; resolution posts an admin movement
   (write-off or return to source).

## Sync protocol (summary — see `SYNC.md`)

* Every local write that must reach the server appends an **outbox** row in the
  *same SQLite transaction* as the business data → a committed sale always has its
  sync event, a rolled-back sale never does.
* Push: ordered batches to `POST /api/sync/push` authenticated with the device key.
  Each event carries its UUID idempotency key. The server processes each event in its
  own PostgreSQL transaction and records it in `sync_inbox` (unique key). Replays
  return the original result → no duplicates after interrupted requests.
* Status per event: `PENDING → SYNCED` or `FAILED` (permanent rejection, visible in
  the admin sync console with retry/discard). Transient failures back off
  exponentially (2s … 15 min, jittered) without reordering.
* Pull: `GET /api/sync/pull?cursor=` returns master data and documents changed since
  the cursor (global `server_seq` sequence) for this device's location. Pull always
  runs after push; documents with unsent local events are not overwritten.

## Data model

Central PostgreSQL (`apps/server/src/db/migrations/001_init.sql`) — single company per deployment:

| Area | Tables |
|---|---|
| Organisation | `company` (settings & business rules), `locations` (type `WAREHOUSE` \| `BRANCH`, state code, GSTIN, invoice prefix, may receive purchases), `users`, `user_locations`, `devices` |
| Catalogue | `categories`, `products` (SKU, HSN, GST rate, prices, MRP, variant group/attributes, image), `product_barcodes` (barcode → product × pack factor) |
| Partners | `suppliers`, `customers` |
| Inventory | `stock_movements` (append-only ledger; id = causing document line), `stock_levels` (derived on-hand + weighted average cost per location × product), `stock_adjustments` (+ lines) |
| Sales | `sales`, `sale_lines` (qty returned tracked), `sale_returns` (+ lines), `payments` (sale payments and refunds, cash net of change) |
| Purchasing | `purchase_orders` (+ lines), `goods_receipts` (GRN = purchase invoice record, + lines), `purchase_returns` (+ lines), `supplier_payments` |
| Transfers | `stock_transfers`, `transfer_lines` (requested / approved / dispatched / received / damaged), `transfer_dispatches` & `transfer_receipts` (+ lines, partial steps), `transfer_history` |
| Control | `reconciliation_items` (negative stock, transfer conflicts and discrepancies, rejected events), `sync_inbox` (one row per event id), `audit_logs` (append-only), `sync_counter` + `server_seq` columns (incremental pull), `doc_counters` |

Local SQLite (`apps/desktop/src/core/db/migrations.ts`) mirrors what one location needs:
cached master data, the location's ledger (`stock_movements` with origin `LOCAL`/`REMOTE`,
`stock_levels`), its sales, returns, payments, GRNs, purchase returns, supplier payments,
adjustments, transfers that involve it, purchase orders for it, plus `outbox`, `sync_log`,
`audit_log`, `doc_counters`, `user_credentials` (offline verifiers) and `meta`
(device registration, pull cursor, settings, preferences).

Reserved stock is not stored: it is the approved-but-not-dispatched quantity of open
outgoing transfers, so it can never drift.

Document numbers are generated per device so they work offline and are unique
company-wide: `<prefix><device no>/<FY>/<seq>`, e.g. invoice `B11/2627/00042`, credit note
`B1R1/2627/00003`, transfer `TBR11/2627/00007`, GRN `GWHA1/2627/00012`.

## API and screens

The REST surface is listed in [API.md](API.md); the sync protocol in [SYNC.md](SYNC.md).
The renderer calls a single IPC method table (`apps/desktop/src/core/api.ts`): local
operations run against SQLite; screens that edit master data or show consolidated data
call the central API through the main process with the signed-in user's token (the token
never reaches the renderer).

| Screen | Works offline | Central (online) features |
|---|---|---|
| Dashboard | location KPIs, charts, transfers needing action, pending sync | company-wide sales, stock by location, branch sales, review queue |
| Point of sale | yes | — |
| Sales & returns | yes (invoices of this PC) | — |
| Inventory | levels, movements, adjustments, opening stock | stock at all locations |
| Transfers | create, approve, reject, cancel, dispatch, receive, close | discrepancy & conflict resolution |
| Purchases | GRN, purchase returns, supplier payments, cached POs | create / place / cancel purchase orders |
| Products, suppliers | browse | create & edit, supplier ledger, price history |
| Customers | create, edit, history on this PC | company-wide history |
| Reports | location sales, HSN, GST | consolidated sales, GST, stock valuation, purchases, transfers, returns, audit |
| Synchronisation | outbox, retry, log | stock check vs central, device health, server rejected events |
| Administration | — | company settings, locations, users & roles, devices |
| Settings & backup | printer, backups, restore | — |

## Security

* Server: scrypt password hashes, expiring JWT access tokens (default 8 h, revoked on password change or deactivation), device API keys
  (hashed at rest) for sync, role + location authorisation on every route and every
  sync event, Zod validation, Helmet, login rate limiting, audit log.
* Desktop: renderer is sandboxed (`contextIsolation`, no `nodeIntegration`), only a
  whitelisted IPC surface; device key & tokens stored with Electron `safeStorage`
  (DPAPI on Windows); offline login only for users who previously logged in online on
  that device (salted scrypt verifier cached locally); database outside the install
  folder; automatic daily backups with integrity-checked restore.

## Roles

| Role | Scope |
|---|---|
| Company Admin | All locations, users, settings, consolidated reports, sync console |
| Warehouse Manager | Assigned warehouses: stock, GRN, transfers, adjustments, reports |
| Branch Manager | Assigned branches: POS, returns, stock requests, transfers, adjustments, reports |
| Sales Staff (POS) | Assigned branches: sales, returns (if allowed), customers |
| Purchase Staff | Suppliers, purchase orders, GRN, purchase returns |
| Accounts Staff | Invoices, supplier payments, GST & financial reports (read-only stock) |

The full permission matrix lives in `packages/shared/src/permissions.ts` and is used by
both the server and the desktop app.
