# FastPoker Indexer Standalone Agent Guide

Use this file when Codex or another agent is asked to run, modify, verify, or
publish `Indexer`.

## Project Position

- This is a source-code release of the protocol read indexer.
- Keep it separate from `Frontend`.
- Keep it focused on chain-derived indexed data and read APIs.
- Do not reintroduce frontend-owned identity features, table-name mutation, XP,
  preferences, admin dashboards, incident scripts, or packaged backend assumptions
  unless the user explicitly asks.

## Run

```bash
npm ci
cp .env.example .env
npm run backfill
npm run start
```

Server default: `http://localhost:3001`, WebSocket default: `/ws`.

## Validate

```bash
npm run typecheck
```

If runtime validation is requested, use a real MongoDB and RPC, start the indexer,
then check `/health`, `/tables/live`, and `/protocol-stats`.

## Source Hygiene

Never commit `.env`, `node_modules/`, logs, runtime data, key material, local DB
files, or generated output.
