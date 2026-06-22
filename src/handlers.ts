import { Connection, PublicKey } from '@solana/web3.js';
import {
  tables, hands, players, earnings, rakeLedger, tournaments, handReports,
  TableDoc,
} from './db.ts';
import { DecodedEvent } from './events.ts';
import { fetchTableMetadata } from './table-parser.ts';
import { config } from './config.ts';
import { extractNativeBalanceDeltas } from './tx-utils.ts';

// Single shared RPC connection for on-demand metadata enrichment. Reused
// across events; respectful of RPC budget because it's one call per new
// table, not per user per page-load.
let enrichConn: Connection | null = null;
function getEnrichConn(): Connection {
  if (!enrichConn) enrichConn = new Connection(config.rpc.url, 'confirmed');
  return enrichConn;
}

const SOL_SENTINEL = '11111111111111111111111111111111';
function normalizeTokenMint(mint?: string | null): string {
  return !mint || mint === SOL_SENTINEL ? 'SOL' : mint;
}

const SNG_SEATS_BY_GAMETYPE: Record<number, number> = { 0: 2, 1: 6, 2: 9 };
const SNG_ENTRY_BY_TIER: Record<number, number> = {
  0: 0,                 // Copper/Micro: fee-only, no SOL prize pool
  1: 50_000_000,
  2: 200_000_000,
  3: 450_000_000,
  4: 900_000_000,
  5: 1_800_000_000,
  6: 4_500_000_000,
};
const SNG_TOTAL_BUYIN_TO_ENTRY = new Map<number, number>([
  [50_000_000, 0],
  [100_000_000, 50_000_000],
  [250_000_000, 200_000_000],
  [500_000_000, 450_000_000],
  [1_000_000_000, 900_000_000],
  [2_000_000_000, 1_800_000_000],
  [5_000_000_000, 4_500_000_000],
]);

/**
 * Convert an Anchor-decoded field to a plain representation.
 * Anchor returns PublicKey objects, BN for u64/i64, and byte arrays as number[].
 */
function pubkey(v: unknown): string {
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'toBase58' in v) {
    return (v as { toBase58: () => string }).toBase58();
  }
  throw new Error(`Not a pubkey: ${String(v)}`);
}

function bigNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object' && 'toNumber' in v) {
    return (v as { toNumber: () => number }).toNumber();
  }
  if (v && typeof v === 'object' && 'toString' in v) {
    return Number((v as { toString: () => string }).toString());
  }
  return Number(v);
}

function bytesHex(v: unknown): string {
  const arr = v as number[];
  return Buffer.from(arr).toString('hex');
}

export interface EventContext {
  txSig: string;
  slot: number;
  blockTime: number | null;            // unix seconds
  tx?: unknown;                         // optional full tx metadata for balance-delta handlers
}

/**
 * Route a single decoded event to the right collection writer.
 * Each handler is idempotent — safe to replay during backfill or reconcile.
 */
export async function applyEvent(evt: DecodedEvent, ctx: EventContext): Promise<void> {
  const when = ctx.blockTime ? new Date(ctx.blockTime * 1000) : new Date();
  switch (evt.name) {
    case 'TableCreated':        return applyTableCreated(evt.data, ctx, when);
    case 'TableClosed':         return applyTableClosed(evt.data, ctx, when);
    case 'PlayerJoined':        return applyPlayerJoined(evt.data, ctx, when);
    case 'PlayerLeft':          return applyPlayerLeft(evt.data, ctx, when);
    case 'HandSettled':         return applyHandSettled(evt.data, ctx, when);
    case 'PlayerRegistered':    return applyPlayerRegistered(evt.data, ctx, when);
    case 'PrizesDistributed':   return applyPrizesDistributed(evt.data, ctx, when);
    case 'RakeDistributed':     return applyRakeDistributed(evt.data, ctx, when);
    case 'SngPartialPlayerRefunded': return applySngPartialPlayerRefunded(evt.data, ctx, when);
    case 'DuplicateSngTableCancelled': return applyDuplicateSngTableCancelled(evt.data, ctx, when);
    case 'FailedDepositRefunded': return applyFailedDepositRefunded(evt.data, ctx, when);
    default:                    return;
  }
}

// ─── TableCreated ──────────────────────────────────────────────────────

async function applyTableCreated(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const doc: Partial<TableDoc> = {
    _id: tablePk,
    tableId: bytesHex(data.table_id),
    authority: pubkey(data.authority),
    maxPlayers: Number(data.max_players),
    smallBlind: bigNum(data.small_blind),
    bigBlind: bigNum(data.big_blind),
    isClosed: false,
    createdAt: when,
    createTxSig: ctx.txSig,
    players: [],
    lastUpdatedSlot: ctx.slot,
  };
  await tables().updateOne(
    { _id: tablePk },
    { $setOnInsert: doc },
    { upsert: true },
  );

  // Enrich with one-shot getAccountInfo for metadata not in the event:
  // gameType, tier, tokenMint, rakeCap, isPrivate, creator, etc. If the
  // account is already gone (race vs. close), the enrich fields stay null
  // and the lobby falls back to event-level data.
  const meta = await fetchTableMetadata(getEnrichConn(), tablePk);
  if (meta) {
    await tables().updateOne(
      { _id: tablePk },
      {
        $set: {
          gameType: meta.gameType,
          tier: meta.tier,
          entryAmount: meta.entryAmount,
          feeAmount: meta.feeAmount,
          tokenMint: meta.tokenMint,
          rakeCap: meta.rakeCap,
          isPrivate: meta.isPrivate,
          isUserCreated: meta.isUserCreated,
          creator: meta.creator,
          buyInType: meta.buyInType,
        },
      },
    );

    // For SNG tables (gameType < 3), seed/activate a tournament doc. This
    // is idempotent: replays and catch-ups produce the same state.
    if (meta.gameType < 3) {
      await tournaments().updateOne(
        { _id: tablePk },
        {
          $setOnInsert: {
            gameType: meta.gameType,
            tier: meta.tier,
            maxPlayers: meta.maxPlayers,
            entryAmount: meta.entryAmount,
            feeAmount: meta.feeAmount,
            tokenMint: meta.tokenMint,
            players: [],
            status: 'active',
            startedAt: when,
          },
        },
        { upsert: true },
      );
    }
  }
}

// ─── TableClosed ───────────────────────────────────────────────────────

async function applyTableClosed(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  await tables().updateOne(
    { _id: tablePk },
    {
      $set: {
        isClosed: true,
        finalRake: bigNum(data.final_rake),
        closedAt: when,
        closeTxSig: ctx.txSig,
        lastUpdatedSlot: ctx.slot,
      },
    },
    { upsert: true },
  );
}

// ─── PlayerJoined ──────────────────────────────────────────────────────

async function applyPlayerJoined(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const wallet = pubkey(data.player);
  const seat = Number(data.seat_number);
  const buyIn = bigNum(data.buy_in);
  // Remove any existing active seat row for (wallet, seat) first, then append.
  // Cast: Mongo v6 typings reject $pull against a typed subdoc; behavior is correct.
  await tables().updateOne(
    { _id: tablePk },
    { $pull: { players: { wallet, seat, leftAt: { $exists: false } } } } as never,
  );
  await tables().updateOne(
    { _id: tablePk },
    {
      $push: { players: { wallet, seat, joinedAt: when, buyIn } },
      $set: { lastUpdatedSlot: ctx.slot },
    },
    { upsert: true },
  );

  // Add wallet to the tournament roster (if this table is an SNG).
  // MongoDB rejects $addToSet + $setOnInsert touching the same path, so
  // `players` is omitted from $setOnInsert — $addToSet creates the array
  // on insert automatically.
  await tournaments().updateOne(
    { _id: tablePk },
    {
      $addToSet: { players: wallet },
      $setOnInsert: { status: 'active', startedAt: when, gameType: 0 },
    },
    { upsert: true },
  );

  // Look up gameType up front so we can decide whether to debit sngProfitSol
  // and whether to label the earnings row as cash_deposit or sng_buyin.
  const tableDoc = await tables().findOne({ _id: tablePk }, { projection: { gameType: 1, tokenMint: 1 } });
  const isSng = tableDoc?.gameType !== 3;

  // Token this buy-in was paid in. totalInvested and sngProfitSol are
  // SOL-DENOMINATED aggregates, so ONLY bump them for SOL tables — otherwise a
  // $FP/USDC buy-in (e.g. 200 $FP) is miscounted as that many SOL, inflating
  // totalInvested and wrecking the leaderboard's netProfitSol. sessionsPlayed is
  // token-agnostic (a session is a session) so it always increments. Mirrors the
  // SOL guard in the cashout handler; recompute already SOL-filters these.
  const tokenMint = normalizeTokenMint(tableDoc?.tokenMint);
  const isSol = tokenMint === 'SOL';
  await players().updateOne(
    { _id: wallet },
    {
      $inc: {
        sessionsPlayed: 1,
        ...(isSol ? { totalInvested: buyIn } : {}),
        ...(isSol && isSng && buyIn > 0 ? { sngProfitSol: -buyIn } : {}),
      },
      $set: { lastActive: when },
      $setOnInsert: zeroedPlayerInsert(wallet),
    },
    { upsert: true },
  );

  // Write an earnings ledger row so the profile History tab can render this
  // deposit/buy-in. Cash tables = 'cash_deposit', everything else
  // (heads-up/6max/9max SNG) = 'sng_buyin'. Idempotent via deterministic _id
  // keyed on (txSig, player, seat, kind). tokenMint computed above.
  if (buyIn > 0) {
    const kind = isSng ? 'sng_buyin' : 'cash_deposit';
    const _id = `${ctx.txSig}:${kind}:${wallet}:${seat}` as unknown as import('mongodb').ObjectId;
    await earnings().updateOne(
      { _id },
      {
        $set: {
          player: wallet,
          kind,
          table: tablePk,
          amount: buyIn,
          tokenMint,
          ts: when,
          txSig: ctx.txSig,
        },
      },
      { upsert: true },
    );
  }
}

// ─── PlayerLeft ────────────────────────────────────────────────────────

async function applyPlayerLeft(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const wallet = pubkey(data.player);
  const seat = Number(data.seat_number);
  const cashedOut = bigNum(data.chips_cashed_out);
  await tables().updateOne(
    { _id: tablePk, 'players.wallet': wallet, 'players.seat': seat, 'players.leftAt': { $exists: false } },
    {
      $set: {
        'players.$.leftAt': when,
        'players.$.cashedOut': cashedOut,
        lastUpdatedSlot: ctx.slot,
      },
    },
  );

  // Cashouts count as winnings on cash tables. An earnings ledger row
  // makes them visible in the profile "Recent earnings" list.
  // Idempotency: deterministic _id keyed on (txSig, player, seat, kind) so
  // re-running a sync or backfill upserts the same row instead of duplicating.
  if (cashedOut > 0) {
    const tableDoc = await tables().findOne({ _id: tablePk }, { projection: { tokenMint: 1 } });
    const tokenMint = normalizeTokenMint(tableDoc?.tokenMint);
    const _id = `${ctx.txSig}:cashout:${wallet}:${seat}` as unknown as import('mongodb').ObjectId;
    await earnings().updateOne(
      { _id },
      {
        $set: {
          player: wallet,
          kind: 'cashout',
          table: tablePk,
          amount: cashedOut,
          tokenMint,
          ts: when,
          txSig: ctx.txSig,
        },
      },
      { upsert: true },
    );
    if (tokenMint === 'SOL') {
      await players().updateOne(
        { _id: wallet },
        {
          $inc: { totalWinnings: cashedOut, cashNetSol: cashedOut },
          $set: { lastActive: when },
          $setOnInsert: zeroedPlayerInsert(wallet),
        },
        { upsert: true },
      );
    }
  }
}

// ─── FailedDepositRefunded ──────────────────────────────────────────────

async function applyFailedDepositRefunded(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const wallet = pubkey(data.player);
  const seat = Number(data.seat_number);
  const amount = bigNum(data.amount);
  if (amount <= 0) return;

  const _id = `${ctx.txSig}:recovery:${wallet}:${tablePk}` as unknown as import('mongodb').ObjectId;
  await earnings().updateOne(
    { _id },
    {
      $set: {
        player: wallet,
        kind: 'recovery',
        table: tablePk,
        amount,
        tokenMint: 'SOL',
        ts: when,
        txSig: ctx.txSig,
        seat,
      },
    },
    { upsert: true },
  );
  await recomputePlayerAggregates(wallet);
}

// ─── HandSettled ───────────────────────────────────────────────────────

async function applyHandSettled(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const handNumber = bigNum(data.hand_number);
  const winners = (data.winners as unknown[]).map(pubkey);
  const amounts = (data.amounts as unknown[]).map(bigNum);
  const rakeCollected = bigNum(data.rake_collected);
  await hands().updateOne(
    { _id: `${tablePk}:${handNumber}` },
    {
      $set: {
        tableId: tablePk,
        handNumber,
        winners,
        amounts,
        rakeCollected,
        settledAt: when,
        txSig: ctx.txSig,
        slot: ctx.slot,
      },
    },
    { upsert: true },
  );

  // Bump each winner's aggregates. HandSettled doesn't list seated losers,
  // so we can't maintain handsPlayed from this event alone — see v0.3 plan.
  // totalWinnings is a SOL-denominated stat, so only credit it on SOL cash
  // tables. A $FP (or USDC) hand win must NOT inflate it — that's what made the
  // leaderboard show $FP winnings as hundreds of "SOL". handsWon is token-agnostic.
  const tableDoc = await tables().findOne({ _id: tablePk }, { projection: { tokenMint: 1 } });
  const isSol = normalizeTokenMint(tableDoc?.tokenMint) === 'SOL';
  for (let i = 0; i < winners.length; i++) {
    const wallet = winners[i];
    const amount = amounts[i] ?? 0;
    const inc: Record<string, number> = { handsWon: 1 };
    if (isSol) inc.totalWinnings = amount;
    await players().updateOne(
      { _id: wallet },
      {
        $inc: inc,
        $set: { lastActive: when },
        $setOnInsert: zeroedPlayerInsert(wallet),
      },
      { upsert: true },
    );
  }
}

// ─── PlayerRegistered ──────────────────────────────────────────────────

async function applyPlayerRegistered(data: Record<string, unknown>, _ctx: EventContext, when: Date): Promise<void> {
  const wallet = pubkey(data.player);
  const ts = bigNum(data.timestamp);
  await players().updateOne(
    { _id: wallet },
    {
      $set: { registeredAt: ts > 0 ? new Date(ts * 1000) : when, lastActive: when },
      $setOnInsert: zeroedPlayerInsert(wallet),
    },
    { upsert: true },
  );
}

// ─── PrizesDistributed ─────────────────────────────────────────────────

async function applyPrizesDistributed(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const gameType = Number(data.game_type);
  const winner = pubkey(data.winner);

  // IMPORTANT: the on-chain `PrizesDistributed` event carries POKER (Raw
  // Yield, 6-dec micro-units), NOT SOL. The contract emits
  // `prize_pool: poker_pool` and per-payout `amount: poker_amounts[i]`.
  // SOL prize splits travel through direct lamport transfers in the same
  // tx and are not exposed via this event. Earlier versions of this
  // handler treated these amounts as SOL, which inflated `sngProfitSol`
  // and `totalWinnings` for every tournament finisher. Fixed here.
  const pokerPool = bigNum(data.prize_pool);
  const payouts = (data.payouts as Array<Record<string, unknown>>).map(p => ({
    wallet: pubkey(p.wallet),
    amount: bigNum(p.amount),
  }));

  // ITM count is gameType-driven and matches `SolPayoutStructure`:
  // HU=1, 6-max=2, 9-max=3. Once the non-ITM trickle ships in PR4 the
  // event's `payouts[]` will have entries beyond the ITM count — those
  // extras are flagged `nonItm: true` so they don't pollute itmCount /
  // tournamentsWon aggregates.
  const itmCount = gameType === 0 ? 1 : gameType === 1 ? 2 : gameType === 2 ? 3 : payouts.length;

  // Complete the tournament doc
  const sortedPayouts = [...payouts].map((p, i) => ({
    ...p,
    place: i + 1,
    nonItm: i + 1 > itmCount,
  }));
  await tournaments().updateOne(
    { _id: tablePk },
    {
      $set: {
        gameType,
        winner,
        pokerPool,            // POKER (Raw Yield) pool, 6-dec micro-units
        prizePool: pokerPool, // legacy alias; readers may still use it
        payouts: sortedPayouts,
        status: 'completed',
        endedAt: when,
        completeTxSig: ctx.txSig,
      },
      $setOnInsert: { startedAt: when, players: [] },
    },
    { upsert: true },
  );

  // SOL prizes are NOT in the Anchor event payload (only POKER amounts are).
  // Newer program logs include the exact "SOL pool=..." value; use that when
  // present because it is the on-chain table.prize_pool at distribution time.
  // Fallback math must use the tier's ENTRY component, never the fee-inclusive
  // sng_buyin row. Copper/Micro is intentionally fee-only: total buy-in 0.05
  // SOL, entry/prize pool 0. Treating the buy-in row as entry mints phantom
  // SOL history rows and fake "claim winnings" UI.
  const SOL_PAYOUT_BPS: Record<number, number[]> = {
    0: [10000],            // heads-up: winner takes all
    1: [6500, 3500],       // 6-max: 65 / 35
    2: [5000, 3000, 2000], // 9-max: 50 / 30 / 20
  };
  const solStructure = SOL_PAYOUT_BPS[gameType] ?? [];
  const poolDoc = await tables().findOne({ _id: tablePk }, { projection: { entryAmount: 1, tier: 1 } });
  const seats = SNG_SEATS_BY_GAMETYPE[gameType] ?? 0;
  let solPool = Number(data.sol_prize_pool);
  if (!Number.isSafeInteger(solPool) || solPool < 0) {
    const tier = Number(poolDoc?.tier);
    let perSeatEntry = Number.isSafeInteger(tier) && tier in SNG_ENTRY_BY_TIER
      ? SNG_ENTRY_BY_TIER[tier]
      : Number(poolDoc?.entryAmount) || 0;

    // Last-resort legacy fallback for tables whose metadata enrich missed.
    // The earnings row stores total buy-in, so map it back to the tier entry
    // component rather than using it directly.
    if (perSeatEntry <= 0 && !(Number.isSafeInteger(tier) && tier in SNG_ENTRY_BY_TIER)) {
      const buyinAgg = await earnings().aggregate([
        { $match: { table: tablePk, kind: 'sng_buyin', tokenMint: { $in: ['SOL', SOL_SENTINEL] } } },
        { $group: { _id: null, perSeatTotal: { $max: '$amount' } } },
      ]).toArray();
      const totalBuyIn = Number(buyinAgg[0]?.perSeatTotal) || 0;
      perSeatEntry = SNG_TOTAL_BUYIN_TO_ENTRY.get(totalBuyIn) ?? 0;
    }
    solPool = seats * perSeatEntry;
  }

  // Per-payout earnings rows + player aggregate bumps. Deterministic _id so
  // rerunning sync is idempotent. Tolerant of payouts.length > itmCount so
  // PR4's widened POKER table lands cleanly.
  const payoutWallets = new Set<string>();
  for (let i = 0; i < payouts.length; i++) {
    const { wallet, amount } = payouts[i];
    const place = i + 1;
    const isItm = place <= itmCount;
    payoutWallets.add(wallet);
    const _id = `${ctx.txSig}:sng_prize:${wallet}:${place}` as unknown as import('mongodb').ObjectId;
    await earnings().updateOne(
      { _id },
      {
        $set: {
          player: wallet,
          kind: 'sng_prize',
          table: tablePk,
          amount,
          tokenMint: 'POKER',  // Raw Yield 6-dec micro-units, NOT SOL
          nonItm: !isItm,
          ts: when,
          txSig: ctx.txSig,
          place,
        },
      },
      { upsert: true },
    );
    const inc: Record<string, number> = {
      tournamentPokerEarned: amount,  // 6-dec micro-units (FP profit; no FP buy-in)
    };
    const solBps = solStructure[place - 1] ?? 0;
    const solPrize = solBps > 0 && solPool > 0 ? Math.floor((solPool * solBps) / 10000) : 0;
    if (solPrize > 0) {
      inc.sngProfitSol = solPrize;  // SOL prize won (player stat)
      // Surface the SOL prize as its own fund-history row. PrizesDistributed
      // only carries the POKER amount, so without this the SOL winnings net
      // silently into the stat and never appear in the History panel.
      const solId = `${ctx.txSig}:sng_prize_sol:${wallet}:${place}` as unknown as import('mongodb').ObjectId;
      await earnings().updateOne(
        { _id: solId },
        {
          $set: {
            player: wallet,
            kind: 'sng_prize',
            table: tablePk,
            amount: solPrize,
            tokenMint: 'SOL',
            nonItm: !isItm,
            ts: when,
            txSig: ctx.txSig,
            place,
          },
        },
        { upsert: true },
      );
    }
    if (isItm) {
      inc.itmCount = 1;
      if (place === 1) {
        inc.tournamentsWon = 1;
      }
    }
    // Per-player tournament count bumps once per row, regardless of place.
    // Each player has exactly one prize row per tournament so this stays
    // accurate even when payouts.length > itmCount.
    inc.tournamentsPlayed = 1;
    await players().updateOne(
      { _id: wallet },
      {
        $inc: inc,
        $set: { lastActive: when },
        $setOnInsert: zeroedPlayerInsert(wallet),
      },
      { upsert: true },
    );
  }

  // Tombstone row for every tournament participant who did NOT cash. Makes SNG
  // losses visible in the profile History panel.
  //
  // PHANTOM-BUST FIX: derive the participant set from the IMMUTABLE hand_reports
  // (who actually played hands on this table in THIS tournament's window), NOT
  // from the per-table tournaments.players[] roster. That roster accumulates
  // across SNG reuse and re-tombstoned long-departed players on later tournaments
  // ("busted in games I was never in"). hand_reports are keyed by table:hand and
  // never mutate, so this is order-independent under re-backfill.
  //
  // Window lower bound = the PREVIOUS settle on this table (so we don't pull in a
  // prior tournament's hands), capped to 6h so a missing/late prior-settle row
  // can never widen it back to "all history". Under-bust (if a hand_report lags
  // ingestion at settle time) is acceptable — far safer than phantom-busting.
  const PREV_SETTLE_CAP_MS = 6 * 60 * 60 * 1000;
  const prevSettle = await earnings().find(
    { table: tablePk, kind: { $in: ['sng_prize', 'sng_bust'] }, ts: { $lt: when } },
    { projection: { ts: 1 } },
  ).sort({ ts: -1 }).limit(1).toArray();
  const prevTs = prevSettle[0]?.ts ? new Date(prevSettle[0].ts as any).getTime() : 0;
  const lowerMs = Math.max(prevTs, when.getTime() - PREV_SETTLE_CAP_MS);
  const windowReports = await handReports().find(
    { table: tablePk, settledAt: { $gt: new Date(lowerMs), $lte: new Date(when.getTime() + 5 * 60 * 1000) } },
    { projection: { participantWallets: 1 } },
  ).toArray();
  const participants = new Set<string>();
  for (const r of windowReports) {
    for (const w of (r.participantWallets || [])) participants.add(w);
  }

  // Also union the AUTHORITATIVE entrants from sng_buyin rows in this window.
  // seat_from_pool emits PlayerJoined with buy_in (seat_from_pool.rs:328), so a
  // seated player ALWAYS has a sng_buyin row even if they busted before any
  // hand_report was crawled — that lag would otherwise drop their bust tombstone.
  // UPPER BOUND IS `when` (the settle), NOT when+5min: buy-ins precede the
  // tournament, so a fast-reused table's NEXT tournament's buy-ins (which land
  // just AFTER this settle) must never leak in and be phantom-busted here.
  const buyinRows = await earnings().find(
    { table: tablePk, kind: 'sng_buyin', ts: { $gt: new Date(lowerMs), $lte: when } },
    { projection: { player: 1 } },
  ).toArray();
  for (const b of buyinRows) {
    if (b.player) participants.add(b.player as string);
  }
  for (const wallet of participants) {
    if (payoutWallets.has(wallet)) continue;
    const _id = `${ctx.txSig}:sng_bust:${wallet}` as unknown as import('mongodb').ObjectId;
    const res = await earnings().updateOne(
      { _id },
      {
        $set: {
          player: wallet,
          kind: 'sng_bust',
          table: tablePk,
          amount: 0,
          tokenMint: 'SOL',
          ts: when,
          txSig: ctx.txSig,
        },
      },
      { upsert: true },
    );
    // Bump tournamentsPlayed for non-cashers too — but ONLY when the tombstone is
    // newly created. Re-syncs and chunked settles re-use the same _id (no-op),
    // so the stat can't be inflated by reprocessing the same settle.
    if (res.upsertedCount > 0) {
      await players().updateOne(
        { _id: wallet },
        {
          $inc: { tournamentsPlayed: 1 },
          $set: { lastActive: when },
          $setOnInsert: zeroedPlayerInsert(wallet),
        },
        { upsert: true },
      );
    }
  }

  // Reset the per-table roster (defense-in-depth; bust derivation no longer reads
  // it — see the hand_reports-based participant set above).
  await tournaments().updateOne(
    { _id: tablePk },
    { $set: { players: [] } },
  );

  // Reconcile player aggregates for everyone touched by this settle so the LIVE
  // counts converge to the deduped recompute (tournamentsWon/itmCount via the
  // POKER-only filter), rather than relying on divergent $inc paths. Mirrors the
  // refund/cashout handlers.
  const touched = new Set<string>([...payoutWallets, ...participants]);
  for (const wallet of touched) await recomputePlayerAggregates(wallet);
}

// ─── RakeDistributed ───────────────────────────────────────────────────

async function applyRakeDistributed(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const { ObjectId } = await import('mongodb');
  await rakeLedger().insertOne({
    _id: new ObjectId(),
    table: pubkey(data.table),
    totalRake: bigNum(data.total_rake),
    stakerShare: bigNum(data.staker_share),
    creatorShare: bigNum(data.creator_share),
    treasuryShare: bigNum(data.treasury_share),
    ts: when,
    txSig: ctx.txSig,
    slot: ctx.slot,
  });
}

// ─── SngPartialPlayerRefunded ─────────────────────────────────────────

async function applySngPartialPlayerRefunded(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const wallet = pubkey(data.player);
  const tablePk = pubkey(data.table);
  const playerIndex = Number(data.player_index);
  const seat = Number(data.seat_index);
  const seated = Boolean(data.seated);
  const gameplayLamports = bigNum(data.gameplay_lamports);
  const miniLamports = bigNum(data.mini_lamports);
  const rentLamports = bigNum(data.rent_lamports);
  const totalLamports = bigNum(data.total_lamports);

  // The existing indexer records SNG buy-in only once a selected player is
  // seated (PlayerJoined from seat_from_pool). For partially seated recovery,
  // unseated wallets have no indexed debit yet, so their refund row is visible
  // but pnlAmount=0 to avoid a false positive net-flow. Seated wallets use the
  // gameplay refund to offset their indexed SNG buy-in; mini/rent were not
  // part of that indexed buy-in.
  const pnlAmount = seated ? gameplayLamports : 0;
  const _id = `${ctx.txSig}:sng_refund:${wallet}:${playerIndex}` as unknown as import('mongodb').ObjectId;
  await earnings().updateOne(
    { _id },
    {
      $set: {
        player: wallet,
        kind: 'sng_refund',
        table: tablePk,
        amount: totalLamports,
        pnlAmount,
        gameplayLamports,
        miniLamports,
        rentLamports,
        seated,
        seat,
        tokenMint: 'SOL',
        ts: when,
        txSig: ctx.txSig,
      },
    },
    { upsert: true },
  );
  await recomputePlayerAggregates(wallet);
}

// ─── DuplicateSngTableCancelled ────────────────────────────────────────

async function applyDuplicateSngTableCancelled(data: Record<string, unknown>, ctx: EventContext, when: Date): Promise<void> {
  const tablePk = pubkey(data.table);
  const poolPk = pubkey(data.pool);
  const caller = pubkey(data.caller);
  const seatsRefunded = Number(data.seats_refunded);
  const principalLamports = bigNum(data.principal_lamports_refunded);
  const inactiveMiniLamports = bigNum(data.inactive_mini_lamports_refunded);
  const expectedRefunded = principalLamports + inactiveMiniLamports;
  if (expectedRefunded <= 0 || seatsRefunded <= 0) return;

  if (!ctx.tx) {
    console.warn(`[indexer] DuplicateSngTableCancelled ${ctx.txSig.slice(0, 8)} skipped: missing tx metadata`);
    return;
  }

  const ignored = new Set([tablePk, poolPk, caller, config.program.id, SOL_SENTINEL]);
  const positive = extractNativeBalanceDeltas(ctx.tx)
    .filter((d) => d.delta > 0 && !ignored.has(d.pubkey));
  const totalPositive = positive.reduce((n, d) => n + d.delta, 0);
  if (totalPositive !== expectedRefunded) {
    console.warn(
      `[indexer] DuplicateSngTableCancelled ${ctx.txSig.slice(0, 8)} skipped: ` +
      `positive deltas ${totalPositive} != event refunded ${expectedRefunded}`,
    );
    return;
  }

  const principalPerSeat = seatsRefunded > 0 && principalLamports % seatsRefunded === 0
    ? principalLamports / seatsRefunded
    : 0;
  const touched: string[] = [];
  for (let i = 0; i < positive.length; i++) {
    const row = positive[i];
    const pnlAmount = positive.length === seatsRefunded && principalPerSeat > 0
      ? Math.min(row.delta, principalPerSeat)
      : Math.min(row.delta, principalLamports);
    const existing = await earnings().findOne(
      { player: row.pubkey, kind: 'sng_refund', table: tablePk, txSig: ctx.txSig },
      { projection: { _id: 1 } },
    );
    const _id = (existing?._id ?? `${ctx.txSig}:sng_refund:${row.pubkey}:duplicate_cancel:${tablePk}:${i}`) as unknown as import('mongodb').ObjectId;
    await earnings().updateOne(
      { _id },
      {
        $set: {
          player: row.pubkey,
          kind: 'sng_refund',
          table: tablePk,
          amount: row.delta,
          pnlAmount,
          gameplayLamports: pnlAmount,
          miniLamports: row.delta - pnlAmount,
          rentLamports: 0,
          seated: true,
          seat: i,
          tokenMint: 'SOL',
          ts: when,
          txSig: ctx.txSig,
        },
      },
      { upsert: true },
    );
    touched.push(row.pubkey);
  }
  for (const wallet of touched) await recomputePlayerAggregates(wallet);
}

// ─── Shared insert skeleton ────────────────────────────────────────────

/**
 * $setOnInsert payload for player docs.
 *
 * Mongo rejects updates where $inc and $setOnInsert touch the same field
 * ("conflict at 'totalWinnings'" etc.). Since every numeric aggregate is
 * managed via $inc downstream — and $inc on a missing field initializes
 * it to 0 automatically — we intentionally leave numeric fields out here
 * and only seed the stable identity.
 */
function zeroedPlayerInsert(wallet: string): Record<string, unknown> {
  return { _id: wallet };
}

/**
 * Rebuild a single player's aggregate counters from the earnings ledger.
 * The ledger is the source of truth — earnings rows have deterministic _ids
 * so they don't duplicate across syncs, which makes this recompute authoritative.
 *
 * Prefer this over $inc in apply*() handlers: $inc is not idempotent so
 * re-running backfill / sync inflates the counters every pass.
 */
export async function recomputePlayerAggregates(wallet: string): Promise<void> {
  const [allAgg, solAgg] = await Promise.all([
    earnings().aggregate([
      { $match: { player: wallet } },
      { $group: { _id: '$kind', n: { $sum: 1 }, total: { $sum: '$amount' } } },
    ]).toArray(),
    earnings().aggregate([
      { $match: { player: wallet, $or: [{ tokenMint: { $in: ['SOL', SOL_SENTINEL] } }, { tokenMint: { $exists: false } }] } },
      { $group: { _id: '$kind', n: { $sum: 1 }, total: { $sum: '$amount' } } },
    ]).toArray(),
  ]);

  const allSums: Record<string, { n: number; total: number }> = {};
  for (const row of allAgg) allSums[row._id as string] = { n: row.n as number, total: row.total as number };
  const sums: Record<string, { n: number; total: number }> = {};
  for (const row of solAgg) sums[row._id as string] = { n: row.n as number, total: row.total as number };

  const deposits = sums.cash_deposit?.total ?? 0;
  const cashouts = sums.cashout?.total ?? 0;
  const buyins = sums.sng_buyin?.total ?? 0;
  // Manual incident refunds (cash-stranding). A recovery returns principal the
  // player deposited but never cashed out, so it offsets `deposits` in the net
  // (cashNetSol) but is NOT counted as winnings (totalWinnings stays gross wins).
  const recoveries = sums.recovery?.total ?? 0;
  // `sums` filters by tokenMint=SOL, so a POKER-marked sng_prize row is
  // excluded from `prizes` (correct — those amounts are Raw Yield, not SOL).
  // Sum POKER prizes separately and store on a distinct aggregate field.
  const prizes = sums.sng_prize?.total ?? 0;

  const refundPnlAgg = await earnings().aggregate([
    { $match: { player: wallet, kind: 'sng_refund', tokenMint: { $in: ['SOL', SOL_SENTINEL] } } },
    { $group: { _id: null, total: { $sum: { $ifNull: ['$pnlAmount', 0] } } } },
  ]).toArray();
  const refundsPnl = (refundPnlAgg[0]?.total as number | undefined) ?? 0;

  // POKER (Raw Yield) tournament earnings — sum across all sng_prize rows
  // regardless of nonItm flag. This is the player's lifetime POKER from SNGs.
  const pokerPrizeAgg = await earnings().aggregate([
    { $match: { player: wallet, kind: 'sng_prize', tokenMint: 'POKER' } },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]).toArray();
  const tournamentPokerEarned = (pokerPrizeAgg[0]?.total as number | undefined) ?? 0;

  const cashSessions = allSums.cash_deposit?.n ?? 0;
  const sngSessions = (allSums.sng_buyin?.n ?? 0);

  // Tournaments entered = one buy-in per entry. The old `prizeRows + bustRows`
  // DOUBLE-COUNTED: every seat gets a sng_prize row (the $FP emission trickle,
  // ITM or not) AND non-winners also get a sng_bust row, so each non-cash
  // tournament was counted twice (e.g. 32 entries showed as 72). sng_buyin is
  // one row per tournament entered — the correct count.
  const tournamentsPlayed = sngSessions;
  // Each payout writes ONE POKER sng_prize row plus an optional SOL twin row
  // (handlers.ts ~528/556). Count only the POKER row so a single ITM finish /
  // win isn't double-counted (this is why tournamentsWon read 9 when the wallet
  // truly won 5, and itmCount was inflated).
  const tournamentsWon = await earnings().countDocuments({ player: wallet, kind: 'sng_prize', place: 1, tokenMint: 'POKER' });
  // ITM-only count: the canonical POKER row per payout, excluding nonItm-flagged
  // rows (non-paying emission trickle). Legacy rows without the flag are treated
  // as ITM (pre-flag every sng_prize was an ITM entry).
  const itmCount = await earnings().countDocuments({
    player: wallet,
    kind: 'sng_prize',
    tokenMint: 'POKER',
    $or: [{ nonItm: { $exists: false } }, { nonItm: false }],
  });

  await players().updateOne(
    { _id: wallet },
    {
      $set: {
        sessionsPlayed: cashSessions + sngSessions,
        // Stored separately so the profile can show cash-only vs SNG-only
        // session counts (the cash tab was showing the combined total).
        cashSessions,
        sngSessions,
        totalInvested: deposits + buyins,
        // POKER prizes intentionally excluded from these SOL-denominated
        // aggregates. They live on `tournamentPokerEarned` instead.
        totalWinnings: cashouts + prizes,
        cashNetSol: cashouts + recoveries - deposits,
        sngProfitSol: prizes + refundsPnl - buyins,
        tournamentPokerEarned,
        tournamentsPlayed,
        tournamentsWon,
        itmCount,
      },
      $setOnInsert: { _id: wallet },
    },
    { upsert: true },
  );
}
