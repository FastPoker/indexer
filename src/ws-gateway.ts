/**
 * WebSocket fanout gateway.
 *
 * Per-topic subscription multiplexer. Domain modules call publish(topic, data)
 * when their snapshot changes; subscribers receive {topic, seq, data} frames
 * immediately. Zero client polling — clients open one WS, subscribe to N
 * topics, receive deltas as they happen.
 *
 * Topics today (global, anonymous):
 *   jackpot_receipt → JPV1 jackpot receipts
 *   sng_pools       → SNG pool snapshots
 *   listed_tokens   → listed-token registry snapshots
 *
 * Per-wallet topics (wallet:&lt;addr&gt;) and per-table topics (table:&lt;pda&gt;) are
 * out of scope for this pass — they need signed-nonce auth.
 *
 * Wire protocol (JSON over WebSocket):
 *   Client → Server:
 *     {"op":"sub","topic":"sng_pools"}
 *     {"op":"sub","topics":["sng_pools","listed_tokens"]}
 *     {"op":"unsub","topic":"sng_pools"}
 *     {"op":"ping"}
 *   Server → Client:
 *     {"op":"snapshot","topic":"sng_pools","seq":N,"data":...}  // initial after sub
 *     {"op":"update","topic":"sng_pools","seq":N,"data":...}     // on change
 *     {"op":"pong"}
 *     {"op":"error","msg":"..."}
 */
import * as http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from './logger.ts';
import { wsClients, wsTopicSubscribers, wsBroadcast } from './metrics.ts';

const ALLOWED_TOPICS = new Set(['jackpot_receipt', 'sng_pools', 'listed_tokens']);

interface TopicState {
  seq: number;
  latest: unknown;
}

const topics = new Map<string, TopicState>();
const subscribers = new Map<string, Set<WebSocket>>();
let wss: WebSocketServer | null = null;

function bumpSeq(topic: string): number {
  const t = topics.get(topic) ?? { seq: 0, latest: null };
  t.seq += 1;
  topics.set(topic, t);
  return t.seq;
}

/**
 * Domain modules call this whenever their snapshot changes. Stores the latest
 * value and broadcasts an update frame to every subscriber of the topic.
 */
export function publishTopic(topic: string, data: unknown): void {
  if (!ALLOWED_TOPICS.has(topic)) {
    log.warn({ topic }, 'publish to unknown topic');
    return;
  }
  const seq = bumpSeq(topic);
  const state = topics.get(topic)!;
  state.latest = data;

  const subs = subscribers.get(topic);
  if (!subs || subs.size === 0) return;

  const frame = JSON.stringify({ op: 'update', topic, seq, data });
  for (const ws of subs) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(frame); } catch {}
    }
  }
  wsBroadcast.inc({ topic });
}

function sendSnapshot(ws: WebSocket, topic: string): void {
  const state = topics.get(topic);
  if (!state || state.latest === null) return;
  try {
    ws.send(JSON.stringify({ op: 'snapshot', topic, seq: state.seq, data: state.latest }));
  } catch {}
}

function sendError(ws: WebSocket, msg: string): void {
  try { ws.send(JSON.stringify({ op: 'error', msg })); } catch {}
}

function handleMessage(ws: WebSocket, raw: string): void {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { sendError(ws, 'invalid json'); return; }
  if (!msg || typeof msg !== 'object') { sendError(ws, 'invalid frame'); return; }

  if (msg.op === 'ping') {
    try { ws.send(JSON.stringify({ op: 'pong' })); } catch {}
    return;
  }

  if (msg.op === 'sub') {
    const list: string[] = Array.isArray(msg.topics)
      ? msg.topics
      : typeof msg.topic === 'string' ? [msg.topic] : [];
    for (const topic of list) {
      if (typeof topic !== 'string' || !ALLOWED_TOPICS.has(topic)) {
        sendError(ws, `unknown topic: ${String(topic)}`);
        continue;
      }
      let set = subscribers.get(topic);
      if (!set) { set = new Set(); subscribers.set(topic, set); }
      set.add(ws);
      sendSnapshot(ws, topic);
    }
    return;
  }

  if (msg.op === 'unsub') {
    const list: string[] = Array.isArray(msg.topics)
      ? msg.topics
      : typeof msg.topic === 'string' ? [msg.topic] : [];
    for (const topic of list) {
      subscribers.get(topic)?.delete(ws);
    }
    return;
  }

  sendError(ws, `unknown op: ${String(msg.op)}`);
}

function cleanupSocket(ws: WebSocket): void {
  for (const set of subscribers.values()) set.delete(ws);
}

/**
 * Attach the gateway to an existing HTTP server. Clients connect to
 * ws://<host>:<port>/ws (or wss://). Returns a stop() function.
 */
export function attachWsGateway(server: http.Server): () => void {
  wss = new WebSocketServer({ noServer: true });

  // Heartbeat: ping every 30s and terminate sockets that don't pong.
  const isAlive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    if (!wss) return;
    for (const ws of wss.clients) {
      if (!isAlive.get(ws)) {
        cleanupSocket(ws);
        try { ws.terminate(); } catch {}
        continue;
      }
      isAlive.set(ws, false);
      try { ws.ping(); } catch {}
    }
  }, 30_000);

  wss.on('connection', (ws) => {
    isAlive.set(ws, true);
    wsClients.inc();
    ws.on('pong', () => isAlive.set(ws, true));
    ws.on('message', (data) => handleMessage(ws, data.toString()));
    const onClose = () => {
      cleanupSocket(ws);
      wsClients.dec();
      // Refresh per-topic counts cheaply on close.
      for (const [t, set] of subscribers.entries()) {
        wsTopicSubscribers.set({ topic: t }, set.size);
      }
    };
    ws.on('close', onClose);
    ws.on('error', () => onClose());
  });

  server.on('upgrade', (req, socket, head) => {
    if (!wss) { socket.destroy(); return; }
    const url = req.url || '';
    if (!url.startsWith('/ws')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req);
    });
  });

  log.info('WS fanout listening on /ws');

  return () => {
    clearInterval(heartbeat);
    if (wss) {
      for (const ws of wss.clients) {
        try { ws.terminate(); } catch {}
      }
      wss.close();
      wss = null;
    }
  };
}
