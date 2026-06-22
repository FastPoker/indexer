/**
 * "Made hand" achievement detection (royal flush / straight flush / quads).
 *
 * These achievements are defined in the UI but never unlocked: the frontend's
 * deriveAchievements has no case for them and nothing tracked the player's best
 * hand. The raw cards are stored on every showdown hand_report
 * (record.communityCards + record.shownCards), so we can detect and backfill.
 *
 * Limitation: only hands that reached showdown WITH cards shown are detectable.
 * A straight flush that won uncontested (everyone folded, no reveal) is not in
 * shownCards and cannot be awarded from stored data.
 */
import { players, handReports, tables } from './db.ts';
import type { ParsedHandRecord } from './db.ts';

export type MadeHandCat = 'royal' | 'sflush' | 'quads';

const RANK: Record<string, number> = {
  '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7,
  'T': 8, '10': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12,
};

function parseCard(s: string): { r: number; suit: string } | null {
  if (!s || s.length < 2) return null;
  const suit = s[s.length - 1].toLowerCase();
  const r = RANK[s.slice(0, s.length - 1).toUpperCase()];
  return r === undefined ? null : { r, suit };
}

/** Best made-hand category among the 7 available cards, or null. */
export function bestMadeHand(cards: { r: number; suit: string }[]): MadeHandCat | null {
  const freq: Record<number, number> = {};
  for (const c of cards) freq[c.r] = (freq[c.r] || 0) + 1;
  const hasQuads = Object.values(freq).some((n) => n >= 4);

  let sflush = false, royal = false;
  for (const suit of ['s', 'h', 'd', 'c']) {
    const present = new Set(cards.filter((c) => c.suit === suit).map((c) => c.r));
    if (present.size < 5) continue;
    if (present.has(12)) present.add(-1); // ace-low wheel A-2-3-4-5
    for (let start = 8; start >= -1; start--) { // start=8 → T J Q K A (royal)
      let ok = true;
      for (let k = 0; k < 5; k++) if (!present.has(start + k)) { ok = false; break; }
      if (ok) { sflush = true; if (start === 8) royal = true; break; }
    }
  }
  if (royal) return 'royal';
  if (sflush) return 'sflush';
  if (hasQuads) return 'quads';
  return null;
}

/** seat -> wallet for a hand, derived from the per-action actor→wallet pairs. */
function seatWalletMap(record: ParsedHandRecord): Map<number, string> {
  const m = new Map<number, string>();
  for (const a of record.actions || []) {
    if (a.wallet && a.wallet !== '11111111111111111111111111111111') m.set(a.actor, a.wallet);
  }
  return m;
}

/** Made hands attributed to wallets for a single hand_report record. */
export function scanReportForMadeHands(record: ParsedHandRecord): Array<{ wallet: string; cat: MadeHandCat }> {
  const community = (record.communityCards || []).map(parseCard).filter(Boolean) as { r: number; suit: string }[];
  if (community.length < 5) return []; // SF/royal need the full board; quads can too only at river here
  const seatMap = seatWalletMap(record);
  const out: Array<{ wallet: string; cat: MadeHandCat }> = [];
  for (const sc of record.shownCards || []) {
    const wallet = seatMap.get(sc.seat);
    if (!wallet) continue;
    const hole = [parseCard(sc.card1), parseCard(sc.card2)].filter(Boolean) as { r: number; suit: string }[];
    if (hole.length < 2) continue;
    const cat = bestMadeHand([...community, ...hole]);
    if (cat) out.push({ wallet, cat });
  }
  return out;
}

/** Longest run of consecutive calendar days (UTC) present in the date strings. */
function longestConsecutiveDayStreak(dayKeys: string[]): number {
  if (dayKeys.length === 0) return 0;
  const uniq = Array.from(new Set(dayKeys)).sort();
  let best = 1, cur = 1;
  for (let i = 1; i < uniq.length; i++) {
    const prev = Date.parse(`${uniq[i - 1]}T00:00:00Z`);
    const curr = Date.parse(`${uniq[i]}T00:00:00Z`);
    if (curr - prev === 86_400_000) { cur++; if (cur > best) best = cur; }
    else cur = 1;
  }
  return best;
}

/**
 * Rebuild a single wallet's derived achievement counters from its hand_reports
 * (+ tables for the cash-out flag) and persist them on the player doc.
 * Idempotent ($set, full recompute) so it is safe to call from /sync and from
 * the backfill repeatedly. Materializes:
 *   - royal / straightFlush / quads      (made hands, from shown showdown cards)
 *   - bestWinStreak                       (HEATER — consecutive won hands)
 *   - bestActiveDayStreak                 (7-DAY GRIND — consecutive play days)
 *   - doubledUp                           (DOUBLE UP — cash-out >= 2x buy-in)
 */
export async function recomputeMadeHands(wallet: string): Promise<void> {
  const docs = await handReports()
    .find(
      { participantWallets: wallet },
      { projection: { record: 1, winnerWallets: 1, settledAt: 1, handNumber: 1 } },
    )
    .sort({ settledAt: 1, handNumber: 1 })
    .toArray();

  let royal = 0, sflush = 0, quads = 0;
  let curWinStreak = 0, bestWinStreak = 0;
  let allInPreflopWins = 0;
  // Authoritative pots played / won across BOTH cash AND SNG, derived from the
  // immutable hand_reports (one doc per hand this wallet sat in). The on-chain
  // Player PDA counters the client used to read are DEAD (not incremented by the
  // contract), and the event-driven `handsWon` only fires on L1 cash HandSettled
  // — never on ER/TEE SNG hands — so neither could light up FIRST BLOOD /
  // FIRST HAND / 100 / 1K / 10K. These do.
  const handReportsPlayed = docs.length;
  let handReportsWon = 0;
  const playDays: string[] = [];

  for (const d of docs) {
    for (const { wallet: w, cat } of scanReportForMadeHands(d.record)) {
      if (w !== wallet) continue;
      if (cat === 'royal') royal++;
      else if (cat === 'sflush') sflush++;
      else if (cat === 'quads') quads++;
    }
    // Win streak: each doc is a hand this wallet played (query filter); a hand
    // it won extends the run, anything else breaks it.
    const won = Array.isArray(d.winnerWallets) && d.winnerWallets.includes(wallet);
    if (won) { handReportsWon++; curWinStreak++; if (curWinStreak > bestWinStreak) bestWinStreak = curWinStreak; }
    else { curWinStreak = 0; }
    // ALL IN (allin-win): won a hand after going all-in PREFLOP. The contract
    // reports street Preflop=0 and the explicit AllIn action code=5
    // (player_action.rs report_street/report_action). A full preflop shove is
    // sent as PokerAction::AllIn, so this is the reliable signal.
    // Limitation (no false positives): a preflop shove entered as a max-size
    // RAISE records as Raise(4), and an all-in-for-less-than-a-call records as
    // Call(2) — neither is counted. Mirrors the showdown-only made-hand limit.
    if (won) {
      for (const a of d.record?.actions || []) {
        if (a.wallet === wallet && a.street === 0 && a.action === 5) { allInPreflopWins++; break; }
      }
    }
    // Active-day streak: bucket by UTC calendar day.
    if (d.settledAt) playDays.push(new Date(d.settledAt).toISOString().slice(0, 10));
  }
  const bestActiveDayStreak = longestConsecutiveDayStreak(playDays);

  // Double-up: any seat-session where this wallet cashed out >= 2x its buy-in.
  let doubledUp = false;
  const tableDocs = await tables()
    .find({ 'players.wallet': wallet }, { projection: { players: 1 } })
    .toArray();
  outer: for (const t of tableDocs) {
    for (const p of t.players || []) {
      if (p.wallet === wallet && typeof p.cashedOut === 'number' && p.buyIn > 0 && p.cashedOut >= 2 * p.buyIn) {
        doubledUp = true;
        break outer;
      }
    }
  }

  await players().updateOne(
    { _id: wallet },
    {
      $set: {
        royalCount: royal, straightFlushCount: sflush, quadsCount: quads,
        bestWinStreak, bestActiveDayStreak, doubledUp,
        allInPreflopWins,
        handReportsPlayed, handReportsWon,
      },
      $setOnInsert: { _id: wallet },
    },
    { upsert: true },
  );
}
