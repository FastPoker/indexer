import * as crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Hand-rolled Anchor event decoder for the events v0.2 cares about.
 *
 * Anchor 1.0's IDL format isn't compatible with @coral-xyz/anchor 0.29's
 * BorshEventCoder, and Anchor 1.0's runtime is still alpha. Since we only
 * care about a small set of events with fixed layouts, we decode them
 * directly against the known field list from `programs/fastpoker/src/events.rs`.
 *
 * If an event definition changes in the contract, update the decoder here
 * (and bump the shape version in a comment on the event).
 */

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
}

// ─── Discriminators ─────────────────────────────────────────────────────
// Anchor event discriminator = sha256("event:" + EventName)[0..8]

function eventDisc(name: string): Buffer {
  return crypto.createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);
}

const DISC_TABLE_CREATED       = eventDisc('TableCreated');
const DISC_TABLE_CLOSED        = eventDisc('TableClosed');
const DISC_PLAYER_JOINED       = eventDisc('PlayerJoined');
const DISC_PLAYER_LEFT         = eventDisc('PlayerLeft');
const DISC_HAND_SETTLED        = eventDisc('HandSettled');
const DISC_PLAYER_REGISTERED   = eventDisc('PlayerRegistered');
const DISC_PRIZES_DISTRIBUTED  = eventDisc('PrizesDistributed');
const DISC_RAKE_DISTRIBUTED    = eventDisc('RakeDistributed');
const DISC_SNG_PARTIAL_PLAYER_REFUNDED = eventDisc('SngPartialPlayerRefunded');
const DISC_DUPLICATE_SNG_TABLE_CANCELLED = eventDisc('DuplicateSngTableCancelled');

// ─── Byte reader ────────────────────────────────────────────────────────

class Reader {
  constructor(private buf: Buffer, private off = 0) {}
  pubkey(): string {
    const pk = new PublicKey(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return pk.toBase58();
  }
  bytes(n: number): Buffer {
    const out = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return out;
  }
  u8(): number {
    const v = this.buf.readUInt8(this.off);
    this.off += 1;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64(): number {
    // lossy for values > 2^53; fine for lamports/amounts at current devnet scale.
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return Number(v);
  }
  i64(): number {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return Number(v);
  }
  vec<T>(each: () => T): T[] {
    const len = this.u32();
    const out: T[] = [];
    for (let i = 0; i < len; i++) out.push(each());
    return out;
  }
}

// ─── Per-event decoders ─────────────────────────────────────────────────

function decodeTableCreated(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    table_id: Array.from(r.bytes(32)),
    authority: r.pubkey(),
    max_players: r.u8(),
    small_blind: r.u64(),
    big_blind: r.u64(),
  };
}

function decodeTableClosed(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    final_rake: r.u64(),
  };
}

function decodePlayerJoined(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    player: r.pubkey(),
    seat_number: r.u8(),
    buy_in: r.u64(),
  };
}

function decodePlayerLeft(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    player: r.pubkey(),
    seat_number: r.u8(),
    chips_cashed_out: r.u64(),
  };
}

function decodeHandSettled(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    hand_number: r.u64(),
    winners: r.vec(() => r.pubkey()),
    amounts: r.vec(() => r.u64()),
    rake_collected: r.u64(),
  };
}

function decodePlayerRegistered(r: Reader): Record<string, unknown> {
  return {
    player: r.pubkey(),
    timestamp: r.i64(),
  };
}

// PrizeEntry = { wallet: Pubkey(32), amount: u64(8) } = 40 bytes
function decodePrizesDistributed(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    table_id: Array.from(r.bytes(32)),
    game_type: r.u8(),
    winner: r.pubkey(),
    prize_pool: r.u64(),
    payouts: r.vec(() => ({
      wallet: r.pubkey(),
      amount: r.u64(),
    })),
  };
}

function decodeRakeDistributed(r: Reader): Record<string, unknown> {
  return {
    table: r.pubkey(),
    total_rake: r.u64(),
    staker_share: r.u64(),
    creator_share: r.u64(),
    treasury_share: r.u64(),
  };
}

function decodeSngPartialPlayerRefunded(r: Reader): Record<string, unknown> {
  return {
    pool: r.pubkey(),
    sng_match: r.pubkey(),
    table: r.pubkey(),
    player: r.pubkey(),
    caller: r.pubkey(),
    player_index: r.u8(),
    seat_index: r.u8(),
    seated: r.bool(),
    gameplay_lamports: r.u64(),
    mini_lamports: r.u64(),
    rent_lamports: r.u64(),
    total_lamports: r.u64(),
  };
}

function decodeDuplicateSngTableCancelled(r: Reader): Record<string, unknown> {
  return {
    pool: r.pubkey(),
    table: r.pubkey(),
    caller: r.pubkey(),
    duplicate_wallet: r.pubkey(),
    seats_refunded: r.u8(),
    principal_lamports_refunded: r.u64(),
    inactive_mini_lamports_refunded: r.u64(),
    active_mini_lamports_not_refunded: r.u64(),
    jackpot_entries_cleared: r.u8(),
  };
}

// ─── Log parsing ────────────────────────────────────────────────────────

/**
 * Scan program logs for `Program data: <base64>` lines and decode any of
 * our known events. Returns an empty array if none match.
 */
/**
 * Scan msg!-style `Program log:` lines for deposit/cashout/recovery formats that the
 * contract logs but does NOT emit as Anchor events. Returns synthetic
 * PlayerJoined / PlayerLeft / FailedDepositRefunded events so the existing handler pipeline can
 * consume them uniformly.
 *
 * Required formats (from programs/fastpoker/src/instructions):
 *   deposit_for_join.rs  → "Player {wallet} deposited {total} (buy_in={bi},
 *                           reserve={r}) for seat {s} at table {t} (SOL|SPL)"
 *   process_cashout_v2.rs→ "Cashout processed: seat {s} -> {n} {unit}
 *                           to wallet {w}. Nonce: {nonce}"
 *   refund_failed_deposit.rs
 *                        → "Refund: {n} lamports returned to {wallet}
 *                           (seat {s} at table {t}). Elapsed: {seconds}s"
 *
 * Cashout logs don't include the table pubkey. When accountKeys is provided
 * we read it from the TX instruction accounts (account at index 1 is `table`
 * for ProcessCashoutV2; index 2 is `table` for DepositForJoin but deposit
 * logs already have it inline so we don't need accountKeys there).
 */
export function decodeMsgLogEvents(
  logs: readonly string[],
  opts?: { cashoutTable?: string },
): DecodedEvent[] {
  const out: DecodedEvent[] = [];

  const depositRe = /^Program log: Player (\w+) deposited (\d+) \(buy_in=(\d+), reserve=(\d+)\) for seat (\d+) at table (\w+)/;
  const cashoutRe = /^Program log: Cashout processed: seat (\d+) -> (\d+) (?:lamports|tokens) to wallet (\w+)\./;
  const failedDepositRefundRe = /^Program log: Refund: (\d+) lamports returned to (\w+) \(seat (\d+) at table (\w+)\)\. Elapsed: (\d+)s$/;

  for (const line of logs) {
    const dep = depositRe.exec(line);
    if (dep) {
      const [, wallet, total, /* buyIn */, /* reserve */, seat, table] = dep;
      out.push({
        name: 'PlayerJoined',
        data: {
          table,
          player: wallet,
          seat_number: Number(seat),
          buy_in: Number(total),
        },
      });
      continue;
    }
    const cash = cashoutRe.exec(line);
    if (cash) {
      const [, seat, amount, wallet] = cash;
      // Cashout log doesn't include the table pubkey. Caller must resolve it
      // from the TX's IX accounts via findCashoutTableInTx() and pass it in
      // opts.cashoutTable. Skip if not resolved — safety-net sync will retry.
      const table = opts?.cashoutTable || '';
      if (!table) continue;
      out.push({
        name: 'PlayerLeft',
        data: {
          table,
          player: wallet,
          seat_number: Number(seat),
          chips_cashed_out: Number(amount),
        },
      });
      continue;
    }
    const refund = failedDepositRefundRe.exec(line);
    if (refund) {
      const [, amount, wallet, seat, table, elapsed] = refund;
      out.push({
        name: 'FailedDepositRefunded',
        data: {
          table,
          player: wallet,
          seat_number: Number(seat),
          amount: Number(amount),
          elapsed_seconds: Number(elapsed),
        },
      });
    }
  }
  return out;
}

export function decodeLogs(
  logs: readonly string[],
  opts?: { cashoutTable?: string },
): DecodedEvent[] {
  const out: DecodedEvent[] = [];
  const sngPrizeSummary = parseSngPrizeSummary(logs);
  // Synthetic events from msg! logs (covers deposit_for_join + process_cashout_v2
  // which don't emit real Anchor events).
  out.push(...decodeMsgLogEvents(logs, opts));
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    const b64 = line.slice('Program data: '.length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (buf.length < 8) continue;
    const disc = buf.subarray(0, 8);
    const body = new Reader(buf.subarray(8));
    try {
      if (disc.equals(DISC_TABLE_CREATED)) {
        out.push({ name: 'TableCreated', data: decodeTableCreated(body) });
      } else if (disc.equals(DISC_TABLE_CLOSED)) {
        out.push({ name: 'TableClosed', data: decodeTableClosed(body) });
      } else if (disc.equals(DISC_PLAYER_JOINED)) {
        out.push({ name: 'PlayerJoined', data: decodePlayerJoined(body) });
      } else if (disc.equals(DISC_PLAYER_LEFT)) {
        out.push({ name: 'PlayerLeft', data: decodePlayerLeft(body) });
      } else if (disc.equals(DISC_HAND_SETTLED)) {
        out.push({ name: 'HandSettled', data: decodeHandSettled(body) });
      } else if (disc.equals(DISC_PLAYER_REGISTERED)) {
        out.push({ name: 'PlayerRegistered', data: decodePlayerRegistered(body) });
      } else if (disc.equals(DISC_PRIZES_DISTRIBUTED)) {
        const data = decodePrizesDistributed(body);
        if (sngPrizeSummary) {
          data.sol_prize_pool = sngPrizeSummary.solPrizePool;
          data.fee_total = sngPrizeSummary.feeTotal;
        }
        out.push({ name: 'PrizesDistributed', data });
      } else if (disc.equals(DISC_RAKE_DISTRIBUTED)) {
        out.push({ name: 'RakeDistributed', data: decodeRakeDistributed(body) });
      } else if (disc.equals(DISC_SNG_PARTIAL_PLAYER_REFUNDED)) {
        out.push({ name: 'SngPartialPlayerRefunded', data: decodeSngPartialPlayerRefunded(body) });
      } else if (disc.equals(DISC_DUPLICATE_SNG_TABLE_CANCELLED)) {
        out.push({ name: 'DuplicateSngTableCancelled', data: decodeDuplicateSngTableCancelled(body) });
      }
      // other program-data lines are ignored (IX-level logs, non-event emits)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[events] decode failed (disc=${disc.toString('hex')}): ${msg}`);
    }
  }
  return out;
}

function parseSngPrizeSummary(logs: readonly string[]): { solPrizePool: number; feeTotal: number } | null {
  for (const line of logs) {
    const m = /Prizes distributed .*SOL pool=(\d+), fees=(\d+)/.exec(line);
    if (!m) continue;
    const solPrizePool = Number(m[1]);
    const feeTotal = Number(m[2]);
    if (Number.isSafeInteger(solPrizePool) && Number.isSafeInteger(feeTotal)) {
      return { solPrizePool, feeTotal };
    }
  }
  return null;
}
