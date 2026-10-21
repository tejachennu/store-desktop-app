# Synchronisation

Every desktop installation ("device") is registered to exactly one warehouse or branch
and owns a local SQLite database. Operational work is written locally first and pushed
to the central API; master data and other parties' changes are pulled back.

```
 desktop (SQLite)                                  central (PostgreSQL)
 ┌──────────────────────────────┐   push batch     ┌──────────────────────────────┐
 │ business tables + movements  │ ───────────────► │ sync_inbox (id = event id)   │
 │ outbox (event per change)    │ ◄─────────────── │ per-event transaction        │
 │                              │  ACCEPTED/DUP/   │ documents + ledger + audit   │
 │ meta.pull_cursor             │  REJECTED        │                              │
 │                              │   pull(cursor)   │ server_seq (commit-ordered)  │
 │ upsert master data / docs    │ ◄─────────────── │ changes since cursor         │
 └──────────────────────────────┘                  └──────────────────────────────┘
```

## Writing locally (outbox)

* Every service that changes data (`createSale`, `createReturn`, `createGrn`,
  `dispatchTransfer`, …) runs inside one `BEGIN IMMEDIATE` SQLite transaction that
  writes the document, its stock movements (through `applyMovement`, the only function
  that changes stock) **and** one row in `outbox`. Either all of it commits or none of it.
* SQLite runs in WAL mode with `synchronous=FULL`, so a committed sale survives a crash
  or power cut. A failure half-way through (tested by injecting an I/O error) leaves no
  trace — not even a consumed invoice number.
* Each outbox row carries the full event envelope:
  `{ id, type, locationId, userId, occurredAt, payload }`. `id` is a UUIDv7 generated
  when the event is written and is the **idempotency key**. Document line ids double as
  stock-movement ids, so the same movement can never be applied twice anywhere.
* `doc_refs` lists the documents an event touches (sale, transfer, purchase order…);
  pulls never overwrite a document that still has unsent local events.

## Push

`POST /api/sync/push` with header `X-Device-Key: <deviceId>.<secret>`, body
`{ events: [...] }` (max 200, oldest first, from `outbox` ordered by `seq`).

Server processing, per event, in its own PostgreSQL transaction:

1. `INSERT INTO sync_inbox (id, …, status='PROCESSING') ON CONFLICT DO UPDATE` claims the
   key. A concurrent delivery of the same id blocks on the row lock and then sees the
   final status.
2. Already `ACCEPTED` → respond `DUPLICATE` (the client treats it as success).
3. Validate with the shared Zod schema; check that the event's location is the device's
   location; check the user is active, assigned to the location and has the permission
   for the event type.
4. Apply the handler (savepoint). Totals are re-verified (line taxes add up, header totals
   equal line sums, payments match the bill); stock is changed only through `applyMovement`.
5. Mark `ACCEPTED`, write an audit row, commit. Business-rule failures roll back to the
   savepoint and mark the inbox row `REJECTED` with the reason.

Result per event: `ACCEPTED`, `DUPLICATE` or `REJECTED` (+ `retryable`).

| Client outcome | Meaning | Client action |
|---|---|---|
| network error, timeout, HTTP 5xx | outcome unknown | keep `PENDING`, back off the whole engine (2 s, 4 s, 8 s … 15 min, ±25 % jitter), resend later — the server answers `DUPLICATE` if it already committed |
| `ACCEPTED` / `DUPLICATE` | stored centrally | `SYNCED` |
| `REJECTED`, `retryable` | a dependency has not arrived yet (customer, original sale, transfer) | stays `PENDING`, per-event backoff; becomes `FAILED` after 20 attempts |
| `REJECTED`, not retryable | business rule refused it | `FAILED`; affected transfers / purchase orders are re-downloaded (`POST /api/sync/refresh`) so the local copy shows the server's state |

`FAILED` events are never deleted. They are listed in the desktop sync console and in
the central "Sync inbox"; an administrator fixes the cause (e.g. re-assigns a user) and
presses **Retry**, which re-queues them with the same idempotency key.

## Pull

`GET /api/sync/pull?cursor=<n>` returns everything changed with
`cursor < server_seq ≤ upto`:

* company settings, locations, users (never password hashes), categories, products with
  barcodes, suppliers, customers — all devices;
* purchase orders for the device's location; transfers where it is source or destination;
* stock movements at the device's location written by **other** devices or centrally
  (opening stock entered by an admin, discrepancy resolutions).

`server_seq` comes from a single counter row incremented once per writing transaction;
its row lock is held until commit, so sequence order equals commit order and a reader
that has seen `N` can never later miss a change `≤ N`. Pulls page in windows of 500
transactions (`hasMore`). Each page is applied in one SQLite transaction together with
the new cursor. The engine always pushes before it pulls.

## Offline stock allocation and conflicts

* **One ledger owner per location.** Only devices registered to a location (or central
  admin actions targeted at it) create movements there; the server rejects events that
  claim another location.
* **Local stock is not global stock.** POS and dispatches check this location's local
  `available = on hand − reserved` (reserved = approved, not yet dispatched outgoing
  transfer quantities). Other locations' stock in the UI comes from the server and is
  shown as a read-only snapshot.
* **Multiple terminals in one branch** each validate against their own view; their
  movements fan out to each other on the next pull. If two terminals sold the last units
  while offline, the server still accepts both sales (they happened) and opens a
  `NEGATIVE_STOCK` reconciliation item.
* **Transfers** are owned step by step: request/cancel by the requester, approve/reject/
  dispatch by the source, receive/close by the destination. Invalid transitions are
  rejected and the loser is resynchronised. A dispatch is a physical fact: if it arrives
  after an offline cancel, it is accepted, the transfer re-opens and a
  `TRANSFER_CONFLICT` item is raised.
* **In-transit stock** is in no location. Shortages and damaged units on receipt become
  `TRANSFER_DISCREPANCY` items. The admin resolves each as write-off, returned to source
  or found at destination; the latter two post a central movement that the location's
  devices pull.

## Reconciliation tools

* Desktop → Synchronisation: pending / failed / synced events, sync log, retry, and a
  **stock check** comparing local on-hand with the central ledger for the location.
* Transfers → Discrepancies & conflicts (central queue, resolve with a note).
* Dashboard "Needs review" and per-device health (last seen, pending count reported by
  each PC, rejected events).

## Restore and resync

Restoring a local backup resets the pull cursor and sets `includeOwn=1` once, so stock
movements this device synced after the backup was taken are downloaded again and local
stock matches the server. Events still `PENDING` inside the restored file are re-sent
and acknowledged as `DUPLICATE` if they had already arrived.

## Known limitations

* A sale can be returned at the branch that made it, on the terminal that holds the
  invoice (sales are not copied between sibling terminals). Customer history is
  available company-wide online.
* Master data (products, users, locations, suppliers, purchase orders, settings) is
  edited online only, so it stays consistent everywhere.
* A user's first sign-in on a PC must be online; later sign-ins work offline.
