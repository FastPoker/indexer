import { MongoClient, Db, Collection, ObjectId } from 'mongodb';
import { config } from './config.ts';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connect(): Promise<Db> {
  if (db) return db;
  client = await MongoClient.connect(config.mongo.uri, {
    // Long-running write-heavy service. Larger pool because we run parallel
    // bulk upserts on every ingest + serve REST queries from the same client.
    maxPoolSize: 50,
    minPoolSize: 5,
    maxIdleTimeMS: 60_000,
    waitQueueTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 5_000,
    connectTimeoutMS: 5_000,
    socketTimeoutMS: 45_000,
    retryReads: true,
    retryWrites: true,
    w: 'majority',
  });
  db = client.db(config.mongo.db);
  return db;
}

export async function close(): Promise<void> {
  if (client) await client.close();
  client = null;
  db = null;
}

// ─── Collection schemas ─────────────────────────────────────────────────

export interface TableDoc {
  _id: string;                 // table pubkey
  tableId?: string;            // hex of table_id bytes (for cross-ref)
  authority: string;
  maxPlayers: number;
  smallBlind: number;
  bigBlind: number;
  isClosed: boolean;
  finalRake?: number;
  createdAt: Date;
  closedAt?: Date;
  createTxSig: string;
  closeTxSig?: string;
  // Metadata hydrated once via getAccountInfo on TableCreated — static for
  // the table's lifetime. Absent when the Table account was already gone
  // by the time we tried to fetch it (closed between event and fetch).
  gameType?: number;
  tier?: number;
  entryAmount?: number;
  feeAmount?: number;
  tokenMint?: string;
  rakeCap?: number;
  isPrivate?: boolean;
  isUserCreated?: boolean;
  creator?: string;
  buyInType?: number;
  players: Array<{
    wallet: string;
    seat: number;
    joinedAt: Date;
    leftAt?: Date;
    buyIn: number;
    cashedOut?: number;
  }>;
  lastUpdatedSlot: number;
}

export interface HandDoc {
  _id: string;                 // `${tableId}:${handNumber}`
  tableId: string;
  handNumber: number;
  winners: string[];           // wallets
  amounts: number[];
  rakeCollected: number;
  settledAt: Date;             // block time
  txSig: string;
  slot: number;
}

export interface ParsedSeatCards {
  seat: number;
  card1: string;
  card2: string;
}

export interface HandReportMeta {
  version: number;
  status: 'l1-committed';
  payloadBytes: number;
  payloadHash: string;
  chunkCount: number;
  chunksPresent: number;
  txs: string[];
}

export interface HandActionEvent {
  kind: number;
  street: number;
  actor: number;
  action: number;
  handNumber: number;
  amount: number;
  pot: number;
  wallet: string;
  operator: string;
  aux: number;
  duel?: {
    stage: number;
    round: number;
    seatA: number;
    seatB: number;
    choiceA: number;
    choiceB: number;
    winner: number;
    loser: number;
    flags: number;
    blindLevel: number;
    aChips: number;
    bChips: number;
    board: string[];
    aHole: string[];
    bHole: string[];
  };
}

export interface ParsedHandRecord {
  handNumber: number;
  timestamp: number;
  merkleRoot: string;
  handSalt: string;
  communityCards: string[];
  shownCards: ParsedSeatCards[];
  winnersMask: number;
  winners: number[];
  pot: number;
  rake: number;
  sig: string;
  slot: number;
  source: 'hand-report-v1';
  rollingHash?: string;
  foldWin?: boolean;
  handReport?: HandReportMeta;
  actions?: HandActionEvent[];
}

export interface HandReportDoc {
  _id: string;                 // `${table}:${handNumber}`
  table: string;
  handNumber: number;
  source: 'hand-report-v1';
  record: ParsedHandRecord;
  payloadHash: string;
  payloadBytes: number;
  chunkCount: number;
  chunksPresent: number;
  txs: string[];
  participantWallets: string[];
  operatorWallets: string[];
  winnerSeats: number[];
  winnerWallets: string[];
  settledAt: Date;
  firstSeenAt: Date;
  updatedAt: Date;
  slot: number;
}

export interface HandReportChunkDoc {
  _id: string;                 // `${table}:${handNumber}:${payloadHash}:${chunkIdx}:${sig}`
  table: string;
  handNumber: number;
  chunkIdx: number;
  chunkCount: number;
  payloadHash: string;
  chunkHex: string;
  sig: string;
  slot: number;
  timestamp: number;
  seenAt: Date;
}

/**
 * Per-wallet aggregate stats derived from event streams. Every field is
 * derived — never trust PlayerAccount for these (the on-chain counters
 * were never wired, confirmed dead fields).
 */
export interface PlayerDoc {
  _id: string;                 // wallet pubkey
  registeredAt?: Date;         // from PlayerRegistered
  lastActive: Date;            // touched on any activity

  // Cash counters
  handsWon: number;
  sessionsPlayed: number;      // approx = count of PlayerJoined events (cash + SNG)
  cashSessions?: number;       // cash-only session count (cash_deposit rows)
  sngSessions?: number;        // SNG-only entry count (sng_buyin rows = tournaments entered)
  totalInvested: number;       // sum of PlayerJoined.buy_in (lamports)
  totalWinnings: number;       // sum of HandSettled winner amounts + SNG prizes
  cashNetSol: number;          // totalWinnings(cash-only) - totalInvested(cash-only)

  // SNG counters
  tournamentsPlayed: number;   // count of tournaments where wallet seated
  tournamentsWon: number;      // count of PrizesDistributed where winner==wallet
  itmCount: number;            // count of tournaments where wallet got a payout
  sngProfitSol: number;        // sum of SNG prizes minus buy-ins
  tournamentPokerEarned?: number; // protocol reward token units earned in SNG payouts

  // Made-hand achievement counters — derived from shown cards in hand_reports
  // by recomputeMadeHands(). Drive the ROYAL / STRAIGHT FLUSH / QUADS badges.
  royalCount?: number;
  straightFlushCount?: number;
  quadsCount?: number;

  // Streak / cash-out achievement counters, also materialized by
  // recomputeMadeHands(). All derived + backfillable from stored data:
  //  - bestWinStreak: longest run of consecutive won hands (HEATER, >=15).
  //  - bestActiveDayStreak: longest run of consecutive UTC days the wallet
  //    played a hand (7-DAY GRIND / streak-7, >=7).
  //  - doubledUp: true once any cash cash-out was >= 2x that seat's buy-in
  //    (DOUBLE UP).
  bestWinStreak?: number;
  bestActiveDayStreak?: number;
  doubledUp?: boolean;
  //  - allInPreflopWins: count of hands won after an explicit preflop all-in
  //    (ALL IN badge). Derived in recomputeMadeHands from the hand_report
  //    action stream (street Preflop=0 + AllIn action=5).
  allInPreflopWins?: number;
  //  - handReportsPlayed / handReportsWon: authoritative pots played / won
  //    across cash AND SNG, counted from hand_reports (participantWallets /
  //    winnerWallets). The legacy `handsPlayed`/`handsWon` above are L1-cash-only
  //    (event-driven) and the on-chain PDA counters are dead — these drive the
  //    FIRST HAND / FIRST BLOOD / 100 / 1K / 10K hand achievements.
  handReportsPlayed?: number;
  handReportsWon?: number;
}

/**
 * Transaction ledger — one doc per earning event (SNG prize, cash win,
 * cashout, rake claim). Used by /player/:wallet/earnings for the profile
 * "Recent Earnings" panel.
 */
export interface EarningDoc {
  _id: ObjectId;
  player: string;              // wallet
  // 'recovery' = returned principal from an incident/recovery path. Inserted
  // either by scripts/backfill-recovery.ts after a verified off-chain refund tx
  // or by the indexer when the contract logs a refund_failed_deposit recovery.
  kind: 'sng_prize' | 'cash_hand_win' | 'cashout' | 'creator_rake' | 'staker_claim' | 'cash_deposit' | 'sng_buyin' | 'sng_bust' | 'sng_refund' | 'recovery';
  table?: string;
  hand?: number;
  amount: number;              // lamports or token units
  tokenMint: string | 'SOL';
  ts: Date;
  txSig: string;
  place?: number;              // SNG finish place when applicable
  seat?: number;
  pnlAmount?: number;           // signed-flow amount used for PnL when different from amount
  gameplayLamports?: number;
  miniLamports?: number;
  rentLamports?: number;
  seated?: boolean;
}

/**
 * One doc per RakeDistributed event. Used for per-table rake audit and
 * protocol-wide rake dashboards.
 */
export interface RakeLedgerDoc {
  _id: ObjectId;
  table: string;
  totalRake: number;
  stakerShare: number;
  creatorShare: number;
  treasuryShare: number;
  ts: Date;
  txSig: string;
  slot: number;
}

/**
 * One doc per SNG instance (keyed on tableId). State machine:
 *   active (seats filling, hands being played)
 *   → completed (on PrizesDistributed)
 */
export interface TournamentDoc {
  _id: string;                 // table pubkey — same key as TableDoc
  gameType: number;
  tier?: number;
  maxPlayers?: number;
  entryAmount?: number;
  feeAmount?: number;
  tokenMint?: string;
  players: string[];           // wallets who were seated at any point
  winner?: string;
  prizePool?: number;
  payouts?: Array<{ wallet: string; amount: number; place?: number }>;
  status: 'active' | 'completed';
  startedAt: Date;
  endedAt?: Date;
  completeTxSig?: string;
}

export interface CursorDoc {
  _id: 'cursor';
  lastIndexedSignature?: string;
  lastIndexedSlot?: number;
  lastIndexedAt?: Date;
  backfillCompletedAt?: Date;
}

/**
 * One row per JPV1 receipt emitted via SPL Memo CPI on table hand-completion.
 * Replaces the standalone SQLite-backed jackpot-indexer (backend/jackpot-indexer.ts)
 * which used the same wire format but lived in a separate process.
 *
 * Numeric u64/u128 fields are stored as strings to avoid Mongo Long precision
 * issues; the API layer converts to number where safe.
 */
export interface JackpotReceiptDoc {
  _id: string;                  // `${table}:${handNumber}` — uniqueness lives here
  table: string;
  handNumber: number;
  activeMask: number;
  miniOptInMask: number;
  miniHit: boolean;
  miniPaidTotal: string;
  miniPerSeatLamports: string;
  grandHit: boolean;
  grandUnrefinedAmount: string;
  grandAccDelta: string;
  hitSequence: number;
  rollingHash: string;
  txSig: string;
  slot: number;
  blockTime: number | null;
  /** Mongo insert timestamp — used for "recent receipts" ordering when blockTime is missing. */
  ingestedAt: Date;
}

export function tables(): Collection<TableDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<TableDoc>('tables');
}

export function hands(): Collection<HandDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<HandDoc>('hands');
}

export function handReports(): Collection<HandReportDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<HandReportDoc>('hand_reports');
}

export function handReportChunks(): Collection<HandReportChunkDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<HandReportChunkDoc>('hand_report_chunks');
}

export function players(): Collection<PlayerDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<PlayerDoc>('players');
}

export function earnings(): Collection<EarningDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<EarningDoc>('earnings');
}

export function rakeLedger(): Collection<RakeLedgerDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<RakeLedgerDoc>('rake_ledger');
}

export function tournaments(): Collection<TournamentDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<TournamentDoc>('tournaments');
}

export function cursor(): Collection<CursorDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<CursorDoc>('cursor');
}

export function jackpotReceipts(): Collection<JackpotReceiptDoc> {
  if (!db) throw new Error('DB not connected');
  return db.collection<JackpotReceiptDoc>('jackpot_receipts');
}

export async function loadCursor(): Promise<CursorDoc> {
  const existing = await cursor().findOne({ _id: 'cursor' });
  return existing ?? { _id: 'cursor' };
}

export async function saveCursor(updates: Partial<CursorDoc>): Promise<void> {
  await cursor().updateOne(
    { _id: 'cursor' },
    { $set: { ...updates, lastIndexedAt: new Date() } },
    { upsert: true },
  );
}
