import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.ts';
import { decodeLogs } from './events.ts';
import { findCashoutTableInTx } from './tx-utils.ts';
import { applyEvent, EventContext } from './handlers.ts';
import { saveCursor } from './db.ts';
import { ingestHandReportChunksFromTx } from './hand-reports.ts';
import { extractJpv1FromTx, ingestJackpotReceipts } from './domains/jackpots.ts';

/**
 * Subscribe to program logs over WebSocket. Emits decoded events as they
 * arrive. Automatically reconnects via web3.js's internal WS client.
 *
 * Returns an unsubscribe function.
 */
export async function startLiveTail(): Promise<() => Promise<void>> {
  const conn = new Connection(config.rpc.url, {
    commitment: 'confirmed',
    wsEndpoint: config.rpc.wsUrl,
  });
  const programId = new PublicKey(config.program.id);

  const subId = conn.onLogs(
    programId,
    async (logInfo, ctx) => {
      if (logInfo.err) return;
      // First pass: decode without accountKeys. Catches real Anchor events +
      // msg-log deposits (table is inline). Cashouts need accountKeys.
      let events = decodeLogs(logInfo.logs);
      // Second pass: if logs mention a cashout, fetch the TX once to resolve
      // the table pubkey from its ProcessCashoutV2 IX accounts. Cost: one
      // extra getTransaction per cashout TX (no cost on normal gameplay).
      const needsIxLookup = logInfo.logs.some(l => l.startsWith('Program log: Cashout processed:'));
      // Hand-report chunks (HRV1, carrying per-hand dealer/operator attribution)
      // are written as NOOP-program CPIs. They usually ride on a HandSettled tx,
      // but not always: SNG per-hand settlement and some crank paths write the
      // chunks on a tx that does not emit HandSettled. The cash-table crawler
      // only backstops cash hands, so gating live ingestion on HandSettled left
      // operatorWallets (and the dealer-hand counts derived from them) under-
      // counted for SNG. Detect the NOOP program in the logs directly so every
      // chunk-bearing tx is ingested regardless of which settle path wrote it.
      const mayCarryHandReport =
        events.some((e) => e.name === 'HandSettled') ||
        logInfo.logs.some((l) => l.includes('noopb9bkMVfRPU8'));
      // Jackpot receipts are written as a JPV1 SPL Memo CPI. They often ride on
      // a HandSettled tx, but not always: SNG settlement writes the memo on a tx
      // that does not emit HandSettled. Gating extraction on HandSettled silently
      // dropped those hits, so detect the memo in the logs directly (the Memo
      // program logs its content, so the JPV1 magic / JPV1B64: prefix shows up).
      // Catches every jackpot tx regardless of which settle path emitted it.
      const mayCarryJackpot = mayCarryHandReport || logInfo.logs.some((l) => l.includes('JPV1'));
      const mayCarryDuplicateSngCancel = events.some((e) => e.name === 'DuplicateSngTableCancelled');
      let tx: Awaited<ReturnType<Connection['getTransaction']>> | null = null;
      if (needsIxLookup || mayCarryHandReport || mayCarryJackpot || mayCarryDuplicateSngCancel) {
        try {
          tx = await conn.getTransaction(logInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          if (needsIxLookup) {
            const cashoutTable = findCashoutTableInTx(tx, config.program.id);
            events = decodeLogs(logInfo.logs, { cashoutTable });
          }
          if (mayCarryHandReport) {
            await ingestHandReportChunksFromTx(tx, logInfo.signature, ctx.slot, 0);
          }
          if (mayCarryJackpot && tx) {
            const receipts = extractJpv1FromTx(tx);
            if (receipts.length > 0) {
              await ingestJackpotReceipts(receipts).catch((err) => {
                console.warn('[live] jackpot ingest failed:', err instanceof Error ? err.message : err);
              });
            }
          }
        } catch {
          // 24h auto-sync will backfill from wallet history if we drop this.
        }
      }
      if (events.length === 0) {
        // Still advance cursor so reconcile knows we're tailing.
        return;
      }
      const evtCtx: EventContext = {
        txSig: logInfo.signature,
        slot: ctx.slot,
        // onLogs doesn't include blockTime — handlers fall back to Date.now().
        blockTime: null,
        tx,
      };
      for (const evt of events) {
        try {
          await applyEvent(evt, evtCtx);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[live] applyEvent ${evt.name} failed: ${msg}`);
        }
      }
      await saveCursor({
        lastIndexedSignature: logInfo.signature,
        lastIndexedSlot: ctx.slot,
      });
    },
    'confirmed',
  );

  console.log(`[live] subscribed to logs for program ${config.program.id} (subId=${subId})`);

  return async () => {
    try {
      await conn.removeOnLogsListener(subId);
    } catch {}
  };
}
