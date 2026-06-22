import { connect, close as closeDb, loadCursor } from './db.ts';
import { ensureIndexes } from './schema.ts';
import { backfill } from './backfill.ts';
import { recoverJackpotsAndReports } from './recover.ts';
import { startLiveTail } from './live.ts';
import { startServer } from './server.ts';
import { config } from './config.ts';
import { startTableStatsLoop, stopTableStatsLoop } from './domains/table-stats.ts';
import { startHandReportCrawlerLoop, stopHandReportCrawlerLoop } from './domains/hand-report-crawler.ts';
import { initL1Stream } from './ingest/l1-stream.ts';
import { startSngPoolsCache, stopSngPoolsCache } from './domains/sng-pools.ts';
import { startTokenRegistryCache, stopTokenRegistryCache } from './domains/token-registry.ts';
import { startTablesCache, stopTablesCache } from './domains/tables.ts';
import { attachWsGateway } from './ws-gateway.ts';
import { startTokenMintBackfillLoop } from './backfill-token-mints.ts';

async function main(): Promise<void> {
  console.log('[indexer] starting up');
  console.log(`[indexer] RPC:     ${config.rpc.url.replace(/api-key=[^&]+/, 'api-key=***')}`);
  console.log(`[indexer] Mongo:   ${config.mongo.uri.replace(/\/\/[^@]+@/, '//<redacted>@')}/${config.mongo.db}`);
  console.log(`[indexer] Program: ${config.program.id}`);

  await connect();
  await ensureIndexes();

  // Start live tail + HTTP server immediately so the service is responsive
  // even while a long backfill is running. The backfill runs in parallel;
  // event ordering stays correct because handlers are idempotent upserts.
  const unsubscribe = await startLiveTail();
  const httpServer = startServer();
  const stopWs = attachWsGateway(httpServer);

  // Push-based ingest for global account snapshots. The L1Stream singleton
  // owns one gRPC subscription to Helius LaserStream; domain modules register
  // the accounts they care about via stream.watch() inside their start* funcs.
  // If HELIUS_API_KEY or LASERSTREAM_ENDPOINT is unset, the stream is inert
  // and domains fall back to their safety-net polls.
  const l1Stream = initL1Stream({
    apiKey: config.laserstream.apiKey,
    endpoint: config.laserstream.endpoint,
  });
  void l1Stream.start();

  // Live protocol account caches: SNG pools, listed-token registry, and table
  // accounts. They reduce repeated RPC scans but remain read-only indexes.
  startSngPoolsCache();
  startTokenRegistryCache();
  startTablesCache();

  startTableStatsLoop();
  startHandReportCrawlerLoop();

  // Heals tables that landed in mongo without a tokenMint (e.g. the inline
  // enrich in applyTableCreated failed or raced a downstream event). Without
  // this sweep, cashout/buyin/prize handlers default the missing mint to SOL,
  // and $FP/$USDC amounts leak into players.totalWinnings (which the bot's
  // leaderboard surfaces as SOL). Each tick is a no-op unless there's a ghost.
  startTokenMintBackfillLoop(300);

  const cur = await loadCursor();
  const tag = cur.backfillCompletedAt ? 'catch-up' : 'initial';
  console.log(`[indexer] ${tag} backfill (cursor=${cur.lastIndexedSignature?.slice(0, 8) ?? 'none'})`);
  // Fire-and-await with error containment — a failed backfill must not
  // crash the server. Live tail keeps going regardless.
  backfill().catch(err => {
    console.error('[indexer] backfill failed:', err instanceof Error ? err.message : err);
  });

  // One-shot recovery sweep (RECOVER_LOOKBACK_HOURS>0). Re-ingests jackpot
  // receipts + hand-report chunks the live tail dropped before the HandSettled
  // gating fix. Cursor-ignoring + idempotent + no event replay, so it's safe to
  // run alongside the catch-up backfill. Off by default.
  if (config.recover.lookbackHours > 0) {
    console.log(`[indexer] recovery sweep enabled (RECOVER_LOOKBACK_HOURS=${config.recover.lookbackHours})`);
    recoverJackpotsAndReports(config.recover.lookbackHours).catch(err => {
      console.error('[indexer] recovery sweep failed:', err instanceof Error ? err.message : err);
    });
  }

  const shutdown = async (signal: string) => {
    console.log(`[indexer] ${signal} received, shutting down`);
    try { await unsubscribe(); } catch {}
    try { stopWs(); } catch {}
    try { httpServer.close(); } catch {}
    try { stopSngPoolsCache(); } catch {}
    try { stopTokenRegistryCache(); } catch {}
    try { stopTablesCache(); } catch {}
    try { stopTableStatsLoop(); } catch {}
    try { stopHandReportCrawlerLoop(); } catch {}
    try { l1Stream.stop(); } catch {}
    try { await closeDb(); } catch {}
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  console.error('[indexer] fatal:', e);
  process.exit(1);
});
