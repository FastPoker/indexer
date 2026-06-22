import type { VersionedTransactionResponse, TransactionResponse } from '@solana/web3.js';
import * as crypto from 'node:crypto';

type AnyTx = VersionedTransactionResponse | TransactionResponse | null | undefined;
type AnyTxLike = AnyTx | any;

/**
 * Extract static account keys from a TX response as base58 strings.
 * Works for both legacy and v0 messages. Returns [] for null/invalid inputs.
 */
export function extractAccountKeys(tx: AnyTxLike): string[] {
  if (!tx) return [];
  const msg = tx.transaction?.message as unknown as {
    accountKeys?: Array<{ toBase58(): string } | { pubkey?: { toBase58(): string } | string } | string>;
    staticAccountKeys?: Array<{ toBase58(): string }>;
    getAccountKeys?: () => { staticAccountKeys: Array<{ toBase58(): string }> };
  };
  if (!msg) return [];

  // Legacy Message has accountKeys directly.
  if (Array.isArray(msg.accountKeys)) {
    return msg.accountKeys.map((k) => {
      if (typeof k === 'string') return k;
      if ('pubkey' in k && k.pubkey) {
        return typeof k.pubkey === 'string' ? k.pubkey : k.pubkey.toBase58();
      }
      return 'toBase58' in k ? k.toBase58() : '';
    });
  }

  // v0 message: use staticAccountKeys or getAccountKeys().
  if (Array.isArray(msg.staticAccountKeys)) {
    return msg.staticAccountKeys.map((k) => k.toBase58());
  }
  if (typeof msg.getAccountKeys === 'function') {
    try {
      const out = msg.getAccountKeys();
      return out.staticAccountKeys.map((k) => k.toBase58());
    } catch { /* fall through */ }
  }
  return [];
}

export interface NativeBalanceDelta {
  pubkey: string;
  pre: number;
  post: number;
  delta: number;
}

export function extractNativeBalanceDeltas(tx: AnyTxLike): NativeBalanceDelta[] {
  const keys = extractAccountKeys(tx);
  const pre = tx?.meta?.preBalances;
  const post = tx?.meta?.postBalances;
  if (!Array.isArray(pre) || !Array.isArray(post)) return [];
  const n = Math.min(keys.length, pre.length, post.length);
  const out: NativeBalanceDelta[] = [];
  for (let i = 0; i < n; i++) {
    const preBal = Number(pre[i] ?? 0);
    const postBal = Number(post[i] ?? 0);
    out.push({ pubkey: keys[i], pre: preBal, post: postBal, delta: postBal - preBal });
  }
  return out;
}

function ixDisc(name: string): Buffer {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}
const DISC_PROCESS_CASHOUT_V2 = ixDisc('process_cashout_v2');

function bs58Decode(s: string): Uint8Array {
  // Inline bs58 decode to avoid another dep.
  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) {
    const idx = ALPHA.indexOf(ch);
    if (idx < 0) return new Uint8Array();
    n = n * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.push(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/**
 * Find the ProcessCashoutV2 instruction in a TX and return its `table`
 * account pubkey (IX account index 1 per the contract's #[derive(Accounts)]).
 * Returns undefined if the TX has no cashout IX.
 *
 * We resolve the table via IX-level accounts rather than the TX's global
 * accountKeys array because indices differ — global[1] may point to a
 * completely different account depending on signer/writable flags.
 */
export function findCashoutTableInTx(tx: AnyTx, programIdBase58: string): string | undefined {
  if (!tx) return undefined;
  const keys = extractAccountKeys(tx);
  if (keys.length === 0) return undefined;
  const msg = tx.transaction?.message as unknown as {
    compiledInstructions?: Array<{ programIdIndex: number; data: Uint8Array | Buffer | number[]; accountKeyIndexes?: number[] }>;
    instructions?: Array<{ programIdIndex: number; data: string | Buffer | number[]; accounts?: number[] }>;
  };
  const compiled = msg?.compiledInstructions ?? [];
  const legacy = msg?.instructions ?? [];

  const checkIx = (
    progIdx: number,
    data: Uint8Array | Buffer | number[] | string,
    acctIdxs: number[] | undefined,
  ): string | undefined => {
    const prog = keys[progIdx];
    if (prog !== programIdBase58) return undefined;
    const dataBytes = Buffer.from(
      typeof data === 'string' ? bs58Decode(data) : (data as Uint8Array | Buffer | number[]),
    );
    if (dataBytes.length < 8) return undefined;
    if (!dataBytes.subarray(0, 8).equals(DISC_PROCESS_CASHOUT_V2)) return undefined;
    if (!acctIdxs || acctIdxs.length < 2) return undefined;
    const tableIdx = acctIdxs[1];
    if (tableIdx >= 0 && tableIdx < keys.length) return keys[tableIdx];
    return undefined;
  };

  for (const ix of compiled) {
    const found = checkIx(ix.programIdIndex, ix.data, ix.accountKeyIndexes);
    if (found) return found;
  }
  for (const ix of legacy) {
    const found = checkIx(ix.programIdIndex, ix.data, ix.accounts);
    if (found) return found;
  }
  return undefined;
}
