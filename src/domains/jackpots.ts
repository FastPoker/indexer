/**
 * Jackpot receipts (JPV1 SPL Memo CPI) — absorbed into the main indexer.
 *
 * Replaces backend/jackpot-indexer.ts. Wire format and field layout are
 * byte-for-byte identical with the standalone service; the only differences:
 *  - storage moves from a local SQLite file to the shared Mongo DB
 *  - decoding runs inside the existing transaction event loop (one WS, one
 *    gRPC stream, instead of two)
 *  - the HTTP routes live on the indexer's port 3001 instead of port 3199
 *
 * Keep this file in sync with any client-side JPV1 decoder (byte offsets,
 * magic constants).
 */
import { PublicKey } from '@solana/web3.js';
import { jackpotReceipts, handReports, JackpotReceiptDoc } from '../db.ts';
import { publishTopic } from '../ws-gateway.ts';
import { ingestedJackpotReceipts } from '../metrics.ts';

const JPV1_MAGIC = 'JPV1';
const JPV1_PAYLOAD_LEN = 131;
const JPV1_VERSION = 1;
const JPV1_MEMO_PREFIX = 'JPV1B64:';
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const JPV1_MAGIC_BYTES = Buffer.from(JPV1_MAGIC, 'utf8');

export interface JackpotReceipt {
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
}

// ─── Decoder ────────────────────────────────────────────────────────────────

function bytesEquals(a: Uint8Array, b: Uint8Array | number[], len: number): boolean {
  if (a.length < len) return false;
  for (let i = 0; i < len; i++) {
    if (a[i] !== (b as any)[i]) return false;
  }
  return true;
}
function readU16LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}
function readU64LEAsString(buf: Uint8Array, off: number): string {
  const view = Buffer.from(buf.buffer, buf.byteOffset + off, 8);
  return view.readBigUInt64LE(0).toString();
}
function readU64LEAsNumber(buf: Uint8Array, off: number): number {
  const view = Buffer.from(buf.buffer, buf.byteOffset + off, 8);
  return Number(view.readBigUInt64LE(0));
}
function readU128LEAsString(buf: Uint8Array, off: number): string {
  const lo = Buffer.from(buf.buffer, buf.byteOffset + off, 8).readBigUInt64LE(0);
  const hi = Buffer.from(buf.buffer, buf.byteOffset + off + 8, 8).readBigUInt64LE(0);
  return ((hi << BigInt(64)) | lo).toString();
}
function toHex(buf: Uint8Array): string {
  return Buffer.from(buf).toString('hex');
}

export function parseJpv1Bytes(
  bytes: Buffer | Uint8Array,
  ctx?: { txSig?: string; slot?: number; blockTime?: number | null },
): JackpotReceipt | null {
  if (bytes.length !== JPV1_PAYLOAD_LEN) return null;
  const buf = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  if (!bytesEquals(buf, JPV1_MAGIC_BYTES, 4)) return null;
  if (buf[4] !== JPV1_VERSION) return null;
  const tablePk = new PublicKey(buf.subarray(5, 37));
  return {
    table: tablePk.toBase58(),
    handNumber: readU64LEAsNumber(buf, 37),
    activeMask: readU16LE(buf, 45),
    miniOptInMask: readU16LE(buf, 47),
    miniHit: buf[49] === 1,
    miniPaidTotal: readU64LEAsString(buf, 50),
    miniPerSeatLamports: readU64LEAsString(buf, 58),
    grandHit: buf[66] === 1,
    grandUnrefinedAmount: readU64LEAsString(buf, 67),
    grandAccDelta: readU128LEAsString(buf, 75),
    hitSequence: readU64LEAsNumber(buf, 91),
    rollingHash: toHex(buf.subarray(99, 131)),
    txSig: ctx?.txSig ?? '',
    slot: ctx?.slot ?? 0,
    blockTime: ctx?.blockTime ?? null,
  };
}

const BS58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str: string): Buffer {
  let n = BigInt(0);
  for (const c of str) {
    const i = BS58.indexOf(c);
    if (i < 0) throw new Error('Bad b58 char: ' + c);
    n = n * BigInt(58) + BigInt(i);
  }
  const hexValue = n.toString(16);
  const padded = hexValue.length % 2 ? '0' + hexValue : hexValue;
  const bytes = Buffer.from(padded, 'hex');
  const leading = str.match(/^1*/)?.[0].length ?? 0;
  return Buffer.concat([Buffer.alloc(leading), bytes]);
}

function ixDataToBuffer(data: unknown): Buffer {
  if (typeof data === 'string') return base58Decode(data);
  if (Array.isArray(data)) return Buffer.from(data as number[]);
  if (data && typeof data === 'object' && 'type' in (data as any) && (data as any).type === 'Buffer') {
    return Buffer.from((data as any).data ?? []);
  }
  return Buffer.alloc(0);
}

function memoBytesToJpv1Payload(dataBuf: Buffer): Buffer | null {
  if (dataBuf.length === JPV1_PAYLOAD_LEN) return dataBuf;
  const text = dataBuf.toString('utf8');
  if (!text.startsWith(JPV1_MEMO_PREFIX)) return null;
  try {
    const decoded = Buffer.from(text.slice(JPV1_MEMO_PREFIX.length), 'base64');
    return decoded.length === JPV1_PAYLOAD_LEN ? decoded : null;
  } catch {
    return null;
  }
}

function keyToString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const obj = value as any;
    if (typeof obj.pubkey === 'string') return obj.pubkey;
    if (typeof obj.pubkey?.toBase58 === 'function') return obj.pubkey.toBase58();
    if (typeof obj.toBase58 === 'function') return obj.toBase58();
    if (typeof obj.toString === 'function') {
      const s = obj.toString();
      return s === '[object Object]' ? null : s;
    }
  }
  return null;
}

function keyAt(message: any, index: number, loadedAddresses?: any): string | null {
  const staticKeys = message?.accountKeys ?? message?.staticAccountKeys ?? [];
  if (index < staticKeys.length) return keyToString(staticKeys[index]);
  const loadedWritable = loadedAddresses?.writable ?? [];
  const loadedReadonly = loadedAddresses?.readonly ?? [];
  const loaded = [...loadedWritable, ...loadedReadonly];
  return keyToString(loaded[index - staticKeys.length]);
}

export function extractJpv1FromTx(tx: any): JackpotReceipt[] {
  if (!tx) return [];
  const sig = tx.transaction?.signatures?.[0] ?? '';
  const slot = tx.slot ?? 0;
  const blockTime = tx.blockTime ?? null;
  const message: any = tx.transaction?.message ?? {};
  const loadedAddresses = (tx.meta as any)?.loadedAddresses;

  const receipts: JackpotReceipt[] = [];
  const inspect = (ix: any) => {
    let programId: string | null = null;
    let dataBuf: Buffer = Buffer.alloc(0);

    if (ix?.programId) programId = keyToString(ix.programId);
    else if (typeof ix?.programIdIndex === 'number')
      programId = keyAt(message, ix.programIdIndex, loadedAddresses);

    if (programId !== MEMO_PROGRAM_ID) return;

    if (typeof ix?.data === 'string' || Array.isArray(ix?.data)) {
      dataBuf = ixDataToBuffer(ix.data);
    } else if (ix?.parsed && typeof ix.parsed === 'string') {
      dataBuf = Buffer.from(ix.parsed, 'utf8');
    }

    const payload = memoBytesToJpv1Payload(dataBuf);
    if (!payload) return;
    const r = parseJpv1Bytes(payload, { txSig: sig, slot, blockTime });
    if (r) receipts.push(r);
  };

  for (const ix of message?.instructions ?? []) inspect(ix);
  for (const group of (tx.meta?.innerInstructions ?? [])) {
    for (const ix of group.instructions ?? []) inspect(ix);
  }
  return receipts;
}

// ─── Ingest ─────────────────────────────────────────────────────────────────

/**
 * Persist one or more JPV1 receipts. Idempotent via the (table, handNumber)
 * unique index. Called from the tx ingest path (live.ts / backfill.ts).
 */
export async function ingestJackpotReceipts(receipts: JackpotReceipt[]): Promise<number> {
  if (receipts.length === 0) return 0;
  const docs: JackpotReceiptDoc[] = receipts.map((r) => ({
    _id: `${r.table}:${r.handNumber}`,
    table: r.table,
    handNumber: r.handNumber,
    activeMask: r.activeMask,
    miniOptInMask: r.miniOptInMask,
    miniHit: r.miniHit,
    miniPaidTotal: r.miniPaidTotal,
    miniPerSeatLamports: r.miniPerSeatLamports,
    grandHit: r.grandHit,
    grandUnrefinedAmount: r.grandUnrefinedAmount,
    grandAccDelta: r.grandAccDelta,
    hitSequence: r.hitSequence,
    rollingHash: r.rollingHash,
    txSig: r.txSig,
    slot: r.slot,
    blockTime: r.blockTime,
    ingestedAt: new Date(),
  }));
  let inserted = 0;
  for (const doc of docs) {
    try {
      const res = await jackpotReceipts().updateOne(
        { _id: doc._id },
        { $setOnInsert: doc },
        { upsert: true },
      );
      if (res.upsertedCount === 1) {
        inserted++;
        ingestedJackpotReceipts.inc();
        // Push to WS fanout — every connected client gets the receipt in real
        // time without paying a per-client logs subscription. Replaces the per-
        // Clients may subscribe to this topic over the indexer WebSocket.
        try { publishTopic('jackpot_receipt', shapeForApi(doc)); } catch {}
      }
    } catch (err) {
      console.warn('[jackpots] ingest failed for', doc._id, err instanceof Error ? err.message : err);
    }
  }
  return inserted;
}

// ─── Readers ────────────────────────────────────────────────────────────────

function shapeForApi(doc: JackpotReceiptDoc) {
  return {
    table: doc.table,
    handNumber: doc.handNumber,
    activeMask: doc.activeMask,
    miniOptInMask: doc.miniOptInMask,
    miniHit: doc.miniHit,
    miniPaidTotal: Number(doc.miniPaidTotal),
    miniPerSeatLamports: Number(doc.miniPerSeatLamports),
    grandHit: doc.grandHit,
    grandUnrefinedAmount: Number(doc.grandUnrefinedAmount),
    grandAccDelta: doc.grandAccDelta,
    hitSequence: doc.hitSequence,
    rollingHash: doc.rollingHash,
    txSig: doc.txSig,
    slot: doc.slot,
    blockTime: doc.blockTime,
  };
}

export async function getRecentReceipts(limit = 50): Promise<unknown[]> {
  const docs = await jackpotReceipts()
    .find({})
    .sort({ slot: -1 })
    .limit(Math.min(Math.max(1, limit), 500))
    .toArray();
  return docs.map(shapeForApi);
}

export async function getReceiptByHand(table: string, handNumber: number): Promise<unknown | null> {
  const doc = await jackpotReceipts().findOne({ table, handNumber });
  return doc ? shapeForApi(doc) : null;
}

export async function getLeaderboard(
  view: 'top' | 'biggest' | 'recent',
  limit = 25,
): Promise<unknown[]> {
  const cap = Math.min(Math.max(1, limit), 200);
  let cursor;
  if (view === 'biggest') {
    cursor = jackpotReceipts()
      .find({ grandHit: true })
      .sort({ grandUnrefinedAmount: -1, slot: -1 })
      .limit(cap);
  } else if (view === 'recent') {
    cursor = jackpotReceipts()
      .find({ $or: [{ grandHit: true }, { miniHit: true }] })
      .sort({ slot: -1 })
      .limit(cap);
  } else {
    // 'top' — sort by hit_sequence (the chain's own ordering of grand hits)
    cursor = jackpotReceipts()
      .find({ grandHit: true })
      .sort({ hitSequence: -1 })
      .limit(cap);
  }
  const docs = await cursor.toArray();
  return docs.map(shapeForApi);
}

// ─── Per-wallet attribution ───────────────────────────────────────────────
//
// A JPV1 receipt carries SEAT MASKS, not wallets, so attribution is a join
// against the hand_reports roster for the same (table, handNumber):
//   - MINI/Lucky: every seat in `miniOptInMask` was paid `miniPerSeatLamports`.
//     Resolve each opted-in seat to its wallet via the hand report's action
//     roster (actor → wallet) and credit the matching wallet.
//   - GRAND/Royal: NOT attributable from a JPV1 receipt. The Grand is a GLOBAL
//     progressive: on a hit the whole pool is divided by `active_grand_weight`
//     and added to a global accumulator (settle_sng_jackpots.rs:240), then EVERY
//     active SNG entry across ALL tables accrues its share = `grand_weight ×
//     (acc − checkpoint)` into `pending_grand_unrefined`. So it pays everyone who
//     was active (pro-rata), not the champion or the hand winner — and the
//     winners aren't even all on the trigger table's receipt. Per-wallet Grand
//     therefore needs the per-entry accrual (a `JackpotGrandPaid {wallet, amount}`
//     event, or indexing JackpotEntry.pending_grand realization), NOT this join.
//     Until that exists we DO NOT attribute Grand here — better to show nothing
//     than to credit the wrong wallet on a real-money product.
//
// This is authoritative for Mini (matches the on-chain distribute_prizes credit
// into each opted-in Player PDA).

export interface WalletJackpotHit {
  table: string;
  handNumber: number;
  kind: 'mini' | 'grand' | 'both';
  /** Lamports (SOL) credited to THIS wallet from the Mini pool (0 if not a Mini winner). */
  miniLamports: number;
  /** Always 0 — Grand is a global progressive, not attributable from a receipt (see header). */
  grandUnrefined: number;
  txSig: string;
  slot: number;
  blockTime: number | null;
  /** True when the seat→wallet roster for the hand was unavailable, so Mini
   *  attribution could not be proven (the hit is omitted, not guessed). */
  rosterMissing?: boolean;
}

export async function getWalletJackpots(wallet: string, limit = 200): Promise<WalletJackpotHit[]> {
  const cap = Math.min(Math.max(1, limit), 1000);
  // Only Mini hits are per-wallet attributable from a receipt (Grand is a global
  // progressive — see header). Query miniHit only.
  const receipts = await jackpotReceipts()
    .find({ miniHit: true })
    .sort({ slot: -1 })
    .limit(cap)
    .toArray();
  if (receipts.length === 0) return [];

  // Batch-load the matching hand reports for the seat→wallet roster + winners.
  const ids = receipts.map((r) => `${r.table}:${r.handNumber}`);
  const reports = await handReports().find({ _id: { $in: ids } }).toArray();
  const reportById = new Map(reports.map((d) => [d._id, d]));

  const hits: WalletJackpotHit[] = [];
  for (const r of receipts) {
    const report = reportById.get(`${r.table}:${r.handNumber}`);
    let miniLamports = 0;
    const grandUnrefined = 0; // Grand is a global progressive — never credited here.
    let rosterMissing = false;

    if (!report) {
      rosterMissing = true;
    } else {
      const bySeat = new Map<number, string>();
      for (const a of report.record?.actions ?? []) {
        if (a && typeof a.actor === 'number' && a.wallet) bySeat.set(a.actor, a.wallet);
      }
      for (let seat = 0; seat < 9; seat++) {
        if ((r.miniOptInMask & (1 << seat)) === 0) continue;
        if (bySeat.get(seat) === wallet) {
          miniLamports = Number(r.miniPerSeatLamports);
          break;
        }
      }
    }

    if (miniLamports > 0 || grandUnrefined > 0) {
      hits.push({
        table: r.table,
        handNumber: r.handNumber,
        kind: miniLamports > 0 && grandUnrefined > 0 ? 'both' : grandUnrefined > 0 ? 'grand' : 'mini',
        miniLamports,
        grandUnrefined,
        txSig: r.txSig,
        slot: r.slot,
        blockTime: r.blockTime,
        ...(rosterMissing ? { rosterMissing: true } : {}),
      });
    }
  }
  return hits;
}
