# FastPoker Indexer Public

A source-code release of the FastPoker protocol read indexer. It subscribes to
FastPoker program activity, reconstructs chain-derived data, stores it in MongoDB,
and serves read-only HTTP/WebSocket APIs for clients that want history, table
discovery, leaderboards, jackpot receipts, and SNG state.

This package is intentionally separate from `Frontend`. Users can run the
client without this indexer. Users who want the FULL read experience can run this
indexer as a normal Node process beside any frontend, script, or service they choose.

## Requirements

- Node 20+.
- MongoDB that you run locally or rent through a hosted service such as MongoDB
  Atlas.
- A paid/dedicated Solana mainnet RPC endpoint. Do not use public/free Solana
  RPC for this indexer.
- Stream provider for production FULL/live indexing. The bundled adapter is
  LaserStream/Geyser-compatible, while `RPC_URL` itself is provider-neutral.
  Leaving stream config blank is for local smoke tests only.

MongoDB is the only supported database in this release. SQLite is not supported.

## What It Indexes

- Program event backfill and live tail.
- MongoDB collections for `tables`, `hands`, `hand_reports`, `players`, `earnings`,
  `rake_ledger`, `tournaments`, `jackpot_receipts`, and cursor state.
- HRV1 hand-report chunk reconstruction.
- JPV1 jackpot receipt ingestion.
- SNG pool, listed-token, and raw table-account read caches.
- Table stats derived from indexed hand reports.
- Read-only HTTP APIs and anonymous WebSocket topics.

## What It Does Not Do

- It does not sign transactions or hold keys.
- It does not replace the FastPoker frontend.
- It does not provide user accounts, email login, profile preferences, or a
  private identity database.
- It does not run dealer/crank services.
- It does not require Docker, IPFS, or a fixed process manager.

## Quick Start

Do not point this indexer at the public/free Solana RPC. It performs historical
transaction backfills, account reads, WebSocket subscriptions, and safety reseeds;
free endpoints will rate-limit, drop subscriptions, or return incomplete data.
Use a keyed provider such as Helius, QuickNode, Triton, Alchemy, Syndica, or your
own Solana RPC infrastructure. A stream provider is required for production
FULL/live indexer mode; the bundled stream adapter is LaserStream/Geyser-compatible,
but `RPC_URL` itself is provider-neutral.

### Streaming requirement

For production FULL mode, run this indexer with both:

- `RPC_URL` / `RPC_WS_URL` for history, account reads, backfill, repair, and
  safety reseeds.
- `STREAM_PROVIDER`, `STREAM_ENDPOINT`, and `STREAM_API_KEY` for live account
  updates.

The indexer can start without stream settings for local development, but that is
seeded/polled mode. It is not production-live and can show stale table/SNG cache
data.

### Helius free-tier note

A free Helius key can be useful for local smoke tests, but it is not enough to
certify this indexer as production-live. Current Helius docs list the free plan
at 1M credits/month, 10 RPC requests/second, 5 `getProgramAccounts`/second,
1 `sendTransaction`/second, standard LaserStream WebSocket methods, and no
mainnet LaserStream gRPC. This indexer currently supports the
LaserStream/Geyser-compatible stream path through `STREAM_ENDPOINT` and
`STREAM_API_KEY`. If those are blank, raw table/SNG caches are seeded and
periodically reseeded through RPC rather than fed by a live gRPC stream.

That seeded mode can run for development, but it can lag. A frontend using a
seeded/non-streaming indexer should treat delegated table account bytes as table
discovery data, not authoritative live occupancy; the public frontend overlays
delegated cash-table state from TEE before counting players online.

```bash
npm ci
cp .env.example .env
# edit .env: set MONGO_URI, RPC_URL, and STREAM_* for production FULL mode
npm run start
```

Start after MongoDB is reachable and `RPC_URL` is set to a paid/dedicated mainnet
endpoint. By default the server listens on `http://localhost:3001`. Run
`npm run backfill` when you want a historical catch-up pass before or after
starting the live indexer.

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
bundled LaserStream/Geyser-compatible account stream. They are required for
production FULL/live indexing. They may be left blank only for local smoke tests,
where caches rely on slower safety reads over your RPC quota and can lag.
`LASERSTREAM_ENDPOINT`, `LASERSTREAM_API_KEY`, and `HELIUS_API_KEY` remain accepted
as backward-compatible aliases, but new deployments should prefer the `STREAM_*`
names.

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
NEXT_PUBLIC_ENABLE_INDEXER=true
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

For a public deployment, `NEXT_PUBLIC_INDEXER_WS_URL` must be reachable by the end
user's browser, for example `wss://your-domain.example/ws`. Rebuild the client after
changing `NEXT_PUBLIC_*` values.

## Agent-Assisted Setup

If you want Codex, Claude, or another coding agent to install and verify this
package, point it at [AGENT_SETUP.md](./AGENT_SETUP.md). That file gives the agent
the MongoDB/RPC requirements, exact env fields, validation commands, and frontend
wiring.

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
