import { Connection, PublicKey } from '@solana/web3.js';

/**
 * Byte offsets inside the Table account. Mirrors
 * `programs/fastpoker/src/state/table.rs`.
 *
 * When the contract adds fields, update this parser. These layouts are
 * versioned by deploy.
 */
export const TABLE_OFF = {
  TABLE_ID:            8,   // [u8; 32]
  AUTHORITY:          40,   // Pubkey
  GAME_TYPE:         104,   // u8
  SMALL_BLIND:       105,   // u64 LE
  BIG_BLIND:         113,   // u64 LE
  MAX_PLAYERS:       121,   // u8
  CURRENT_PLAYERS:   122,   // u8
  HAND_NUMBER:       123,   // u64 LE
  POT:               131,   // u64 LE
  RAKE_ACCUMULATED:  147,   // u64 LE
  COMMUNITY_CARDS:   155,   // [u8; 5]
  PHASE:             160,   // u8
  CURRENT_PLAYER:    161,   // u8
  DEALER_SEAT:       163,
  IS_DELEGATED:      174,
  SEATS_OCCUPIED:    250,   // u16 LE
  TOKEN_ESCROW:      258,   // Pubkey
  CREATOR:           290,   // Pubkey
  IS_USER_CREATED:   322,
  CREATOR_RAKE_TOTAL: 323,  // u64 LE
  LAST_RAKE_EPOCH:   331,   // u64 LE
  PRIZES_DISTRIBUTED: 339,
  ELIMINATED_SEATS:  342,
  ELIMINATED_COUNT:  351,
  TIER:              360,   // u8
  ENTRY_AMOUNT:      361,   // u64 LE (SNG)
  FEE_AMOUNT:        369,   // u64 LE (SNG)
  PRIZE_POOL:        377,   // u64 LE (SNG)
  TOKEN_MINT:        385,   // Pubkey
  BUY_IN_TYPE:       417,
  RAKE_CAP:          418,   // u64 LE
  IS_PRIVATE:        426,
} as const;

export interface TableMetadata {
  tableId: string;                  // hex
  authority: string;
  gameType: number;
  smallBlind: number;
  bigBlind: number;
  maxPlayers: number;
  tier: number;
  entryAmount: number;
  feeAmount: number;
  tokenMint: string;
  rakeCap: number;
  isPrivate: boolean;
  isUserCreated: boolean;
  creator: string;
  buyInType: number;
}

export function parseTableMetadata(data: Buffer): TableMetadata | null {
  if (data.length < 427) return null;
  const asU64 = (off: number) => Number(data.readBigUInt64LE(off));
  const asPubkey = (off: number) => new PublicKey(data.slice(off, off + 32)).toBase58();
  return {
    tableId: Buffer.from(data.slice(TABLE_OFF.TABLE_ID, TABLE_OFF.TABLE_ID + 32)).toString('hex'),
    authority: asPubkey(TABLE_OFF.AUTHORITY),
    gameType: data[TABLE_OFF.GAME_TYPE],
    smallBlind: asU64(TABLE_OFF.SMALL_BLIND),
    bigBlind: asU64(TABLE_OFF.BIG_BLIND),
    maxPlayers: data[TABLE_OFF.MAX_PLAYERS],
    tier: data[TABLE_OFF.TIER],
    entryAmount: asU64(TABLE_OFF.ENTRY_AMOUNT),
    feeAmount: asU64(TABLE_OFF.FEE_AMOUNT),
    tokenMint: asPubkey(TABLE_OFF.TOKEN_MINT),
    rakeCap: asU64(TABLE_OFF.RAKE_CAP),
    isPrivate: data[TABLE_OFF.IS_PRIVATE] === 1,
    isUserCreated: data[TABLE_OFF.IS_USER_CREATED] === 1,
    creator: asPubkey(TABLE_OFF.CREATOR),
    buyInType: data[TABLE_OFF.BUY_IN_TYPE],
  };
}

/**
 * Fetch + parse a Table account. Returns null if the account is missing
 * (e.g. the table was closed and the PDA was cleaned up).
 */
export async function fetchTableMetadata(
  conn: Connection,
  tablePk: string,
): Promise<TableMetadata | null> {
  try {
    const info = await conn.getAccountInfo(new PublicKey(tablePk), 'confirmed');
    if (!info) return null;
    return parseTableMetadata(Buffer.from(info.data));
  } catch {
    return null;
  }
}
