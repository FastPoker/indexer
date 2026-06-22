import {
  tables, hands, handReports, handReportChunks, players, earnings,
  rakeLedger, tournaments, cursor, jackpotReceipts,
} from './db.ts';

/**
 * Idempotent index creation. Safe to call on every boot.
 */
export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    tables().createIndex({ isClosed: 1, createdAt: -1 }),
    tables().createIndex({ authority: 1 }),
    tables().createIndex({ 'players.wallet': 1 }),
    hands().createIndex({ tableId: 1, handNumber: 1 }, { unique: true }),
    hands().createIndex({ settledAt: -1 }),
    hands().createIndex({ winners: 1, settledAt: -1 }),
    handReports().createIndex({ table: 1, handNumber: 1 }, { unique: true }),
    // Powers the table-stats domain (lobby Avg Pot / VPIP / Hnd-Hr aggregation).
    handReports().createIndex({ table: 1, settledAt: -1 }),
    handReports().createIndex({ participantWallets: 1, settledAt: -1 }),
    handReports().createIndex({ winnerWallets: 1, settledAt: -1 }),
    handReports().createIndex({ operatorWallets: 1, settledAt: -1 }),
    handReports().createIndex({ settledAt: -1 }),
    handReportChunks().createIndex({ table: 1, handNumber: 1, payloadHash: 1, chunkIdx: 1 }),
    handReportChunks().createIndex({ seenAt: -1 }),
    players().createIndex({ lastActive: -1 }),
    players().createIndex({ totalWinnings: -1 }),
    players().createIndex({ tournamentsWon: -1 }),
    earnings().createIndex({ player: 1, ts: -1 }),
    earnings().createIndex({ table: 1, ts: -1 }),
    earnings().createIndex({ kind: 1, ts: -1 }),
    rakeLedger().createIndex({ table: 1, ts: -1 }),
    rakeLedger().createIndex({ ts: -1 }),
    tournaments().createIndex({ status: 1, startedAt: -1 }),
    tournaments().createIndex({ players: 1, startedAt: -1 }),
    tournaments().createIndex({ winner: 1, endedAt: -1 }),
    tournaments().createIndex({ tier: 1, gameType: 1, status: 1 }),
    cursor().createIndex({ _id: 1 }),
    // Jackpot receipts (JPV1) — match the SQLite indexes we had on the
    // standalone jackpot-indexer (backend/jackpot-indexer.ts).
    jackpotReceipts().createIndex({ table: 1, handNumber: 1 }, { unique: true }),
    jackpotReceipts().createIndex({ slot: -1 }),
    jackpotReceipts().createIndex({ blockTime: -1 }),
    jackpotReceipts().createIndex({ miniHit: 1, slot: -1 }),
    jackpotReceipts().createIndex({ grandHit: 1, slot: -1 }),
    // TTLs — bound storage growth without manual pruning.
    // Chunks are intermediates: once a HandReport reassembles, the chunks
    // can be aged out. 7d gives slack for late-arriving chunks.
    handReportChunks().createIndex({ seenAt: 1 }, { expireAfterSeconds: 7 * 24 * 60 * 60 }),
    // Hand reports + hands: 90d hot window. Operators who want longer history
    // can raise this TTL or archive these collections with their own storage.
    handReports().createIndex({ settledAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }),
    hands().createIndex({ settledAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }),
    // Earnings: 180d covers a season + PnL panel range.
    earnings().createIndex({ ts: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 }),
    // Rake ledger: 1y for accounting.
    rakeLedger().createIndex({ ts: 1 }, { expireAfterSeconds: 365 * 24 * 60 * 60 }),
  ]);
}

