import { PublicKey } from '@solana/web3.js';
import { config } from './config.ts';
import { iterateTransactionsForAddress } from './lib/helius-tx.ts';
import { ingestHandReportChunksFromTx } from './hand-reports.ts';
import { extractJpv1FromTx, ingestJackpotReceipts } from './domains/jackpots.ts';

/**
 * One-off recovery for jackpot receipts + hand-report chunks (dealer
 * attribution) that the live tail dropped while it gated extraction on the
 * HandSettled event (SNG settle paths write the JPV1 memo / HRV1 NOOP chunks on
 * txs that don't emit HandSettled). The live tail now triggers on those markers
 * directly, but already-passed txs need a re-walk.
 *
 * Unlike backfill() this:
 *   - IGNORES the cursor. The live tail has already advanced it past the gap, so
 *     a normal backfill stops immediately and recovers nothing.
 *   - DOES NOT call applyEvent. Career-stat increments are not idempotent, so
 *     replaying events over already-indexed txs would double-count. Jackpot
 *     receipts (upsert by table:handNumber) and hand-report chunks (upsert by
 *     content hash) ARE idempotent, so this is safe to run any number of times.
 *
 * Assumes the DB is already connected (the caller owns the connection lifecycle,
 * same contract as backfill()).
 */
export async function recoverJackpotsAndReports(hours: number): Promise<{ scanned: number; jackpotReceipts: number }> {
  const cutoffSec = hours > 0 ? Math.floor(Date.now() / 1000) - hours * 3600 : 0;
  const programId = new PublicKey(config.program.id).toBase58();

  console.log(`[recover] rescanning last ${hours}h for JPV1 receipts + HRV1 chunks (cursor ignored, no event replay)`);

  const filters: Parameters<typeof iterateTransactionsForAddress>[1]['filters'] = {};
  if (cutoffSec > 0) filters.blockTime = { gte: cutoffSec };

  const pages = iterateTransactionsForAddress(config.rpc.url, {
    address: programId,
    transactionDetails: 'full',
    sortOrder: 'desc',
    commitment: 'confirmed',
    filters,
  });

  let scanned = 0;
  let jackpotReceipts = 0;

  outer: for await (const txs of pages) {
    if (txs.length === 0) break;
    for (const tx of txs) {
      const sigStr: string | undefined = tx?.transaction?.signatures?.[0];
      const slot: number = Number(tx?.slot ?? 0);
      const blockTime: number | null = typeof tx?.blockTime === 'number' ? tx.blockTime : null;
      if (!sigStr) continue;
      if (cutoffSec > 0 && blockTime !== null && blockTime < cutoffSec) break outer;
      if (tx?.meta?.err) continue;

      scanned += 1;
      try {
        await ingestHandReportChunksFromTx(tx, sigStr, slot, blockTime ?? 0);
        const receipts = extractJpv1FromTx(tx);
        if (receipts.length > 0) {
          await ingestJackpotReceipts(receipts);
          jackpotReceipts += receipts.length;
        }
      } catch (e) {
        console.warn(`[recover] tx ${sigStr} failed:`, e instanceof Error ? e.message : e);
      }

      if (scanned % 500 === 0) {
        console.log(`[recover] scanned=${scanned} jackpotReceipts=${jackpotReceipts}`);
      }
    }
  }

  console.log(`[recover] done. scanned=${scanned} jackpotReceipts=${jackpotReceipts}`);
  return { scanned, jackpotReceipts };
}
