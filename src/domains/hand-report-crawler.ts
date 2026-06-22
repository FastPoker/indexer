/**
 * Hand-report ingestion crawler.
 *
 * The crank flushes HAND_REPORT_V1 chunks on-chain for every settled hand,
 * and `syncTableHandReports` can decode them into the `hand_reports`
 * collection -- but nothing scheduled it for live cash tables, so the
 * collection stayed empty and the lobby's Avg Pot / VPIP / Hnd-Hr columns
 * (which the table-stats domain aggregates from `hand_reports`) rendered `·`.
 *
 * This loop closes that gap: every tick it lists live cash tables (the same
 * `{ isClosed: false, gameType: 3 }` set the lobby renders) and ingests any
 * new chunks. It keeps an in-memory per-table cursor (newest ingested
 * signature) so steady-state ticks only scan signatures added since the last
 * pass; the first sighting of a table scans deeper to backfill recent hands.
 * Upserts are idempotent (`_id = table:handNumber`), so a re-scan is harmless.
 *
 * Cost is bounded: <= MAX_TABLES tables, CONCURRENCY at a time, and after the
 * first pass each table is ~1 getSignaturesForAddress + 1 batched
 * getTransaction per tick (often zero new sigs).
 */
import { Connection } from '@solana/web3.js';
import { config } from '../config.ts';
import { log } from '../logger.ts';
import { tables } from '../db.ts';
import { syncTableHandReports } from '../hand-reports.ts';

const TICK_MS = 2 * 60 * 1000;   // crawl cadence (stats cache refreshes every 5 min)
const CONCURRENCY = 4;           // tables synced in parallel per batch
const MAX_TABLES = 120;          // safety cap on tables crawled per tick
const CASH_GAME_TYPE = 3;        // GameType::CashGame
const BACKFILL_PAGES = 6;        // pages on first sighting of a table
const INCREMENTAL_PAGES = 3;     // pages once we have a cursor (until short-circuits)

// table pubkey -> newest signature already ingested. In-memory: on restart the
// first tick falls back to a (bounded) backfill scan, then goes incremental.
const cursor = new Map<string, string>();

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let conn: Connection | null = null;
let running = false;

async function crawlOnce(): Promise<void> {
  if (running || !conn) return; // skip if a prior tick is still in flight
  running = true;
  const startedAt = Date.now();
  try {
    const docs = await tables()
      .find({ isClosed: { $ne: true }, gameType: CASH_GAME_TYPE }, { projection: { _id: 1 } })
      .sort({ createdAt: -1 })
      .limit(MAX_TABLES)
      .toArray();
    const pdas = docs.map((d) => d._id);
    if (pdas.length === 0) return;

    let indexed = 0;
    let scanned = 0;
    const active = new Set(pdas);
    for (let i = 0; i < pdas.length; i += CONCURRENCY) {
      const batch = pdas.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (pda) => {
          const until = cursor.get(pda);
          const r = await syncTableHandReports(conn!, pda, {
            maxPages: until ? INCREMENTAL_PAGES : BACKFILL_PAGES,
            until,
          }).catch((e) => {
            log.warn(`[hand-report-crawler] sync ${pda.slice(0, 8)} failed: ${(e as Error).message}`);
            return null;
          });
          if (r?.newestSig) cursor.set(pda, r.newestSig);
          return r ?? { scanned: 0, indexed: 0 };
        }),
      );
      for (const r of results) { indexed += r.indexed; scanned += r.scanned; }
    }

    // Forget cursors for tables that are no longer live so the map can't grow
    // without bound as tables close.
    for (const key of cursor.keys()) if (!active.has(key)) cursor.delete(key);

    if (indexed > 0 || scanned > 0) {
      log.info(`[hand-report-crawler] ${pdas.length} cash tables, scanned ${scanned}, ingested ${indexed} chunks (${Date.now() - startedAt}ms)`);
    }
  } catch (e) {
    log.warn(`[hand-report-crawler] tick failed: ${(e as Error).message}`);
  } finally {
    running = false;
  }
}

export function startHandReportCrawlerLoop(): void {
  if (intervalHandle !== null) return;
  conn = new Connection(config.rpc.url, 'confirmed');
  void crawlOnce();
  intervalHandle = setInterval(() => { void crawlOnce(); }, TICK_MS);
  log.info(`[hand-report-crawler] started (${TICK_MS / 1000}s, concurrency ${CONCURRENCY})`);
}

export function stopHandReportCrawlerLoop(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  conn = null;
  cursor.clear();
}
