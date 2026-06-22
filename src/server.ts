import * as http from 'node:http';
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from './config.ts';
import { log } from './logger.ts';
import { getMetricsText, getMetricsContentType, httpRequests, httpDuration } from './metrics.ts';
import { tables, hands, handReports, players, earnings, rakeLedger, tournaments, cursor } from './db.ts';
import { syncTableHandReports } from './hand-reports.ts';
import { getSngPoolStates } from './domains/sng-pools.ts';
import { getListedTokens } from './domains/token-registry.ts';
import { getAllTables, getTable, tablesAsOfMs } from './domains/tables.ts';
import { getRecentReceipts, getReceiptByHand, getLeaderboard, getWalletJackpots } from './domains/jackpots.ts';
import { getTableStats, isTableStatsStale } from './domains/table-stats.ts';

type Handler = (req: http.IncomingMessage, url: URL) => Promise<{ status: number; body: unknown }>;

const syncRpc = new Connection(config.rpc.url, 'confirmed');
const SOL_SENTINEL = '11111111111111111111111111111111';
const SOL_TOKEN_MINTS = ['SOL', SOL_SENTINEL];
const DAY_MS = 24 * 60 * 60 * 1000;

function isPubkey(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeTokenMint(mint?: string | null): string {
  return !mint || mint === SOL_SENTINEL ? 'SOL' : mint;
}

function pathPart(url: URL, re: RegExp, index = 1): string {
  return decodeURIComponent(url.pathname.match(re)?.[index] || '');
}

function intParam(url: URL, key: string, fallback: number, max: number): number {
  const n = Number(url.searchParams.get(key) || fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function emptyPlayer(wallet: string): Record<string, unknown> {
  return {
    player: wallet,
    registeredAt: null,
    lastActive: null,
    handsWon: 0,
    sessionsPlayed: 0,
    cashSessions: 0,
    sngSessions: 0,
    totalInvested: 0,
    totalWinnings: 0,
    cashNetSol: 0,
    tournamentsPlayed: 0,
    tournamentsWon: 0,
    itmCount: 0,
    sngProfitSol: 0,
    netProfitSol: 0,
    tournamentPokerEarned: 0,
    royalCount: 0,
    straightFlushCount: 0,
    quadsCount: 0,
    bestWinStreak: 0,
    bestActiveDayStreak: 0,
    doubledUp: false,
    allInPreflopWins: 0,
    handReportsPlayed: 0,
    handReportsWon: 0,
  };
}

const routes: Array<{ method: string; match: RegExp; handler: Handler }> = [
  {
    method: 'GET',
    match: /^\/health\/?$/,
    handler: async () => {
      const [cur, tableCount, handCount, handReportCount, playerCount, tournamentCount] = await Promise.all([
        cursor().findOne({ _id: 'cursor' }),
        tables().countDocuments({}),
        hands().countDocuments({}),
        handReports().countDocuments({}),
        players().countDocuments({}),
        tournaments().countDocuments({}),
      ]);
      return {
        status: 200,
        body: {
          ok: true,
          lastIndexedSignature: cur?.lastIndexedSignature ?? null,
          lastIndexedSlot: cur?.lastIndexedSlot ?? null,
          lastIndexedAt: cur?.lastIndexedAt ?? null,
          backfillCompletedAt: cur?.backfillCompletedAt ?? null,
          tableCount,
          handCount,
          legacyHandCount: handCount,
          handReportCount,
          settledHandCount: handReportCount,
          playerCount,
          tournamentCount,
        },
      };
    },
  },
  {
    method: 'GET',
    match: /^\/v1\/sng-pools\/?$/,
    handler: async () => {
      const snap = getSngPoolStates();
      if (snap.asOfMs === 0) return { status: 503, body: { error: 'sng-pools cold', retryAfterMs: 2_000 } };
      return { status: 200, body: snap };
    },
  },
  {
    method: 'GET',
    match: /^\/v1\/tokens\/?$/,
    handler: async () => {
      const snap = getListedTokens();
      if (snap.asOfMs === 0) return { status: 503, body: { error: 'tokens cold', retryAfterMs: 2_000 } };
      return { status: 200, body: snap };
    },
  },
  {
    method: 'GET',
    match: /^\/v1\/tables\/?$/,
    handler: async (_req, url) => {
      const pubkey = url.searchParams.get('pubkey');
      if (pubkey) {
        const asOfMs = tablesAsOfMs();
        if (asOfMs === 0) return { status: 503, body: { error: 'tables cold', retryAfterMs: 2_000 } };
        return { status: 200, body: { table: getTable(pubkey), asOfMs } };
      }
      const snap = getAllTables();
      if (snap.asOfMs === 0) return { status: 503, body: { error: 'tables cold', retryAfterMs: 2_000 } };
      return { status: 200, body: snap };
    },
  },
  {
    method: 'GET',
    match: /^\/tables\/live\/?$/,
    handler: async (_req, url) => {
      const creator = url.searchParams.get('creator');
      const gameTypeStr = url.searchParams.get('gameType');
      const query: Record<string, unknown> = { isClosed: { $ne: true } };
      if (creator) query.creator = creator;
      if (gameTypeStr !== null) {
        const gt = Number(gameTypeStr);
        if (Number.isFinite(gt)) query.gameType = gt;
      }
      const docs = await tables()
        .find(query, { projection: { lastUpdatedSlot: 0 } })
        .sort({ createdAt: -1 })
        .limit(500)
        .toArray();
      return { status: 200, body: { tables: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/tables\/stats\/?$/,
    handler: async (_req, url) => {
      const raw = url.searchParams.get('pdas') || '';
      const pdas = Array.from(new Set(
        raw.split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9]{32,44}$/.test(s)),
      )).slice(0, 200);
      if (pdas.length === 0) return { status: 200, body: { stats: {}, count: 0, stale: isTableStatsStale() } };
      return { status: 200, body: { stats: getTableStats(pdas), count: pdas.length, stale: isTableStatsStale() } };
    },
  },
  {
    method: 'GET',
    match: /^\/table\/([A-Za-z0-9]+)\/?$/,
    handler: async (_req, url) => {
      const pubkey = pathPart(url, /^\/table\/([A-Za-z0-9]+)\/?$/);
      if (!pubkey || !isPubkey(pubkey)) return { status: 400, body: { error: 'invalid table pubkey' } };
      const doc = await tables().findOne({ _id: pubkey }, { projection: { lastUpdatedSlot: 0 } });
      if (!doc) return { status: 404, body: { error: 'table not found' } };
      return { status: 200, body: { table: doc } };
    },
  },
  {
    method: 'GET',
    match: /^\/hand\/(.+)$/,
    handler: async (_req, url) => {
      const handId = pathPart(url, /^\/hand\/(.+)$/);
      if (!handId) return { status: 400, body: { error: 'missing hand id' } };
      const doc = await hands().findOne({ _id: handId });
      if (!doc) return { status: 404, body: { error: 'hand not found' } };
      return { status: 200, body: { hand: doc } };
    },
  },
  {
    method: 'GET',
    match: /^\/hand-report\/([^/]+)\/(\d+)\/?$/,
    handler: async (_req, url) => {
      const table = pathPart(url, /^\/hand-report\/([^/]+)\/(\d+)\/?$/, 1);
      const handNumber = Number(url.pathname.match(/^\/hand-report\/([^/]+)\/(\d+)\/?$/)?.[2] || NaN);
      if (!table || !isPubkey(table) || !Number.isFinite(handNumber)) {
        return { status: 400, body: { error: 'invalid hand report id' } };
      }
      const forceSync = url.searchParams.get('sync') === '1' || url.searchParams.get('refresh') === '1';
      let doc = await handReports().findOne({ _id: `${table}:${handNumber}` });
      let sync: Awaited<ReturnType<typeof syncTableHandReports>> | undefined;
      if (!doc || forceSync) {
        sync = await syncTableHandReports(syncRpc, table, {
          maxPages: intParam(url, 'maxPages', 20, 100),
          stopWhenHandFound: handNumber,
        });
        doc = await handReports().findOne({ _id: `${table}:${handNumber}` });
      }
      if (!doc) return { status: 404, body: { error: 'hand report not found', sync } };
      return { status: 200, body: { handReport: doc, sync } };
    },
  },
  {
    method: 'GET',
    match: /^\/hand-reports\/table\/([^/]+)\/?$/,
    handler: async (_req, url) => {
      const table = pathPart(url, /^\/hand-reports\/table\/([^/]+)\/?$/);
      if (!table || !isPubkey(table)) return { status: 400, body: { error: 'invalid table pubkey' } };
      let sync: Awaited<ReturnType<typeof syncTableHandReports>> | undefined;
      if (url.searchParams.get('sync') === '1' || url.searchParams.get('refresh') === '1') {
        sync = await syncTableHandReports(syncRpc, table, { maxPages: intParam(url, 'maxPages', 20, 100) });
      }
      const docs = await handReports()
        .find({ table })
        .sort({ handNumber: -1 })
        .limit(intParam(url, 'limit', 50, 200))
        .toArray();
      return { status: 200, body: { handReports: docs, count: docs.length, sync } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/stats\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/stats\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const doc = await players().findOne({ _id: wallet });
      if (!doc) return { status: 200, body: emptyPlayer(wallet) };
      return { status: 200, body: { ...doc, netProfitSol: doc.totalWinnings - doc.totalInvested } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/recent-hands\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/recent-hands\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const docs = await hands().find({ winners: wallet }).sort({ settledAt: -1 }).limit(intParam(url, 'limit', 20, 100)).toArray();
      return { status: 200, body: { hands: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/hand-reports\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/hand-reports\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const table = url.searchParams.get('table') || undefined;
      const q: Record<string, unknown> = { participantWallets: wallet };
      if (table) q.table = table;
      const docs = await handReports().find(q).sort({ settledAt: -1 }).limit(intParam(url, 'limit', 50, 200)).toArray();
      return { status: 200, body: { handReports: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/earnings\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/earnings\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const q: Record<string, unknown> = { player: wallet };
      const kind = url.searchParams.get('kind') || undefined;
      if (kind) q.kind = kind;
      const docs = await earnings().find(q).sort({ ts: -1 }).limit(intParam(url, 'limit', 50, 200)).toArray();
      const netAgg = await earnings().aggregate<{ netSol: number }>([
        { $match: { player: wallet, kind: { $in: ['cash_deposit', 'sng_buyin', 'cashout', 'sng_prize', 'sng_refund', 'recovery'] } } },
        {
          $group: {
            _id: null,
            netSol: {
              $sum: {
                $cond: [
                  { $in: [{ $ifNull: ['$tokenMint', 'SOL'] }, SOL_TOKEN_MINTS] },
                  {
                    $cond: [
                      { $in: ['$kind', ['cash_deposit', 'sng_buyin']] },
                      { $multiply: ['$amount', -1] },
                      { $cond: [{ $eq: ['$kind', 'sng_refund'] }, { $ifNull: ['$pnlAmount', 0] }, '$amount'] },
                    ],
                  },
                  0,
                ],
              },
            },
          },
        },
      ]).toArray();
      return { status: 200, body: { earnings: docs, count: docs.length, netSol: netAgg[0]?.netSol ?? 0 } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/pnl-series\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/pnl-series\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const range = url.searchParams.get('range') || '30d';
      const rangeMs: Record<string, number> = {
        '24h': DAY_MS,
        '7d': 7 * DAY_MS,
        '30d': 30 * DAY_MS,
        '1y': 365 * DAY_MS,
      };
      const since = new Date(Date.now() - (rangeMs[range] || rangeMs['30d']));
      const rows = await earnings()
        .find({ player: wallet, kind: { $in: ['cash_deposit', 'sng_buyin', 'cashout', 'sng_prize', 'sng_refund', 'recovery'] }, ts: { $gte: since } })
        .sort({ ts: 1 })
        .toArray();
      let cum = 0;
      const points = rows
        .filter((r) => SOL_TOKEN_MINTS.includes(normalizeTokenMint(r.tokenMint)))
        .map((r) => {
          const delta = (r.kind === 'cash_deposit' || r.kind === 'sng_buyin')
            ? -r.amount
            : r.kind === 'sng_refund'
              ? Number(r.pnlAmount ?? 0)
              : r.amount;
          cum += delta;
          return { t: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts), delta, cum, kind: r.kind };
        });
      return { status: 200, body: { range, since: since.toISOString(), points, count: points.length, final: cum, asset: 'SOL' } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/active-tables\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/active-tables\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const docs = await tables().find(
        { isClosed: { $ne: true }, 'players.wallet': wallet, 'players.leftAt': { $exists: false } },
        { projection: { lastUpdatedSlot: 0 } },
      ).toArray();
      const trimmed = docs.map((d) => ({
        ...d,
        players: (d.players || []).filter((p) => p.wallet === wallet && !p.leftAt),
      }));
      return { status: 200, body: { tables: trimmed, count: trimmed.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/tables\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/tables\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const grouped = await handReports().aggregate([
        { $match: { participantWallets: wallet } },
        {
          $group: {
            _id: '$table',
            handsPlayed: { $sum: 1 },
            wins: { $sum: { $cond: [{ $in: [wallet, { $ifNull: ['$winnerWallets', []] }] }, 1, 0] } },
            firstPlayedAt: { $min: '$settledAt' },
            lastPlayedAt: { $max: '$settledAt' },
            firstHand: { $min: '$handNumber' },
            lastHand: { $max: '$handNumber' },
          },
        },
        { $sort: { lastPlayedAt: -1 } },
        { $limit: intParam(url, 'limit', 100, 300) },
      ]).toArray();
      const ids = grouped.map((g) => g._id as string);
      const metaDocs = ids.length ? await tables().find({ _id: { $in: ids } }).toArray() : [];
      const metaById = new Map(metaDocs.map((t) => [t._id, t]));
      const result = grouped.map((g) => {
        const t = metaById.get(g._id as string);
        return {
          table: g._id,
          handsPlayed: g.handsPlayed,
          wins: g.wins,
          firstPlayedAt: g.firstPlayedAt,
          lastPlayedAt: g.lastPlayedAt,
          firstHand: g.firstHand,
          lastHand: g.lastHand,
          meta: t ? {
            gameType: t.gameType ?? null,
            tier: t.tier ?? null,
            smallBlind: t.smallBlind ?? null,
            bigBlind: t.bigBlind ?? null,
            entryAmount: t.entryAmount ?? null,
            tokenMint: t.tokenMint ?? null,
            maxPlayers: t.maxPlayers ?? null,
            isClosed: t.isClosed ?? null,
          } : null,
        };
      });
      return { status: 200, body: { tables: result, count: result.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/player\/([^/]+)\/tournaments\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/player\/([^/]+)\/tournaments\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const q: Record<string, unknown> = { players: wallet };
      const status = url.searchParams.get('status') || undefined;
      if (status) q.status = status;
      const docs = await tournaments().find(q).sort({ startedAt: -1 }).limit(intParam(url, 'limit', 50, 200)).toArray();
      return { status: 200, body: { tournaments: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/leaderboard\/?$/,
    handler: async (_req, url) => {
      const metric = url.searchParams.get('metric') || 'totalWinnings';
      const allowed = ['totalWinnings', 'tournamentsWon', 'handsWon', 'sngProfitSol', 'tournamentPokerEarned', 'sessionsPlayed'];
      const sortField = allowed.includes(metric) ? metric : 'totalWinnings';
      const docs = await players().find({}).sort({ [sortField]: -1 }).limit(intParam(url, 'limit', 25, 100)).toArray();
      return {
        status: 200,
        body: {
          metric: sortField,
          leaderboard: docs.map((d, i) => ({
            rank: i + 1,
            wallet: d._id,
            value: (d as Record<string, unknown>)[sortField] ?? 0,
            totalWinnings: d.totalWinnings,
            tournamentsWon: d.tournamentsWon,
            netProfitSol: d.totalWinnings - d.totalInvested,
            sngProfitSol: d.sngProfitSol ?? 0,
            tournamentPokerEarned: d.tournamentPokerEarned ?? 0,
          })),
        },
      };
    },
  },
  {
    method: 'GET',
    match: /^\/tournaments\/?$/,
    handler: async (_req, url) => {
      const q: Record<string, unknown> = {};
      const status = url.searchParams.get('status') || undefined;
      const tier = url.searchParams.get('tier');
      const gameType = url.searchParams.get('gameType');
      if (status) q.status = status;
      if (tier !== null && Number.isFinite(Number(tier))) q.tier = Number(tier);
      if (gameType !== null && Number.isFinite(Number(gameType))) q.gameType = Number(gameType);
      const docs = await tournaments().find(q).sort({ startedAt: -1 }).limit(intParam(url, 'limit', 50, 200)).toArray();
      return { status: 200, body: { tournaments: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/tournaments\/([^/]+)\/?$/,
    handler: async (_req, url) => {
      const tableId = pathPart(url, /^\/tournaments\/([^/]+)\/?$/);
      if (!tableId) return { status: 400, body: { error: 'missing tournament id' } };
      const doc = await tournaments().findOne({ _id: tableId });
      if (!doc) return { status: 404, body: { error: 'tournament not found' } };
      return { status: 200, body: { tournament: doc } };
    },
  },
  {
    method: 'GET',
    match: /^\/rake-ledger\/([^/]+)\/?$/,
    handler: async (_req, url) => {
      const tableId = pathPart(url, /^\/rake-ledger\/([^/]+)\/?$/);
      if (!tableId) return { status: 400, body: { error: 'missing table id' } };
      const docs = await rakeLedger().find({ table: tableId }).sort({ ts: -1 }).limit(500).toArray();
      return { status: 200, body: { entries: docs, count: docs.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/protocol-stats\/?$/,
    handler: async () => {
      const [legacyHandCount, settledHandCount, tournamentCount, rakeAgg, activePlayers] = await Promise.all([
        hands().countDocuments({}),
        handReports().countDocuments({}),
        tournaments().countDocuments({ status: 'completed' }),
        rakeLedger().aggregate<{ total: number }>([{ $group: { _id: null, total: { $sum: '$totalRake' } } }]).toArray(),
        players().countDocuments({ lastActive: { $gte: new Date(Date.now() - DAY_MS) } }),
      ]);
      return {
        status: 200,
        body: {
          handsAllTime: settledHandCount,
          settledHandsAllTime: settledHandCount,
          legacyHandsAllTime: legacyHandCount,
          tournamentsCompleted: tournamentCount,
          totalRakeLamports: rakeAgg[0]?.total ?? 0,
          playersActive24h: activePlayers,
        },
      };
    },
  },
  {
    method: 'GET',
    match: /^\/jackpots\/recent\/?$/,
    handler: async (_req, url) => {
      const receipts = await getRecentReceipts(intParam(url, 'limit', 50, 200));
      return { status: 200, body: { receipts, count: receipts.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/jackpots\/hand\/([A-Za-z0-9]+)\/(\d+)\/?$/,
    handler: async (_req, url) => {
      const m = url.pathname.match(/^\/jackpots\/hand\/([A-Za-z0-9]+)\/(\d+)\/?$/);
      const table = m?.[1] || '';
      const handNumber = Number(m?.[2] || NaN);
      if (!table || !Number.isFinite(handNumber)) return { status: 400, body: { error: 'bad request' } };
      const receipt = await getReceiptByHand(table, handNumber);
      if (!receipt) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: { receipt } };
    },
  },
  {
    method: 'GET',
    match: /^\/jackpots\/wallet\/([A-Za-z0-9]+)\/?$/,
    handler: async (_req, url) => {
      const wallet = pathPart(url, /^\/jackpots\/wallet\/([A-Za-z0-9]+)\/?$/);
      if (!wallet || !isPubkey(wallet)) return { status: 400, body: { error: 'invalid wallet pubkey' } };
      const hits = await getWalletJackpots(wallet, intParam(url, 'limit', 200, 500));
      return { status: 200, body: { wallet, hits, count: hits.length } };
    },
  },
  {
    method: 'GET',
    match: /^\/jackpots\/leaderboard\/?$/,
    handler: async (_req, url) => {
      const view = (url.searchParams.get('view') as 'top' | 'biggest' | 'recent') || 'top';
      if (!new Set(['top', 'biggest', 'recent']).has(view)) return { status: 400, body: { error: 'bad view' } };
      const entries = await getLeaderboard(view, intParam(url, 'limit', 25, 100));
      return { status: 200, body: { view, entries, count: entries.length } };
    },
  },
];

export function startServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url || '/', `http://localhost:${config.server.port}`);

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      try {
        const body = await getMetricsText();
        res.writeHead(200, { 'Content-Type': getMetricsContentType(), 'Cache-Control': 'no-store' });
        res.end(body);
        httpRequests.inc({ method: 'GET', route: '/metrics', status: '2xx' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error({ err: msg }, 'metrics handler failed');
        res.writeHead(500);
        res.end('# metrics error\n');
      }
      return;
    }

    const route = routes.find((r) => r.method === req.method && r.match.test(url.pathname));
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found', path: url.pathname }));
      httpRequests.inc({ method: req.method || 'GET', route: 'unknown', status: '4xx' });
      return;
    }

    const routeLabel = route.match.source;
    const endTimer = httpDuration.startTimer({ method: req.method || 'GET', route: routeLabel });
    try {
      const { status, body } = await route.handler(req, url);
      res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
      httpRequests.inc({
        method: req.method || 'GET',
        route: routeLabel,
        status: `${Math.floor(status / 100)}xx`,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ method: req.method, path: url.pathname, durationMs: Date.now() - startedAt, err: msg }, 'route handler failed');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
      httpRequests.inc({ method: req.method || 'GET', route: routeLabel, status: '5xx' });
    } finally {
      endTimer();
    }
  });

  server.listen(config.server.port, () => {
    log.info({ port: config.server.port }, 'indexer HTTP server listening');
  });

  return server;
}
