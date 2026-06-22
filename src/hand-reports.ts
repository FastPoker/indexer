import { Connection, ConfirmedSignatureInfo, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import {
  handReportChunks,
  handReports,
  HandReportDoc,
  ParsedHandRecord,
} from './db.ts';

const NOOP_PROGRAM_ID = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
const HRV1_MAGIC = 'HRV1';
const HRV1_HEADER_LEN = 81;
const HRV1_MAX_CHUNK_PAYLOAD = 800;
const HRV1_MAX_CHUNKS = 64;
const HRV1_MAX_ASSEMBLY_CANDIDATES = 256;
const ZERO_PUBKEY = PublicKey.default.toBase58();
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const SUITS = ['s', 'h', 'd', 'c'];

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
  return Buffer.alloc(0);
}

function keyToString(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value?.pubkey === 'string') return value.pubkey;
  if (typeof value?.toBase58 === 'function') return value.toBase58();
  if (typeof value?.toString === 'function') return value.toString();
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

function collectNoopData(txData: any): Buffer[] {
  const out: Buffer[] = [];
  const msg = txData?.transaction?.message ?? {};
  const loadedAddresses = txData?.meta?.loadedAddresses;

  const inspect = (ix: any) => {
    const pidIdx = ix?.programIdIndex ?? ix?.programAddressIndex;
    if (typeof pidIdx !== 'number') return;
    if (keyAt(msg, pidIdx, loadedAddresses) !== NOOP_PROGRAM_ID) return;
    const buf = ixDataToBuffer(ix.data);
    if (buf.length > 0) out.push(buf);
  };

  for (const ix of msg.instructions ?? msg.compiledInstructions ?? []) inspect(ix);
  for (const group of txData?.meta?.innerInstructions ?? []) {
    for (const ix of group.instructions ?? []) inspect(ix);
  }
  return out;
}

function hex(buf: Buffer): string {
  return buf.toString('hex');
}

function cardLabel(card: number): string {
  if (card === 255 || card > 51) return '??';
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

interface Hrv1Chunk {
  table: string;
  handNumber: number;
  chunkIdx: number;
  chunkCount: number;
  payloadHash: Buffer;
  chunkBytes: Buffer;
  sig: string;
  slot: number;
  timestamp: number;
}

function decodeHrv1Chunk(buf: Buffer, sig: string, slot: number, timestamp: number, tableFilter?: string): Hrv1Chunk | null {
  if (buf.length < HRV1_HEADER_LEN) return null;
  if (buf.subarray(0, 4).toString('utf8') !== HRV1_MAGIC) return null;
  const version = buf[4];
  if (version !== 1) return null;
  const table = new PublicKey(buf.subarray(5, 37)).toBase58();
  if (tableFilter && table !== tableFilter) return null;
  const chunkIdx = buf.readUInt16LE(45);
  const chunkCount = buf.readUInt16LE(47);
  const chunkBytes = buf.subarray(81);
  if (chunkCount === 0 || chunkCount > HRV1_MAX_CHUNKS) return null;
  if (chunkIdx >= chunkCount) return null;
  if (chunkBytes.length === 0 || chunkBytes.length > HRV1_MAX_CHUNK_PAYLOAD) return null;
  if (chunkIdx + 1 < chunkCount && chunkBytes.length !== HRV1_MAX_CHUNK_PAYLOAD) return null;
  return {
    table,
    handNumber: Number(buf.readBigUInt64LE(37)),
    chunkIdx,
    chunkCount,
    payloadHash: buf.subarray(49, 81),
    chunkBytes,
    sig,
    slot,
    timestamp,
  };
}

function parseHandReportPayload(payload: Buffer, meta: NonNullable<ParsedHandRecord['handReport']>, sig: string, slot: number, timestamp: number): ParsedHandRecord | null {
  const actions: NonNullable<ParsedHandRecord['actions']> = [];
  let settle: ParsedHandRecord | null = null;
  let offset = 0;

  while (offset < payload.length) {
    const kind = payload[offset];
    if (kind === 6) {
      if (offset + 160 > payload.length) break;
      const e = payload.subarray(offset, offset + 160);
      const handNumber = Number(e.readBigUInt64LE(1));
      const pot = Number(e.readBigUInt64LE(9));
      const rake = Number(e.readBigUInt64LE(17));
      const winnersMask = e.readUInt16LE(25);
      const foldWin = e[27] === 1;
      const communityCards = Array.from(e.subarray(28, 33)).map(cardLabel);
      const shownBytes = e.subarray(33, 51);
      const shownCards: ParsedHandRecord['shownCards'] = [];
      for (let seat = 0; seat < 9; seat++) {
        const c1 = shownBytes[seat * 2];
        const c2 = shownBytes[seat * 2 + 1];
        if (c1 !== 255 && c1 <= 51 && c2 !== 255 && c2 <= 51) {
          shownCards.push({ seat, card1: cardLabel(c1), card2: cardLabel(c2) });
        }
      }
      const winners: number[] = [];
      for (let i = 0; i < 9; i++) {
        if (winnersMask & (1 << i)) winners.push(i);
      }

      settle = {
        handNumber,
        timestamp,
        merkleRoot: hex(e.subarray(51, 83)),
        handSalt: hex(e.subarray(83, 115)),
        rollingHash: hex(e.subarray(115, 147)),
        communityCards,
        shownCards,
        winnersMask,
        winners,
        pot,
        rake,
        sig,
        slot,
        source: 'hand-report-v1',
        foldWin,
        handReport: meta,
        actions,
      };
      offset += 160;
      continue;
    }

    if (offset + 96 > payload.length) break;
    const e = payload.subarray(offset, offset + 96);
    actions.push({
      kind: e[0],
      street: e[1],
      actor: e[2],
      action: e[3],
      handNumber: Number(e.readBigUInt64LE(4)),
      amount: Number(e.readBigUInt64LE(12)),
      pot: Number(e.readBigUInt64LE(20)),
      wallet: new PublicKey(e.subarray(28, 60)).toBase58(),
      operator: new PublicKey(e.subarray(60, 92)).toBase58(),
      aux: e.readUInt32LE(92),
    });
    offset += 96;
  }

  return settle;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(v => v && v !== ZERO_PUBKEY)));
}

function recordToDoc(table: string, record: ParsedHandRecord): HandReportDoc {
  const bySeat = new Map<number, string>();
  const participantWallets: string[] = [];
  const operatorWallets: string[] = [];

  for (const action of record.actions ?? []) {
    if (action.wallet && action.wallet !== ZERO_PUBKEY) {
      participantWallets.push(action.wallet);
      if (action.actor >= 0 && action.actor < 9) bySeat.set(action.actor, action.wallet);
    }
    if (action.operator && action.operator !== ZERO_PUBKEY) operatorWallets.push(action.operator);
  }

  const winnerWallets = record.winners
    .map(seat => bySeat.get(seat) ?? '')
    .filter(Boolean);
  const settledAt = record.timestamp > 0 ? new Date(record.timestamp * 1000) : new Date();
  const meta = record.handReport;
  return {
    _id: `${table}:${record.handNumber}`,
    table,
    handNumber: record.handNumber,
    source: 'hand-report-v1',
    record,
    payloadHash: meta?.payloadHash ?? '',
    payloadBytes: meta?.payloadBytes ?? 0,
    chunkCount: meta?.chunkCount ?? 0,
    chunksPresent: meta?.chunksPresent ?? 0,
    txs: meta?.txs ?? (record.sig ? [record.sig] : []),
    participantWallets: unique(participantWallets),
    operatorWallets: unique(operatorWallets),
    winnerSeats: record.winners,
    winnerWallets: unique(winnerWallets),
    settledAt,
    firstSeenAt: new Date(),
    updatedAt: new Date(),
    slot: record.slot,
  };
}

async function upsertHandReport(table: string, record: ParsedHandRecord): Promise<void> {
  const doc = recordToDoc(table, record);
  const { _id, firstSeenAt, ...setFields } = doc;
  await handReports().updateOne(
    { _id },
    {
      $set: setFields,
      $setOnInsert: { firstSeenAt },
    },
    { upsert: true },
  );
}

async function storeChunk(chunk: Hrv1Chunk): Promise<void> {
  const payloadHash = hex(chunk.payloadHash);
  await handReportChunks().updateOne(
    { _id: `${chunk.table}:${chunk.handNumber}:${payloadHash}:${chunk.chunkIdx}:${chunk.sig}` },
    {
      $set: {
        table: chunk.table,
        handNumber: chunk.handNumber,
        chunkIdx: chunk.chunkIdx,
        chunkCount: chunk.chunkCount,
        payloadHash,
        chunkHex: hex(chunk.chunkBytes),
        sig: chunk.sig,
        slot: chunk.slot,
        timestamp: chunk.timestamp,
        seenAt: new Date(),
      },
    },
    { upsert: true },
  );
}

function chunkPayloadIsCanonical(chunk: { chunkIdx: number; chunkCount: number; chunkHex: string }): boolean {
  const len = Buffer.byteLength(chunk.chunkHex, 'hex');
  if (chunk.chunkCount === 0 || chunk.chunkCount > HRV1_MAX_CHUNKS) return false;
  if (chunk.chunkIdx < 0 || chunk.chunkIdx >= chunk.chunkCount) return false;
  if (len === 0 || len > HRV1_MAX_CHUNK_PAYLOAD) return false;
  return chunk.chunkIdx + 1 === chunk.chunkCount || len === HRV1_MAX_CHUNK_PAYLOAD;
}

function uniqueChunkVariants<T extends { chunkHex: string; sig: string }>(chunks: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const chunk of chunks) {
    const key = chunk.chunkHex;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(chunk);
  }
  return out;
}

function findValidChunkSet<T extends { chunkHex: string; slot: number }>(
  groups: T[][],
  payloadHash: string,
): T[] | null {
  let candidates: T[][] = [[]];
  for (const group of groups) {
    const next: T[][] = [];
    for (const prefix of candidates) {
      for (const chunk of group.slice(0, 4)) {
        next.push([...prefix, chunk]);
        if (next.length >= HRV1_MAX_ASSEMBLY_CANDIDATES) break;
      }
      if (next.length >= HRV1_MAX_ASSEMBLY_CANDIDATES) break;
    }
    candidates = next;
  }

  for (const candidate of candidates) {
    const payload = Buffer.concat(candidate.map(c => Buffer.from(c.chunkHex, 'hex')));
    const computedHash = createHash('sha256').update(payload).digest('hex');
    if (computedHash === payloadHash) return candidate;
  }
  return null;
}

async function tryAssembleReport(table: string, handNumber: number, payloadHash: string, chunkCount: number): Promise<ParsedHandRecord | null> {
  const chunks = await handReportChunks()
    .find({ table, handNumber, payloadHash, chunkCount })
    .sort({ chunkIdx: 1, slot: -1 })
    .toArray();

  const byIdx = new Map<number, typeof chunks>();
  for (const chunk of chunks) {
    if (!chunkPayloadIsCanonical(chunk)) continue;
    const group = byIdx.get(chunk.chunkIdx) ?? [];
    group.push(chunk);
    byIdx.set(chunk.chunkIdx, group);
  }
  if (byIdx.size !== chunkCount) return null;

  const groups: typeof chunks[] = [];
  for (let idx = 0; idx < chunkCount; idx++) {
    const group = byIdx.get(idx);
    if (!group?.length) return null;
    groups.push(uniqueChunkVariants(group));
  }

  const chunkList = findValidChunkSet(groups, payloadHash);
  if (!chunkList) return null;

  const payload = Buffer.concat(chunkList.map(c => Buffer.from(c.chunkHex, 'hex')));
  const newestFirst = [...chunkList].sort((a, b) => b.slot - a.slot);
  const latest = newestFirst[0];
  const meta = {
    version: 1,
    status: 'l1-committed' as const,
    payloadBytes: payload.length,
    payloadHash,
    chunkCount,
    chunksPresent: chunkList.length,
    txs: newestFirst.map(c => c.sig),
  };
  const record = parseHandReportPayload(payload, meta, latest.sig, latest.slot, latest.timestamp);
  if (!record) return null;
  await upsertHandReport(table, record);
  return record;
}

export async function ingestHandReportChunksFromTx(txData: any, sig: string, slot: number, timestamp: number, tableFilter?: string): Promise<ParsedHandRecord[]> {
  if (!txData || txData.meta?.err) return [];
  const records: ParsedHandRecord[] = [];
  const touched = new Map<string, Hrv1Chunk>();

  for (const data of collectNoopData(txData)) {
    const chunk = decodeHrv1Chunk(data, sig, slot, timestamp, tableFilter);
    if (!chunk) continue;
    await storeChunk(chunk);
    touched.set(`${chunk.table}:${chunk.handNumber}:${hex(chunk.payloadHash)}:${chunk.chunkCount}`, chunk);
  }

  for (const chunk of touched.values()) {
    const record = await tryAssembleReport(chunk.table, chunk.handNumber, hex(chunk.payloadHash), chunk.chunkCount);
    if (record) records.push(record);
  }

  return records;
}

export async function syncTableHandReports(
  conn: Connection,
  table: string,
  opts: { maxPages?: number; pageSize?: number; stopWhenHandFound?: number; until?: string } = {},
): Promise<{ scanned: number; indexed: number; found?: ParsedHandRecord; newestSig?: string }> {
  const tablePk = new PublicKey(table);
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 20, 100));
  const pageSize = Math.max(10, Math.min(opts.pageSize ?? 100, 1000));
  let before: string | undefined;
  let scanned = 0;
  let indexed = 0;
  let found: ParsedHandRecord | undefined;
  let newestSig: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const sigs: ConfirmedSignatureInfo[] = await conn.getSignaturesForAddress(
      tablePk,
      // `until` halts pagination at an already-ingested signature, so the
      // background crawler only scans hands added since its previous tick.
      { limit: pageSize, ...(before ? { before } : {}), ...(opts.until ? { until: opts.until } : {}) },
      'confirmed',
    ).catch(() => []);
    if (!sigs.length) break;
    if (newestSig === undefined) newestSig = sigs[0].signature;
    before = sigs[sigs.length - 1].signature;

    const batchBody = sigs.map((si, idx) => ({
      jsonrpc: '2.0',
      id: idx,
      method: 'getTransaction',
      params: [si.signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 }],
    }));
    const batchRes = await fetch(conn.rpcEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batchBody),
    });
    const batchJson = await batchRes.json() as any[];
    const txById = new Map<number, any>(
      (Array.isArray(batchJson) ? batchJson : [])
        .filter((r: any) => typeof r?.id === 'number')
        .map((r: any) => [r.id, r.result]),
    );

    for (let i = 0; i < sigs.length; i++) {
      const si = sigs[i];
      if (si.err) continue;
      scanned++;
      const txData = txById.get(i) ?? (Array.isArray(batchJson) ? batchJson[i]?.result : null);
      const records = await ingestHandReportChunksFromTx(txData, si.signature, si.slot ?? 0, txData?.blockTime ?? 0, table);
      indexed += records.length;
      if (opts.stopWhenHandFound !== undefined) {
        const hit = records.find(r => r.handNumber === opts.stopWhenHandFound);
        if (hit) {
          found = hit;
          return { scanned, indexed, found, newestSig };
        }
      }
    }

    if (sigs.length < pageSize) break;
  }

  if (opts.stopWhenHandFound !== undefined && !found) {
    const doc = await handReports().findOne({ _id: `${table}:${opts.stopWhenHandFound}` });
    found = doc?.record;
  }

  return { scanned, indexed, found, newestSig };
}
