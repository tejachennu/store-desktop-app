# Central REST API

Base path `/api`. JSON in and out. Errors: `{ "error": { "code", "message", "details?" } }`
with HTTP 400 (validation), 401, 403, 404, 409 (conflict/duplicate), 413, 429, 500.

Authentication:

* **Users** — `Authorization: Bearer <JWT>` from `/api/auth/login` (HS256, default 8 h).
  Tokens carry a `token_version`; password changes, resets and deactivation invalidate
  every issued token immediately.
* **Devices** — `X-Device-Key: <deviceId>.<secret>` issued once at registration (only a
  SHA-256 of the 256-bit secret is stored). Used for sync only.

Every user route checks the role permission (`packages/shared/src/permissions.ts`) and,
for location-bound data, that the user is assigned to that location (company admins
see all). Desktop clients never connect to PostgreSQL directly.

## Auth

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{username, password}` → `{accessToken, expiresAt, user}`. 5 failures lock the account for 15 min; rate-limited per IP+username |
| GET | `/auth/me` | current user + permissions |
| POST | `/auth/change-password` | `{currentPassword, newPassword}` → new token |

## Administration

| Method | Path | Permission |
|---|---|---|
| GET / PUT | `/settings` | any user / `settings.manage` |
| GET | `/locations` | any user |
| POST / PUT | `/locations`, `/locations/:id` | `locations.manage` |
| GET / POST / PUT | `/users`, `/users/:id` | `users.manage` |
| GET | `/devices` | `sync.admin` |
| POST | `/devices/register` | `locations.manage` → `{deviceId, deviceNo, deviceKey, location}` |
| PUT | `/devices/:id` | `sync.admin` — `{isActive}` |
| GET | `/audit-logs?action&userId&locationId&entityId&before&limit` | `audit.view` |

## Catalogue & partners

| Method | Path | Permission |
|---|---|---|
| GET | `/categories` | any user |
| POST / PUT | `/categories`, `/categories/:id` | `products.manage` |
| GET | `/products?search&categoryId&active&limit&offset` | any user |
| GET | `/products/:id`, `/products/by-barcode/:code`, `/products/:id/price-history` | any user |
| POST / PUT | `/products`, `/products/:id` | `products.manage` (barcodes unique across products) |
| GET | `/suppliers?search` (with balance due), `/suppliers/:id/ledger` | `suppliers.view` |
| POST / PUT | `/suppliers`, `/suppliers/:id` | `suppliers.manage` |
| GET | `/customers?search` | `customers.view` |
| PUT | `/customers/:id` | `customers.manage` (upsert) |
| GET | `/customers/:id/history` | `sales.view`, limited to the user's locations |

## Purchasing

| Method | Path | Permission |
|---|---|---|
| GET | `/purchase-orders?locationId&status&supplierId`, `/purchase-orders/:id` | `purchase.view` |
| POST | `/purchase-orders` | `purchase.order` at the receiving location (must be authorised to receive purchases) |
| POST | `/purchase-orders/:id/status` | `purchase.order` — `ORDERED` (from draft) or `CANCELLED` (no receipts yet) |
| GET | `/grns?locationId&supplierId`, `/grns/:id` | `purchase.view` |

GRNs, purchase returns and supplier payments are created on the desktop (offline) and
arrive through sync.

## Inventory & transfers

| Method | Path | Permission |
|---|---|---|
| GET | `/stock?locationId&productId&search&lowOnly&limit` | `stock.view`; other locations visible to users who can request transfers |
| GET | `/movements?locationId&productId&from&to&limit` | `stock.view` at the location |
| POST | `/stock/opening` | `stock.opening` at the location — central opening stock, pulled by the location's PCs |
| GET | `/transfers?locationId&status`, `/transfers/:id` (with history) | `transfers.view` |
| GET | `/reconciliation?status&type&locationId` | `transfers.view` |
| POST | `/reconciliation/:id/resolve` | `transfers.resolve` — `{resolution, note}`; discrepancies: `WRITE_OFF`, `RETURN_TO_SOURCE`, `FOUND_AT_DESTINATION`; others `ACKNOWLEDGED` |

## Reports (consolidated, scoped to the user's locations)

All take `from`, `to` (YYYY-MM-DD, business time zone) and optional `locationId`.

| Path | Permission | Content |
|---|---|---|
| `/reports/dashboard` | `reports.view` | sales, returns, purchases, sales by day and branch, stock by location, low stock, pending transfers, open reconciliation, device sync health |
| `/reports/sales?groupBy=day\|location\|product\|payment\|user\|invoice` | `sales.view` | product view includes margin from movement cost |
| `/reports/gst` | `reports.gst` | by rate × B2B/B2C (sales less returns), HSN summary, by location/GSTIN, input tax |
| `/reports/stock-valuation` | `stock.view` | by location and category, at cost and retail |
| `/reports/purchases` | `purchase.view` | by supplier and by location |
| `/reports/transfers` | `transfers.view` | quantities requested/approved/dispatched/received/damaged |
| `/reports/returns` | `sales.view` | credit notes with restocked quantities |

## Sync (device key)

| Method | Path | Notes |
|---|---|---|
| POST | `/sync/push` | `{events: SyncEvent[]}` (≤ 200) → `{results: [{id, status, error?, retryable?}]}`; optional header `X-Pending-Count` |
| GET | `/sync/pull?cursor=<n>[&includeOwn=1]` | incremental changes, see [SYNC.md](SYNC.md) |
| POST | `/sync/refresh` | `{ids}` → current transfers / purchase orders for this location |
| GET | `/sync/ping` | connectivity + device check |
| GET | `/sync/inbox?status&deviceId` | user token, `sync.admin` — rejected events across devices |

Event types (`packages/shared/src/schemas/sync.ts`): `customer.upsert`, `sale.create`,
`sale_return.create`, `stock_adjustment.create`, `grn.create`, `purchase_return.create`,
`supplier_payment.create`, `transfer.create`, `transfer.approve`, `transfer.reject`,
`transfer.cancel`, `transfer.dispatch`, `transfer.receive`, `transfer.close`.

`GET /api/health` (no auth) reports API and database availability.
