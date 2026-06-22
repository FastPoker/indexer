/**
 * Per-table lobby stats — Avg Pot / VPIP / Hands per Hour. Powers the
 * cash-table list columns. All values come from `hand_reports` (already
 * indexed). No Solana RPC calls, no on-chain reads.
 *
 * Two windows, on purpose:
 *   - Avg Pot / VPIP are table *characteristics* — averaged over a rolling
 *     24h window for stability.
 *   - Hands/Hour is a *liveness* signal ("how hot is this table right now"),
 *     so it's an observed rate over a short recent window. This matches what
 *     real-money lobbies (PokerStars / GGPoker / partypoker) show: a table
 *     that breaks or sits idle drops to ~0 quickly instead of carrying a
 *     stale 24h average for hours.
 *
 * Refresh strategy: in-memory cache rebuilt every 5 minutes from a single
 * Mongo sweep. Browser tabs hit a cheap `GET /tables/stats?pdas=...` batch
 * endpoint that just returns the cache slice for the requested PDAs.
 *
 *   1 worker × 1 sweep / 5 min   ≪    N browsers × per-table reads
 */
import { handReports } from '../db.ts';

const REFRESH_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;        // Avg Pot / VPIP averaging window
const LIVE_WINDOW_MS = 45 * 60 * 1000;        // Hands/Hour observed-rate window
const STALE_AFTER_MS = 15 * 60 * 1000;

// PokerAction enum order from programs/fastpoker/src/state/table.rs:
//   0 Fold | 1 Check | 2 Call | 3 Bet | 4 Raise | 5 AllIn | ...
// VPIP = "Voluntarily Put $ In Pot" — Call / Bet / Raise / AllIn on preflop.
const VPIP_ACTIONS: ReadonlySet<number> = new Set([2, 3, 4, 5]);
const PREFLOP_STREET = 0;

export interface TableStats {
  /** Average final pot size over the window, in lamports. */
  avgPotLamports: number;
  /** 0..1, fraction of seat-hands that voluntarily put money in preflop. */
  vpip: number;
  /** Observed hands/hour over the recent LIVE_WINDOW (0 when idle). */
  handsPerHour: number;
  /** Hand count over the 24h window (drives avgPot/vpip + the render gate). */
  handCount: number;
  /** Unix ms when this snapshot was last computed. */
  asOfMs: number;
}

interface MutAcc {
  potSum: number;
  handCount: number;
  recentCount: number;
  vpipSeatHands: number;
  totalSeatHands: number;
}

const cache = new Map<string, TableStats>();
let lastRefreshMs = 0;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const since = new Date(Date.now() - WINDOW_MS);
    const liveSinceMs = Date.now() - LIVE_WINDOW_MS;
    const accs = new Map<string, MutAcc>();

    // Single sweep. The handReports `{ table, settledAt }` index makes the
    // $gte settledAt clause cheap; projection keeps payload small.
    const cursor = handReports().find(
      { settledAt: { $gte: since } },
      { projection: { table: 1, settledAt: 1, 'record.pot': 1, 'record.actions': 1 } },
    );

    let scanned = 0;
    for await (const doc of cursor) {
      scanned++;
      const table = doc.table;
      if (!table) continue;
      let acc = accs.get(table);
      if (!acc) {
        acc = { potSum: 0, handCount: 0, recentCount: 0, vpipSeatHands: 0, totalSeatHands: 0 };
        accs.set(table, acc);
      }
      acc.potSum += Number(doc.record?.pot ?? 0);
      acc.handCount += 1;
      // Observed-rate window: only hands settled in the last LIVE_WINDOW count
      // toward Hands/Hour, so the figure tracks current activity.
      if (doc.settledAt && new Date(doc.settledAt).getTime() >= liveSinceMs) {
        acc.recentCount += 1;
      }

      // VPIP: per-seat preflop voluntary participation. Track which actors
      // appeared in any action (dealt-in seats) and which made a voluntary
      // action preflop.
      const actions = doc.record?.actions;
      if (Array.isArray(actions) && actions.length > 0) {
        const dealtSeats = new Set<number>();
        const vpipSeats = new Set<number>();
        for (const a of actions) {
          if (typeof a.actor !== 'number' || a.actor < 0 || a.actor > 8) continue;
          dealtSeats.add(a.actor);
          if (a.street === PREFLOP_STREET && VPIP_ACTIONS.has(a.action)) {
            vpipSeats.add(a.actor);
          }
        }
        acc.totalSeatHands += dealtSeats.size;
        acc.vpipSeatHands += vpipSeats.size;
      }
    }

    const nowMs = Date.now();
    const liveWindowHours = LIVE_WINDOW_MS / (60 * 60 * 1000);
    const fresh = new Map<string, TableStats>();
    for (const [table, acc] of accs) {
      fresh.set(table, {
        avgPotLamports: acc.handCount > 0 ? Math.round(acc.potSum / acc.handCount) : 0,
        vpip: acc.totalSeatHands > 0 ? acc.vpipSeatHands / acc.totalSeatHands : 0,
        // Observed rate over the recent window: 0 for tables idle > LIVE_WINDOW.
        handsPerHour: acc.recentCount / liveWindowHours,
        handCount: acc.handCount,
        asOfMs: nowMs,
      });
    }

    // Atomic swap of the cache so concurrent reads always see a consistent set.
    cache.clear();
    for (const [k, v] of fresh) cache.set(k, v);
    lastRefreshMs = nowMs;

    console.log(`[table-stats] refreshed: tables=${fresh.size} hands=${scanned} (last 24h)`);
  })();
  try {
    await inflight;
  } finally {
    inflight = null;
  }
}

/**
 * Return cached stats for the requested table PDAs. Missing tables (no hands
 * in the window) yield `null`. Result is O(N) lookups; no I/O.
 */
export function getTableStats(pdas: readonly string[]): Record<string, TableStats | null> {
  const out: Record<string, TableStats | null> = {};
  for (const pda of pdas) {
    out[pda] = cache.get(pda) ?? null;
  }
  return out;
}

export function isTableStatsStale(): boolean {
  return lastRefreshMs === 0 || Date.now() - lastRefreshMs > STALE_AFTER_MS;
}

export function startTableStatsLoop(): void {
  if (intervalHandle !== null) return;
  void refresh().catch((err) => {
    console.error('[table-stats] initial refresh failed:', err instanceof Error ? err.message : err);
  });
  intervalHandle = setInterval(() => {
    refresh().catch((err) => {
      console.error('[table-stats] refresh failed:', err instanceof Error ? err.message : err);
    });
  }, REFRESH_MS);
  console.log(`[table-stats] refresh loop started (${REFRESH_MS / 1000}s)`);
}

export function stopTableStatsLoop(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
