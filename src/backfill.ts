import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.ts';
import { decodeLogs } from './events.ts';
import { findCashoutTableInTx } from './tx-utils.ts';
import { applyEvent, EventContext } from './handlers.ts';
import { loadCursor, saveCursor } from './db.ts';
import { ingestHandReportChunksFromTx } from './hand-reports.ts';
import { extractJpv1FromTx, ingestJackpotReceipts } from './domains/jackpots.ts';
import { iterateTransactionsForAddress } from './lib/helius-tx.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk program TX history backward to the lookback cutoff or the last indexed
 * signature, whichever comes first.
 *
 * Was: getSignaturesForAddress page (1 credit) + per-sig getTransaction (1 credit
 * each, serial, 100ms throttle). 1000 txs = ~1,001 credits + 1,001 round-trips.
 *
 * Now: Helius getTransactionsForAddress in full mode. 1000 txs = 100 credits,
 * ONE round-trip per page. ~10× cheaper, ~100× faster wall-clock on backfill.
 *
 * The throttle is preserved as a tiny inter-page sleep so we don't pin the
 * upstream during long catch-ups. JPV1 jackpot ingest is folded in here so the
 * SQLite-era jackpot indexer's backfill behavior is preserved automatically.
 */
export async function backfill(): Promise<{ processed: number; lastSig: string | null }> {
  const programId = new PublicKey(config.program.id);
  const cursor = await loadCursor();
  const cutoffMs = config.backfill.lookbackHours > 0
    ? Date.now() - config.backfill.lookbackHours * 3600_000
    : 0;
  const cutoffSec = cutoffMs > 0 ? Math.floor(cutoffMs / 1000) : 0;

  let processed = 0;
  let newestSig: string | null = null;
  let stopReason = '';

  // Build the per-page filter. We always sort desc (newest → oldest) so we can
  // bail on either the previous cursor or the lookback cutoff without paging
  // past it. blockTime filter is a server-side speedup; we still verify on the
  // client per-tx in case the server returns adjacent txs.
  // Skip the status filter — failed txs are cheap to filter client-side via
  // `tx.meta.err` below, and the server-side filter syntax has been flaky.
  const filters: Parameters<typeof iterateTransactionsForAddress>[1]['filters'] = {};
  if (cutoffSec > 0) filters.blockTime = { gte: cutoffSec };

  const pages = iterateTransactionsForAddress(config.rpc.url, {
    address: programId.toBase58(),
    transactionDetails: 'full',
    sortOrder: 'desc',
    commitment: 'confirmed',
    filters,
  });

  outer: for await (const txs of pages) {
    if (txs.length === 0) { stopReason = 'no-more-transactions'; break; }
    if (newestSig === null) {
      const firstSig = txs[0]?.transaction?.signatures?.[0];
      if (typeof firstSig === 'string') newestSig = firstSig;
    }

    for (const tx of txs) {
      const sigStr: string | undefined = tx?.transaction?.signatures?.[0];
      const slot: number = Number(tx?.slot ?? 0);
      const blockTime: number | null = typeof tx?.blockTime === 'number' ? tx.blockTime : null;
      if (!sigStr) continue;

      // Stop conditions — same semantics as the old loop.
      if (cursor.lastIndexedSignature && sigStr === cursor.lastIndexedSignature) {
        stopReason = 'reached-previous-cursor';
        break outer;
      }
      if (cutoffSec > 0 && blockTime !== null && blockTime < cutoffSec) {
        stopReason = 'reached-lookback-cutoff';
        break outer;
      }
      if (tx?.meta?.err) continue;

      try {
        const logs: string[] = tx?.meta?.logMessages ?? [];
        const cashoutTable = findCashoutTableInTx(tx, config.program.id);
        const events = decodeLogs(logs, { cashoutTable });
        if (events.length > 0) {
          const ctx: EventContext = {
            txSig: sigStr,
            slot,
            blockTime,
            tx,
          };
          for (const evt of events) {
            await applyEvent(evt, ctx);
          }
        }
        await ingestHandReportChunksFromTx(tx, sigStr, slot, blockTime ?? 0);
        const receipts = extractJpv1FromTx(tx);
        if (receipts.length > 0) {
          await ingestJackpotReceipts(receipts).catch((err) => {
            console.warn('[backfill] jackpot ingest failed:', err instanceof Error ? err.message : err);
          });
        }
        processed += 1;
        if (processed % 200 === 0) {
          console.log(`[backfill] processed ${processed} txs (now at slot ${slot})`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[backfill] tx ${sigStr.slice(0, 8)} decode failed: ${msg}`);
      }
    }

    // Inter-page courtesy sleep so a long catch-up doesn't pin the upstream.
    // 0 in normal operation since each call is already a single round-trip.
    if (config.backfill.throttleMs > 0) await sleep(config.backfill.throttleMs);
  }

  if (newestSig && processed > 0) {
    await saveCursor({
      lastIndexedSignature: newestSig,
      backfillCompletedAt: new Date(),
    });
  }

  console.log(`[backfill] done — processed ${processed} txs, stop reason: ${stopReason}`);
  return { processed, lastSig: newestSig };
}
