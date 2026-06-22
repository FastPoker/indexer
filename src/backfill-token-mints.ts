// One-shot + periodic sweep: find tables with missing tokenMint, infer from
// chain via fetchTableMetadata, propagate to earnings rows, recompute affected
// players. Idempotent — safe to run repeatedly.
//
// Background: TableCreated handler tries to enrich tokenMint via getAccountInfo
// inline. If that call errors / 429s / races a downstream event, the table doc
// can land with tokenMint missing. Every subsequent cashout/buyin/prize then
// hits normalizeTokenMint(undefined) → 'SOL', and the player's totalWinnings
// aggregate (which is SOL-only) ends up summing $FP/$USDC amounts as if they
// were SOL. This sweep heals the data without re-streaming.

import { Connection } from '@solana/web3.js';
import { tables, earnings, players } from './db.ts';
import { fetchTableMetadata } from './table-parser.ts';
import { config } from './config.ts';
import { log } from './logger.ts';
import { recomputePlayerAggregates } from './handlers.ts';

const SOL_SENTINEL = '11111111111111111111111111111111';

/**
 * Find tables where tokenMint is missing (null, undefined, or absent field),
 * fetch their metadata on-chain, write the correct tokenMint + sibling
 * fields, then patch the earnings rows and recompute every affected player.
 *
 * Returns counts so callers can log progress.
 */
export async function backfillMissingTokenMints(): Promise<{
  ghostTables: number;
  enriched: number;
  earningsPatched: number;
  playersRecomputed: number;
  unreachable: number;
}> {
  const conn = new Connection(config.rpc.url, 'confirmed');
  const ghosts = await tables()
    .find(
      { $or: [{ tokenMint: { $exists: false } }, { tokenMint: null as never }] },
      { projection: { _id: 1 } },
    )
    .toArray();

  log.info({ count: ghosts.length }, '[backfill-mints] starting sweep');

  let enriched = 0;
  let earningsPatched = 0;
  let unreachable = 0;
  const affectedPlayers = new Set<string>();

  for (const t of ghosts) {
    const tablePk = t._id as string;
    let meta;
    try {
      meta = await fetchTableMetadata(conn, tablePk);
    } catch (err) {
      log.warn({ err, tablePk }, '[backfill-mints] fetchTableMetadata threw');
      meta = null;
    }
    if (!meta) {
      // Table account gone (closed + rent reclaimed). Can't recover the mint
      // from chain at this point. Mark as UNREACHABLE so we don't keep
      // retrying, and exclude its earnings from SOL aggregates.
      unreachable += 1;
      await tables().updateOne({ _id: tablePk }, { $set: { tokenMint: 'UNKNOWN' } });
      const updated = await earnings().updateMany(
        { table: tablePk, tokenMint: 'SOL' },
        { $set: { tokenMint: 'UNKNOWN' } },
      );
      earningsPatched += updated.modifiedCount;
      const dirty = await earnings().distinct('player', { table: tablePk });
      for (const p of dirty) affectedPlayers.add(p as string);
      continue;
    }

    const tokenMint = meta.tokenMint ?? SOL_SENTINEL;
    await tables().updateOne(
      { _id: tablePk },
      {
        $set: {
          gameType: meta.gameType,
          tier: meta.tier,
          entryAmount: meta.entryAmount,
          feeAmount: meta.feeAmount,
          tokenMint,
          rakeCap: meta.rakeCap,
          isPrivate: meta.isPrivate,
          isUserCreated: meta.isUserCreated,
          creator: meta.creator,
          buyInType: meta.buyInType,
        },
      },
    );
    enriched += 1;

    // Patch earnings rows for this table that were written with the wrong
    // (defaulted-to-SOL) tokenMint. We only update rows currently marked SOL
    // — rows that already have a real mint were correct.
    const truth = tokenMint === SOL_SENTINEL ? 'SOL' : tokenMint;
    if (truth !== 'SOL') {
      const updated = await earnings().updateMany(
        { table: tablePk, tokenMint: 'SOL' },
        { $set: { tokenMint: truth } },
      );
      earningsPatched += updated.modifiedCount;
    }
    const dirty = await earnings().distinct('player', { table: tablePk });
    for (const p of dirty) affectedPlayers.add(p as string);
  }

  // Recompute every player that touched a fixed table. recomputePlayerAggregates
  // is the same function the event handlers call, so it produces the correct
  // SOL-only totalWinnings now that earnings rows are properly labeled.
  let playersRecomputed = 0;
  for (const wallet of affectedPlayers) {
    try {
      await recomputePlayerAggregates(wallet);
      playersRecomputed += 1;
    } catch (err) {
      log.warn({ err, wallet }, '[backfill-mints] recompute failed');
    }
  }

  log.info(
    { ghostTables: ghosts.length, enriched, unreachable, earningsPatched, playersRecomputed },
    '[backfill-mints] sweep done',
  );

  return {
    ghostTables: ghosts.length,
    enriched,
    earningsPatched,
    playersRecomputed,
    unreachable,
  };
}

/**
 * Run the sweep every `intervalSec`. Designed to be fire-and-forget from
 * src/index.ts startup. Each tick is a no-op if nothing is missing, so the
 * steady-state cost is just one mongo COUNT.
 */
export function startTokenMintBackfillLoop(intervalSec: number = 300): NodeJS.Timeout {
  // Kick off one sweep at startup, then on the interval.
  void (async () => {
    try { await backfillMissingTokenMints(); } catch (err) {
      log.warn({ err }, '[backfill-mints] startup sweep failed');
    }
  })();
  return setInterval(() => {
    void (async () => {
      try { await backfillMissingTokenMints(); } catch (err) {
        log.warn({ err }, '[backfill-mints] periodic sweep failed');
      }
    })();
  }, intervalSec * 1000);
}
