/**
 * Live Table-account cache — every on-chain `Table` (cash + SNG), push-driven via
 * gRPC LaserStream, keyed by PDA. Stores the RAW account (owner + data + slot) so
 * consumers parse with their own offset maps (the lobby's parseTable, the game
 * poll's owner/delegation check) — the indexer doesn't need the full Table layout.
 *
 * Why: this is the source for the two heaviest RPC lines —
 *   - lobby /api/tables/list (a 60s-cached getProgramAccounts) → live + 0 gPA
 *   - the game poll's per-poll L1 getAccountInfo(table) owner-check (the ~896k/day
 *     line) → served push-fresh. Because the stream pushes the undelegate the
 *     instant ownership flips, this is SAFER than a blind client TTL: no
 *     stale-TEE-shadow window. Consumers fall back to a direct read on miss/stale.
 *
 * Discovery is automatic: a program-level filter (owner ∈ {program, delegation} +
 * Table discriminator) means newly-created tables stream in with no discovery loop.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'crypto';
import { config } from '../config.ts';
import { getL1Stream } from '../ingest/l1-stream.ts';
import { publishTopic } from '../ws-gateway.ts';

const PROGRAM_ID = new PublicKey(config.program.id);
const PROGRAM_ID_STR = PROGRAM_ID.toBase58();
// Delegated tables are owned by the MagicBlock delegation program on L1.
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const DELEGATION_PROGRAM_STR = DELEGATION_PROGRAM.toBase58();
// Anchor account discriminator = sha256("account:Table")[0..8]. base58 for the
// geyser memcmp filter; raw bytes to confirm matches in the shared handler.
const TABLE_DISC = createHash('sha256').update('account:Table').digest().subarray(0, 8);
const TABLE_DISC_B58 = bs58.encode(TABLE_DISC);
const SAFETY_RESEED_MS = 5 * 60_000;

export interface TableLite {
  pubkey: string;
  owner: string;
  dataB64: string;
  lamports: number;
  slot: number;
}

const tablesByPda = new Map<string, TableLite>();
let asOfMs = 0;
let connection: Connection | null = null;
let started = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function getConn(): Connection {
  if (!connection) connection = new Connection(config.rpc.url, 'confirmed');
  return connection;
}

function isTable(owner: string, data: Buffer): boolean {
  if (data.length < 8) return false;
  if (owner !== PROGRAM_ID_STR && owner !== DELEGATION_PROGRAM_STR) return false;
  return data.subarray(0, 8).equals(TABLE_DISC);
}

function applyUpdate(pubkey: string, owner: string, data: Buffer, lamports: number, slot: number): void {
  if (!isTable(owner, data)) return;
  const prev = tablesByPda.get(pubkey);
  if (prev && slot > 0 && slot < prev.slot) return; // slot-guard out-of-order events
  tablesByPda.set(pubkey, { pubkey, owner, dataB64: data.toString('base64'), lamports, slot });
  asOfMs = Date.now();
  // Note: broadcast omitted per-update to avoid flooding; lobby polls /v1/tables.
}

async function seed(): Promise<void> {
  try {
    const filters = [{ memcmp: { offset: 0, bytes: bs58.encode(TABLE_DISC) } }];
    const [undeleg, deleg] = await Promise.all([
      getConn().getProgramAccounts(PROGRAM_ID, { filters }).catch(() => []),
      getConn().getProgramAccounts(DELEGATION_PROGRAM, { filters }).catch(() => []),
    ]);
    // Dedup across both programs, preferring the PROGRAM-owned (authoritative)
    // entry. During an undelegate a table can briefly appear under BOTH programs
    // in two concurrent confirmed reads; a stale DELEGATION-owned row must not win
    // last-write (it would flip the cached owner back to "delegated" and reopen
    // the stale-TEE-shadow window the game-poll owner check relies on being closed).
    const fresh = new Map<string, { owner: string; data: Buffer; lamports: number }>();
    for (const { pubkey, account } of [...undeleg, ...deleg]) {
      const data = Buffer.from(account.data);
      const owner = account.owner.toBase58();
      if (!isTable(owner, data)) continue;
      const key = pubkey.toBase58();
      const ex = fresh.get(key);
      if (ex && ex.owner === PROGRAM_ID_STR && owner !== PROGRAM_ID_STR) continue;
      fresh.set(key, { owner, data, lamports: account.lamports });
    }
    for (const [key, e] of fresh) {
      const prev = tablesByPda.get(key);
      // Never let a lagging confirmed-RPC reseed regress a stream-fresh entry
      // (slot>0) — once the LaserStream has pushed, it's authoritative.
      if (prev && prev.slot > 0) continue;
      tablesByPda.set(key, { pubkey: key, owner: e.owner, dataB64: e.data.toString('base64'), lamports: e.lamports, slot: 0 });
    }
    asOfMs = Date.now();
  } catch (err) {
    console.error('[tables] seed failed:', err instanceof Error ? err.message : err);
  }
}

export function getTable(pubkey: string): TableLite | null {
  return tablesByPda.get(pubkey) ?? null;
}

export function tablesAsOfMs(): number {
  return asOfMs;
}

export function getAllTables(): { tables: TableLite[]; asOfMs: number } {
  return { tables: Array.from(tablesByPda.values()), asOfMs };
}

export function startTablesCache(): void {
  if (started) return;
  started = true;
  void seed();
  const stream = getL1Stream();
  if (stream) {
    stream.watchProgram('tables', {
      owner: [PROGRAM_ID_STR, DELEGATION_PROGRAM_STR],
      filters: [{ memcmp: { offset: 0, base58: TABLE_DISC_B58 } }],
    });
    stream.on('account-update', (u) => {
      // The shared account-update fires for every group; isTable() filters to ours.
      applyUpdate(u.pubkey, u.owner, u.data, u.lamports, u.slot);
    });
    stream.on('connected', () => { void seed(); });
    console.log('[tables] subscribed via gRPC LaserStream (owner+discriminator filter)');
  } else {
    console.log('[tables] no stream; serving seeded snapshot only');
  }
  intervalHandle = setInterval(() => { void seed(); }, SAFETY_RESEED_MS);
}

export function stopTablesCache(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
