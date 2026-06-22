---
name: fastpoker-Indexer-setup
description: Run, verify, publish, or troubleshoot the FastPoker standalone source-code indexer. Use when an agent is asked to set up the indexer repo, wire MongoDB/RPC/LaserStream, explain the read API, connect it to Frontend, validate a source release, or keep the indexer stripped to chain-derived data only.
---

# FastPoker Indexer Standalone Setup

## Core Stance

Treat this package as a source-code release of the protocol read indexer. Keep it
separate from `Frontend`. Keep it focused on chain-derived indexed data
and read APIs.

Do not reintroduce frontend-owned identity features, table-name mutation, XP,
synced preferences, admin dashboards, incident repair scripts, or packaged
backend assumptions unless the user explicitly asks.

Use these repo docs as source of truth:

- `README.md` for setup, env, endpoint inventory, and source hygiene.
- `AGENTS.md` / `CLAUDE.md` for repo-local agent rules.

## Run From Source

```bash
npm ci
cp .env.example .env
npm run backfill
npm run start
```

Default HTTP server: `http://localhost:3001`.
Default WebSocket path: `ws://localhost:3001/ws`.

## Required Config

Set these in `.env`:

```bash
MONGO_URI=mongodb://localhost:27017
MONGO_DB=fastpoker_indexer
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
HELIUS_API_KEY=YOUR_KEY
LASERSTREAM_ENDPOINT=https://laserstream-mainnet-ewr.helius-rpc.com
PROGRAM_ID=PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn
INDEXER_PORT=3001
```

LaserStream is optional for local experiments, but production-quality live updates
need it.

## Client Wiring

For `Frontend` node mode:

```bash
INDEXER_BASE_URL=http://localhost:3001
NEXT_PUBLIC_INDEXER_WS_URL=ws://localhost:3001/ws
```

For public deployments, `NEXT_PUBLIC_INDEXER_WS_URL` must be browser-reachable and
the client must be rebuilt after changing it.

## Validation

```bash
npm run typecheck
```

Runtime smoke checks require MongoDB and RPC:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/tables/live
curl http://localhost:3001/protocol-stats
```

## Source Hygiene

Do not commit or ship `.env`, `node_modules/`, logs, runtime data, key material,
local DB files, or generated output.
