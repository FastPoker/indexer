import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Minimal .env loader — no dotenv dependency. Only runs if a file exists.
function loadEnvFile(): void {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(here, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const contents = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be numeric, got ${raw}`);
  return n;
}

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const DEFAULT_RPC = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';
// WebSocket endpoint derives from the RPC URL: swap https → wss.
function deriveWsUrl(rpc: string): string {
  return rpc.replace(/^https?:\/\//, (m) => (m === 'https://' ? 'wss://' : 'ws://'));
}

export const config = {
  mongo: {
    // Chain-derived event stream output (hand_reports, tables, players, etc).
    uri: required('MONGO_URI', 'mongodb://localhost:27017'),
    db: required('MONGO_DB', 'fastpoker_indexer'),
  },
  rpc: {
    url: process.env.RPC_URL || DEFAULT_RPC,
    wsUrl: process.env.RPC_WS_URL || deriveWsUrl(process.env.RPC_URL || DEFAULT_RPC),
    heliusKey: HELIUS_API_KEY,
  },
  laserstream: {
    endpoint: process.env.LASERSTREAM_ENDPOINT || (HELIUS_API_KEY ? 'https://laserstream-mainnet-ewr.helius-rpc.com' : ''),
    apiKey: HELIUS_API_KEY,
  },
  program: {
    id: required('PROGRAM_ID', 'PokerXYdXL2SKNnfGbv1WE7vJHipTpNsfZbZeVvoJLn'),
  },
  server: {
    port: num('INDEXER_PORT', 3001),
  },
  backfill: {
    lookbackHours: num('BACKFILL_LOOKBACK_HOURS', 720),
    throttleMs: num('BACKFILL_THROTTLE_MS', 100),
    pageSize: 1000,
  },
  // One-shot recovery sweep on startup: re-ingest jackpot receipts + hand-report
  // chunks (idempotent, cursor-ignoring, no event replay) over this many hours.
  // 0 = off. Off by default so routine restarts don't pay for a deep rescan;
  // set RECOVER_LOOKBACK_HOURS to recover a backlog after a gating-bug fix.
  recover: {
    lookbackHours: num('RECOVER_LOOKBACK_HOURS', 0),
  },
  reconcile: {
    windowMinutes: num('RECONCILE_WINDOW_MINUTES', 60),
  },
};
