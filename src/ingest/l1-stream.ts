/**
 * LaserStream gRPC ingest for the indexer.
 *
 * Replaces polling for global account snapshots (POOL_PDA, POKER_MINT) and
 * per-wallet PDAs with push-based account subscriptions. Same proto/wire
 * shape as backend/l1-stream.ts (the crank's L1Stream) but scoped to the
 * indexer's needs: a flexible "watch this set of accounts" API that domain
 * modules can register against.
 *
 * Falls back gracefully: if HELIUS_API_KEY or LASERSTREAM_ENDPOINT are
 * unset, start() is a no-op and the domain modules continue to poll.
 *
 * Reconnects with exponential backoff. Dynamic subscription updates write
 * a fresh SubscribeRequest down the bidirectional stream so newly-watched
 * accounts are picked up without tearing down the connection.
 */
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { laserStreamConnected } from '../metrics.ts';
import * as protoLoader from '@grpc/proto-loader';

const COMMITMENT_CONFIRMED = 1;

export interface L1AccountUpdate {
  pubkey: string;
  data: Buffer;
  slot: number;
  owner: string;
  lamports: number;
}

export interface L1StreamOptions {
  apiKey: string;
  endpoint: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class IndexerL1Stream extends EventEmitter {
  private apiKey: string;
  private endpoint: string;
  private alive = false;
  private connected = false;

  private watched = new Set<string>();
  private client: any = null;
  private stream: any = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pingId = 0;
  // Program-level subscriptions (owner + geyser filters), keyed by a stable group
  // name. Unlike `watched` (specific pubkeys), these match a whole program's
  // accounts, so dynamically-created ones (new tables / token listings) appear
  // automatically with no discovery loop. Persisted across reconnects like watched.
  private programWatches = new Map<string, { owner: string[]; filters: unknown[] }>();

  constructor(opts: L1StreamOptions) {
    super();
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint;
  }

  /** Register a pubkey to receive account-update events. Safe to call before start(). */
  watch(pubkey: string): void {
    if (this.watched.has(pubkey)) return;
    this.watched.add(pubkey);
    if (this.stream && this.connected) {
      try { this.stream.write(this.buildSubscribeRequest()); }
      catch (e: any) { console.warn('[l1-stream] watch write failed:', e.message?.slice(0, 80)); }
    }
  }

  unwatch(pubkey: string): void {
    if (!this.watched.delete(pubkey)) return;
    if (this.stream && this.connected) {
      try { this.stream.write(this.buildSubscribeRequest()); }
      catch {}
    }
  }

  /** Register a program-level subscription (owner list + geyser filters) under a
   *  stable group name. Matches all current AND future accounts of that program
   *  shape — used by the tables + token-registry domains so newly-created
   *  accounts stream in without a per-pubkey discovery loop. */
  watchProgram(name: string, spec: { owner?: string[]; filters?: unknown[] }): void {
    this.programWatches.set(name, { owner: spec.owner ?? [], filters: spec.filters ?? [] });
    if (this.stream && this.connected) {
      try { this.stream.write(this.buildSubscribeRequest()); }
      catch (e: any) { console.warn('[l1-stream] watchProgram write failed:', e.message?.slice(0, 80)); }
    }
  }

  watchedCount(): number {
    return this.watched.size;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    if (!this.apiKey || !this.endpoint) {
      console.log('[l1-stream] disabled (no HELIUS_API_KEY or LASERSTREAM_ENDPOINT); domains fall back to polling');
      return;
    }
    this.alive = true;

    try {
      // Try multiple proto locations — node_modules can resolve differently
      // depending on workspace layout. First match wins.
      const candidates = [
        path.resolve(__dirname, '..', '..', 'node_modules', 'laserstream-core-proto-js', 'geyser.proto'),
        path.resolve(__dirname, '..', '..', '..', 'node_modules', 'laserstream-core-proto-js', 'geyser.proto'),
        path.resolve(__dirname, '..', '..', '..', '..', 'node_modules', 'laserstream-core-proto-js', 'geyser.proto'),
      ];
      let protoPath: string | null = null;
      for (const c of candidates) {
        try {
          // dynamic import of fs for ESM
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const fs = await import('node:fs');
          if (fs.existsSync(c)) { protoPath = c; break; }
        } catch {}
      }
      if (!protoPath) {
        console.warn('[l1-stream] geyser.proto not found; gRPC disabled');
        this.alive = false;
        return;
      }

      const packageDef = protoLoader.loadSync(protoPath, {
        keepCase: false,
        longs: String,
        enums: Number,
        defaults: true,
        oneofs: true,
        includeDirs: [path.dirname(protoPath)],
      });
      const proto = grpc.loadPackageDefinition(packageDef) as any;
      const GeyserService = proto.geyser.Geyser;

      let host = this.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
      if (!host.includes(':')) host += ':443';

      const channelCreds = grpc.credentials.createSsl();
      const callCreds = grpc.credentials.createFromMetadataGenerator((_p: any, cb: any) => {
        const md = new grpc.Metadata();
        md.set('x-token', this.apiKey);
        cb(null, md);
      });
      const combined = grpc.credentials.combineChannelCredentials(channelCreds, callCreds);

      this.client = new GeyserService(host, combined, {
        'grpc.max_receive_message_length': 64 * 1024 * 1024,
        'grpc.keepalive_time_ms': 30_000,
        'grpc.keepalive_timeout_ms': 10_000,
        'grpc.keepalive_permit_without_calls': 1,
      });
      console.log(`[l1-stream] gRPC client created for ${host}`);
    } catch (e: any) {
      console.error(`[l1-stream] init failed: ${e.message?.slice(0, 150)}`);
      this.alive = false;
      return;
    }

    void this.connectWithRetry();
  }

  // Single setter so every connection-state flip also moves the Prometheus
  // gauge. Without this, the metric stays at its default (0) forever and
  // the admin dashboard reads "down" regardless of actual stream health.
  private setConnected(v: boolean): void {
    this.connected = v;
    laserStreamConnected.set(v ? 1 : 0);
  }

  stop(): void {
    this.alive = false;
    this.setConnected(false);
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
    if (this.stream) { try { this.stream.cancel(); } catch {} this.stream = null; }
    if (this.client) { try { this.client.close(); } catch {} this.client = null; }
  }

  private buildSubscribeRequest(): any {
    const accounts: Record<string, unknown> = {};
    if (this.watched.size > 0) {
      accounts['indexer-accounts'] = {
        account: Array.from(this.watched),
        owner: [],
        filters: [],
      };
    }
    // Program-level groups (tables, token registry): owner + filters, no fixed
    // account list, so new accounts of that shape stream in automatically.
    for (const [name, spec] of this.programWatches) {
      accounts[name] = { account: [], owner: spec.owner, filters: spec.filters };
    }
    return {
      accounts,
      transactions: {},
      commitment: COMMITMENT_CONFIRMED,
      slots: {},
      transactionsStatus: {},
      blocks: {},
      // Named filter so the server actually pushes block metadata (an empty
      // map = no subscription). Consumers may listen for block metadata if needed.
      blocksMeta: { 'indexer-blockmeta': {} },
      entry: {},
      accountsDataSlice: [],
    };
  }

  private async connectWithRetry(): Promise<void> {
    let delay = 2000;
    const MAX = 60_000;
    while (this.alive) {
      try {
        await this.runSubscription();
      } catch (e: any) {
        if (!this.alive) return;
        this.setConnected(false);
        this.emit('reconnecting');
        console.warn(`[l1-stream] connection lost: ${e.message?.slice(0, 100)}`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, MAX);
      }
    }
  }

  private runSubscription(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.client || !this.alive) { reject(new Error('not started')); return; }
      this.stream = this.client.Subscribe();
      let first = true;
      this.stream.write(this.buildSubscribeRequest());
      this.pingId++;
      this.stream.write({ ping: { id: this.pingId } });

      if (this.pingInterval) clearInterval(this.pingInterval);
      this.pingInterval = setInterval(() => {
        if (this.stream && this.alive) {
          try {
            this.pingId++;
            this.stream.write({ ping: { id: this.pingId } });
          } catch {}
        }
      }, 30_000);

      this.stream.on('data', (data: any) => {
        if (!this.alive) return;
        if (first) {
          first = false;
          this.setConnected(true);
          this.emit('connected');
          console.log('[l1-stream] connected; receiving updates');
        }
        try {
          if (data.pong || data.ping) return;
          // Block metadata push for optional consumers.
          // block_height is a wrapped message; longs are strings (loader opts).
          if (data.blockMeta) {
            const bm = data.blockMeta;
            const blockhash: string = bm.blockhash || '';
            const blockHeight = Number(bm.blockHeight?.blockHeight ?? 0);
            if (blockhash && blockHeight > 0) {
              this.emit('block-meta', { blockhash, blockHeight, slot: Number(bm.slot || 0) });
            }
            return;
          }
          if (!data.account) return;
          const acct = data.account.account;
          if (!acct?.pubkey || !acct?.data) return;
          const pubkey = bytesToBase58(toUint8(acct.pubkey));
          const owner = acct.owner ? bytesToBase58(toUint8(acct.owner)) : '';
          const update: L1AccountUpdate = {
            pubkey,
            data: Buffer.from(toUint8(acct.data)),
            slot: Number(data.account.slot || 0),
            owner,
            lamports: Number(acct.lamports || 0),
          };
          this.emit('account-update', update);
        } catch (e: any) {
          console.warn('[l1-stream] handler error:', e.message?.slice(0, 100));
        }
      });

      this.stream.on('end', () => {
        this.setConnected(false);
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.alive) reject(new Error('stream ended'));
        else resolve();
      });

      this.stream.on('error', (err: any) => {
        this.setConnected(false);
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.alive) reject(err instanceof Error ? err : new Error(String(err)));
        else resolve();
      });
    });
  }
}

function toUint8(x: any): Uint8Array {
  return x instanceof Uint8Array ? x : Buffer.from(x);
}

function bytesToBase58(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (bytes.length === 0) return '';
  let zeroes = 0;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) zeroes++;
  const size = ((bytes.length - zeroes) * 138 / 100) + 1 >>> 0;
  const b58 = new Uint8Array(size);
  let length = 0;
  for (let i = zeroes; i < bytes.length; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let it = size - 1; (carry !== 0 || j < length) && it >= 0; it--, j++) {
      carry += 256 * b58[it] >>> 0;
      b58[it] = carry % 58 >>> 0;
      carry = carry / 58 >>> 0;
    }
    length = j;
  }
  let it2 = size - length;
  while (it2 < size && b58[it2] === 0) it2++;
  let str = '';
  for (let i = 0; i < zeroes; i++) str += '1';
  for (; it2 < size; it2++) str += ALPHABET[b58[it2]];
  return str;
}

// ─── Module singleton + helpers ───

let singleton: IndexerL1Stream | null = null;

export function getL1Stream(): IndexerL1Stream | null {
  return singleton;
}

export function initL1Stream(opts: L1StreamOptions): IndexerL1Stream {
  if (singleton) return singleton;
  singleton = new IndexerL1Stream(opts);
  return singleton;
}
