# FastPoker Indexer Standalone Claude Guide

This package is a source-code release of the FastPoker protocol read indexer.
Keep it focused on chain-derived data and read APIs.

Do not add frontend-owned identity features, table-name mutation, XP, synced
preferences, admin dashboards, incident repair scripts, or packaged backend
instructions unless the user explicitly asks.

## Run

```bash
npm ci
cp .env.example .env
npm run backfill
npm run start
```

## Validate

```bash
npm run typecheck
```

Runtime checks need MongoDB and RPC:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/tables/live
curl http://localhost:3001/protocol-stats
```

Never commit `.env`, `node_modules/`, logs, runtime data, key material, local DB
files, or generated output.
