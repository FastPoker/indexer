/**
 * Listed-token registry — the FASTPOKER_REGISTRY `ListedToken` accounts (one per
 * auction-won SPL token usable for cash tables), push-driven via gRPC LaserStream.
 *
 * Why: the lobby's token filter calls useListedTokens, which did a per-client
 * getProgramAccounts (10 credits) on the registry every 5 min. The set changes
 * rarely (auction cadence) but the gPA is paid by every client. Subscribing once
 * here serves the mints at /v1/tokens for 0 per-client RPC. Symbols/logos stay
 * client-side (resolved via /api/token-meta) — this domain only owns the mint set.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { config } from '../config.ts';
import { getL1Stream } from '../ingest/l1-stream.ts';
import { publishTopic } from '../ws-gateway.ts';

// Registry program (rotates rarely). Must match client constants.FASTPOKER_REGISTRY_PROGRAM_ID.
const REGISTRY_PROGRAM = new PublicKey('pokerQBdo685uLSkpVSyZ1vWooPYYTUhGkeKAHyCmax');
const REGISTRY_PROGRAM_STR = REGISTRY_PROGRAM.toBase58();
// ListedToken layout: 8 disc + 32 mint + 8 winningEpoch + 8 listedAt + 1 bump = 57.
const LISTED_TOKEN_DATA_SIZE = 57;
const MINT_OFFSET = 8;
const LISTED_AT_OFFSET = 48;
const SAFETY_RESEED_MS = 5 * 60_000;

export interface ListedTokenLite {
  mint: string;
  listedAt: number;
}

const tokens = new Map<string, ListedTokenLite>(); // mint -> {mint, listedAt}
let asOfMs = 0;
let connection: Connection | null = null;
let started = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

function getConn(): Connection {
  if (!connection) connection = new Connection(config.rpc.url, 'confirmed');
  return connection;
}

function parseListedToken(data: Buffer): ListedTokenLite | null {
  if (data.length < LISTED_TOKEN_DATA_SIZE) return null;
  const mint = new PublicKey(data.subarray(MINT_OFFSET, MINT_OFFSET + 32)).toBase58();
  const listedAt = Number(data.readBigInt64LE(LISTED_AT_OFFSET));
  return { mint, listedAt };
}

function applyUpdate(data: Buffer): void {
  const parsed = parseListedToken(data);
  if (!parsed) return;
  tokens.set(parsed.mint, parsed);
  asOfMs = Date.now();
  publishTopic('listed_tokens', getListedTokens());
}

async function seed(): Promise<void> {
  try {
    const accounts = await getConn().getProgramAccounts(REGISTRY_PROGRAM, {
      filters: [{ dataSize: LISTED_TOKEN_DATA_SIZE }],
    });
    for (const { account } of accounts) {
      const parsed = parseListedToken(Buffer.from(account.data));
      if (parsed) tokens.set(parsed.mint, parsed);
    }
    asOfMs = Date.now();
  } catch (err) {
    console.error('[token-registry] seed failed:', err instanceof Error ? err.message : err);
  }
}

export function getListedTokens(): { tokens: ListedTokenLite[]; asOfMs: number } {
  const list = Array.from(tokens.values()).sort((a, b) => b.listedAt - a.listedAt);
  return { tokens: list, asOfMs };
}

export function startTokenRegistryCache(): void {
  if (started) return;
  started = true;
  void seed();
  const stream = getL1Stream();
  if (stream) {
    // Program-level filter: all registry-owned accounts of the fixed ListedToken
    // size. New listings (resolve_auction) stream in automatically.
    stream.watchProgram('token-registry', {
      owner: [REGISTRY_PROGRAM_STR],
      filters: [{ datasize: LISTED_TOKEN_DATA_SIZE }],
    });
    stream.on('account-update', (u) => {
      if (u.owner !== REGISTRY_PROGRAM_STR || u.data.length !== LISTED_TOKEN_DATA_SIZE) return;
      applyUpdate(u.data);
    });
    stream.on('connected', () => { void seed(); });
    console.log('[token-registry] subscribed via gRPC LaserStream (program filter)');
  } else {
    console.log('[token-registry] no stream; serving seeded snapshot only');
  }
  intervalHandle = setInterval(() => { void seed(); }, SAFETY_RESEED_MS);
}

export function stopTokenRegistryCache(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}
