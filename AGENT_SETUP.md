# Agent Setup Runbook

Use this file with Codex, Claude, or another coding agent when you want help
installing, configuring, or verifying the public indexer source release.

## Agent Prompt

Copy this into your agent:

```text
You are helping me run the FastPoker public indexer source release.

This package is a read-only protocol indexer. It stores chain-derived data in
MongoDB. MongoDB is required. SQLite is not supported in this release.

Do this:
1. Verify Node 20+ is available.
2. Verify MongoDB is available or help me point MONGO_URI at my hosted MongoDB.
3. Run npm ci.
4. Copy .env.example to .env if it does not exist.
5. Help me set:
   - MONGO_URI
   - MONGO_DB
   - RPC_URL using a paid/dedicated Solana mainnet RPC
   - RPC_WS_URL if my provider has a separate websocket URL
   - STREAM_PROVIDER, STREAM_ENDPOINT, STREAM_API_KEY for production FULL/live mode
   - PROGRAM_ID
   - INDEXER_PORT
6. Run npm run typecheck.
7. Start the indexer with npm run start.
8. Smoke test:
   - curl http://localhost:3001/health
   - curl http://localhost:3001/tables/live
   - curl http://localhost:3001/protocol-stats

Do not use public/free Solana RPC for production. A free Helius key may be used
only for a local smoke test. Provider limits and plan names change; production
FULL/live indexing requires paid/dedicated RPC and a LaserStream/Geyser-compatible
stream endpoint plus API key. Do not add Docker or IPFS setup. Do not commit .env,
node_modules, logs, local database files, key material, or generated output.
```

## Human Checklist

Install and configure:

```bash
npm ci
cp .env.example .env
```

Required `.env` values:

```bash
MONGO_URI=mongodb://localhost:27017
MONGO_DB=fastpoker_indexer
RPC_URL=https://your-dedicated-mainnet-rpc.example
RPC_WS_URL=wss://your-dedicated-mainnet-rpc-websocket.example
PROGRAM_ID=PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn
INDEXER_PORT=3001
```

Required for production FULL/live indexing:

```bash
STREAM_PROVIDER=laserstream
STREAM_ENDPOINT=https://your-laserstream-geyser-endpoint.example
STREAM_API_KEY=YOUR_STREAM_KEY
```

If `STREAM_ENDPOINT` and `STREAM_API_KEY` are blank, the raw table/SNG caches run
from seeded/polled RPC reads. That can work only for local development or smoke
tests; it can lag and should not be presented as production-live FULL mode.

Validate and run:

```bash
npm run typecheck
npm run start
```

Historical catch-up:

```bash
npm run backfill
```

Frontend wiring:

```bash
NEXT_PUBLIC_ENABLE_INDEXER=true
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```
