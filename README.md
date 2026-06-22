# FastPoker Indexer Public

A source-code release of the FastPoker protocol read indexer. It subscribes to
FastPoker program activity, reconstructs chain-derived data, stores it in MongoDB,
and serves read-only HTTP/WebSocket APIs for clients that want history, table
discovery, leaderboards, jackpot receipts, and SNG state.

This package is intentionally separate from `Frontend`. Users can run the
client without this indexer. Users who want the FULL read experience can run this
indexer as a normal Node process beside any frontend, script, or service they choose.

## What This Keeps

- Program event backfill and live tail.
- MongoDB collections for `tables`, `hands`, `hand_reports`, `players`, `earnings`,
  `rake_ledger`, `tournaments`, `jackpot_receipts`, and cursor state.
- HRV1 hand-report chunk reconstruction.
- JPV1 jackpot receipt ingestion.
- SNG pool, listed-token, and raw table-account read caches.
- Table stats derived from indexed hand reports.
- Read-only HTTP APIs and anonymous WebSocket topics.

## What This Removes

- Frontend-owned table-name claims/renames.
- Usernames, XP, synced preferences, and separate identity database wiring.
- Wallet footer/earn-page snapshots.
- Token-supply/yield-bar/pool-health convenience endpoints.
- Admin dashboard and dealer-health aggregation endpoints.
- Incident-specific repair scripts and fixture HTTP tests.

The result is a clean protocol read indexer, not a private frontend backend.

## Quick Start

Prerequisites: Node 20+, MongoDB, and a paid/dedicated Solana RPC endpoint.

Do not point this indexer at the public/free Solana RPC. It performs historical
transaction backfills, account reads, WebSocket subscriptions, and safety reseeds;
free endpoints will rate-limit, drop subscriptions, or return incomplete data.
Use a keyed provider such as Helius, QuickNode, Triton, Alchemy, Syndica, or your
own Solana RPC infrastructure. A stream provider is recommended for live
production updates; the bundled stream adapter is LaserStream/Geyser-compatible,
but `RPC_URL` itself is provider-neutral.

```bash
npm ci
cp .env.example .env
npm run backfill
npm run start
```

By default the server listens on `http://localhost:3001`.

## Configuration

Copy `.env.example` to `.env` and edit:

```bash
MONGO_URI=mongodb://localhost:27017
MONGO_DB=fastpoker_indexer
RPC_URL=
RPC_WS_URL=
STREAM_PROVIDER=laserstream
STREAM_ENDPOINT=
STREAM_API_KEY=
PROGRAM_ID=PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn
INDEXER_PORT=3001
```

`RPC_URL` is required and intentionally blank in `.env.example`. Fill it with a
paid/dedicated mainnet endpoint before running `npm run backfill` or `npm run start`.
`RPC_WS_URL` can stay blank only if your provider's WebSocket URL is the same URL
with `https://` changed to `wss://`; otherwise set the provider's explicit WS URL.

`STREAM_PROVIDER=laserstream`, `STREAM_ENDPOINT`, and `STREAM_API_KEY` enable the
bundled LaserStream/Geyser-compatible account stream. They are optional for local
experiments, but without a stream provider the live stream is reduced and caches
rely on slower safety reads over your RPC quota. `LASERSTREAM_ENDPOINT`,
`LASERSTREAM_API_KEY`, and `HELIUS_API_KEY` remain accepted as backward-compatible
aliases, but new deployments should prefer the `STREAM_*` names.

Historical backfill uses an enhanced `getTransactionsForAddress` fast path when
your RPC provider supports it. Otherwise it falls back to standard Solana
`getSignaturesForAddress` plus batched `getTransaction`, which is slower and uses
more quota but is not provider-specific.

## Commands

```bash
npm run dev                    # watch mode
npm run start                  # live indexer + HTTP server
npm run backfill               # one historical catch-up pass
npm run backfill:token-mints   # one repair pass for missing table token mints
npm run recover:jackpots       # recover missed jackpot receipts / hand reports
npm run typecheck              # TypeScript validation
```

## HTTP API

Core status:

- `GET /health`
- `GET /metrics`

Protocol state:

- `GET /v1/sng-pools`
- `GET /v1/tokens`
- `GET /v1/tables`
- `GET /v1/tables?pubkey=<tablePda>`
- `GET /tables/live`
- `GET /tables/stats?pdas=<pda1,pda2>`
- `GET /table/:tablePda`

Hands and reports:

- `GET /hand/:tablePda%3AhandNumber`
- `GET /hand-report/:tablePda/:handNumber`
- `GET /hand-report/:tablePda/:handNumber?sync=1`
- `GET /hand-reports/table/:tablePda`

Players and leaderboards:

- `GET /player/:wallet/stats`
- `GET /player/:wallet/recent-hands`
- `GET /player/:wallet/hand-reports`
- `GET /player/:wallet/earnings`
- `GET /player/:wallet/pnl-series`
- `GET /player/:wallet/active-tables`
- `GET /player/:wallet/tables`
- `GET /player/:wallet/tournaments`
- `GET /leaderboard`

Tournaments, rake, protocol totals:

- `GET /tournaments`
- `GET /tournaments/:tablePda`
- `GET /rake-ledger/:tablePda`
- `GET /protocol-stats`

Jackpots:

- `GET /jackpots/recent`
- `GET /jackpots/hand/:tablePda/:handNumber`
- `GET /jackpots/wallet/:wallet`
- `GET /jackpots/leaderboard`

WebSocket:

- `ws://localhost:3001/ws`
- Subscribe with `{"op":"sub","topic":"sng_pools"}`.
- Supported topics: `sng_pools`, `listed_tokens`, `jackpot_receipt`.

## Client Wiring

For `Frontend` node mode:

```bash
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

For a public deployment, `NEXT_PUBLIC_INDEXER_WS_URL` must be reachable by the end
user's browser, for example `wss://your-domain.example/ws`. Rebuild the client after
changing `NEXT_PUBLIC_*` values.

## Validation

```bash
npm run typecheck
```

For a live smoke test, run MongoDB, start the indexer, then check:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/tables/live
curl http://localhost:3001/protocol-stats
```

## Source Release Hygiene

Ship source files, `package.json`, `package-lock.json`, and docs. Do not ship
`node_modules`, `.env`, logs, runtime data, local database files, or generated output.
