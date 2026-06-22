/**
 * SNG pool states — the 21 on-chain SngPool accounts (3 game types x 7 tiers),
 * push-driven via gRPC LaserStream.
 *
 * Why this exists: the lobby's "PLAYERS x/N" for each SNG pool is SngPool.waitingCount,
 * an on-chain field that changes on every join / leave / MATCH. Serving it from a
 * per-request RPC scan behind a 10s cache makes the count lag in BOTH directions
 * (fill and clear), and a crank-driven match never invalidated the cache at all.
 * Subscribing to the pool accounts makes the count reflect chain truth in real
 * time — no cache-invalidation timing, no client-side optimistic drift.
 *
 * Scope: this tracks the pool STATE (waitingCount, entry/fee, match flags). The
 * queue MEMBER wallets live in separate SngQueuePage accounts and are still read
 * on demand by /api/sitngos for the "am I queued" check — only the count (the
 * laggy display) moves here.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { getL1Stream } from '../ingest/l1-stream.ts';
import { publishTopic } from '../ws-gateway.ts';

// Must match the FastPoker program's SNG_POOL_SEED derivation.
const PROGRAM_ID = new PublicKey(config.program.id);
const SNG_POOL_SEED = 'sng_pool';
const GAME_TYPES = [0, 1, 2]; // heads_up, 6max, 9max
const TIERS = [0, 1, 2, 3, 4, 5, 6]; // Copper..Black

export interface SngPoolLite {
  pda: string;
  gameType: number;
  tier: number;
  maxPlayers: number;
  entryAmount: number;
  feeAmount: number;
  waitingCount: number;
  headPageIndex: number;
  tailPageIndex: number;
  matchEligibleAt: number;
  activeMatchSet: boolean;
  slot: number;
}

// Derive the 21 fixed pool PDAs once. pdaStr -> {gameType, tier}.
const POOL_META = new Map<string, { gameType: number; tier: number }>();
const POOL_PDAS: string[] = [];
for (const gameType of GAME_TYPES) {
  for (const tier of TIERS) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SNG_POOL_SEED), Buffer.from([gameType]), Buffer.from([tier])],
      PROGRAM_ID,
    );
    const s = pda.toBase58();
    POOL_META.set(s, { gameType, tier });
    POOL_PDAS.push(s);
  }
}

// pda -> latest parsed state. Only pools that actually exist on-chain land here.
const pools = new Map<string, SngPoolLite>();
let asOfMs = 0;
let connection: Connection | null = null;
let started = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
// Safety re-seed: the stream is the primary update path, but a silent gRPC drop
// across a reconnect would leave the cache frozen (re-introducing the stuck-count
// bug). A slow batched re-read heals that. Pushes are the index; this is insurance.
const SAFETY_RESEED_MS = 5 * 60_000;

function getConn(): Connection {
  if (!connection) connection = new Connection(config.rpc.url, 'confirmed');
  return connection;
}

// Mirror of client parseSngPool (onchain-game.ts) up to activeMatchSet. Reads
// the fields the lobby needs; offsets MUST stay in lockstep with the contract.
function parseSngPoolLite(pda: string, data: Buffer, slot: number): SngPoolLite | null {
  if (data.length < 84) return null;
  let offset = 8; // skip 8-byte anchor discriminator
  const gameType = data.readUInt8(offset); offset += 1;
  const tier = data.readUInt8(offset); offset += 1;
  const maxPlayers = data.readUInt8(offset); offset += 1;
  const entryAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
  const feeAmount = Number(data.readBigUInt64LE(offset)); offset += 8;
  const waitingCount = data.readUInt32LE(offset); offset += 4;
  offset += 8; // nextTicket u64
  const headPageIndex = data.readUInt16LE(offset); offset += 2;
  const tailPageIndex = data.readUInt16LE(offset); offset += 2;
  const matchEligibleAt = Number(data.readBigInt64LE(offset)); offset += 8;
  offset += 32; // activeMatch pubkey
  const activeMatchSet = data.readUInt8(offset) !== 0;
  return {
    pda, gameType, tier, maxPlayers, entryAmount, feeAmount,
    waitingCount, headPageIndex, tailPageIndex, matchEligibleAt, activeMatchSet, slot,
  };
}

function applyUpdate(pda: string, data: Buffer, slot: number): void {
  const meta = POOL_META.get(pda);
  if (!meta) return; // not one of our pool PDAs
  const prev = pools.get(pda);
  // Slot guard: never let an out-of-order stream event regress a newer state.
  if (prev && slot > 0 && slot < prev.slot) return;
  const parsed = parseSngPoolLite(pda, data, slot);
  if (!parsed) return;
  pools.set(pda, parsed);
  asOfMs = Date.now();
  publishTopic('sng_pools', getSngPoolStates());
}

/** One batched read to seed all 21 pools before the stream connects. */
async function seed(): Promise<void> {
  try {
    const keys = POOL_PDAS.map((s) => new PublicKey(s));
    const infos = await getConn().getMultipleAccountsInfo(keys, 'confirmed');
    for (let i = 0; i < keys.length; i++) {
      const info = infos[i];
      if (!info) continue;
      const parsed = parseSngPoolLite(POOL_PDAS[i], Buffer.from(info.data), 0);
      if (!parsed) continue;
      const prev = pools.get(POOL_PDAS[i]);
      // Don't let a lagging confirmed-RPC reseed regress a stream-fresh waitingCount.
      if (prev && prev.slot > 0) continue;
      pools.set(POOL_PDAS[i], parsed);
    }
    asOfMs = Date.now();
  } catch (err) {
    console.error('[sng-pools] seed failed:', err instanceof Error ? err.message : err);
  }
}

export function getSngPoolStates(): { pools: SngPoolLite[]; asOfMs: number } {
  return { pools: Array.from(pools.values()), asOfMs };
}

export function startSngPoolsCache(): void {
  if (started) return;
  started = true;
  // Seed first so the endpoint isn't empty for the first 1-2s, then ride the stream.
  void seed();
  const stream = getL1Stream();
  if (stream) {
    for (const pda of POOL_PDAS) stream.watch(pda);
    stream.on('account-update', (u) => {
      if (!POOL_META.has(u.pubkey)) return;
      applyUpdate(u.pubkey, u.data, u.slot);
    });
    // Re-seed on every (re)connect: the stream replays nothing across a drop, so
    // anything that changed during the gap would otherwise stay stale until the
    // 5-min safety poll. One batched read snaps the cache back to truth at once.
    stream.on('connected', () => { void seed(); });
    console.log(`[sng-pools] subscribed ${POOL_PDAS.length} pool PDAs via gRPC LaserStream`);
  } else {
    console.log('[sng-pools] no stream; serving seeded snapshot only (set STREAM_API_KEY/STREAM_ENDPOINT for live)');
  }
  intervalHandle = setInterval(() => { void seed(); }, SAFETY_RESEED_MS);
}

export function stopSngPoolsCache(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
