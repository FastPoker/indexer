import { Connection, PublicKey, type ConfirmedSignatureInfo } from '@solana/web3.js';

/**
 * Program transaction-history iterator.
 *
 * Fast path: providers that support the enhanced `getTransactionsForAddress`
 * JSON-RPC method can return full transaction pages in one request.
 *
 * Portable path: standard Solana RPC providers use
 * `getSignaturesForAddress` plus batched `getTransaction` calls. It costs more
 * RPC quota and takes longer, but keeps `RPC_URL` provider-neutral.
 */

export interface TransactionHistoryParams {
  address: string;
  transactionDetails?: 'full' | 'signatures';
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  paginationToken?: string;
  commitment?: 'confirmed' | 'finalized';
  encoding?: 'json' | 'jsonParsed' | 'base64' | 'base58';
  filters?: {
    blockTime?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    slot?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    signature?: string;
    status?: 'succeeded' | 'failed' | 'any';
    tokenAccounts?: 'balanceChanged' | 'mentioned';
  };
}

export interface TransactionHistoryResult {
  transactions: any[];
  paginationToken: string | null;
}

export async function getTransactionsForAddress(
  rpcUrl: string,
  params: TransactionHistoryParams,
): Promise<TransactionHistoryResult> {
  return getEnhancedTransactionsForAddress(rpcUrl, params);
}

async function getEnhancedTransactionsForAddress(
  rpcUrl: string,
  params: TransactionHistoryParams,
): Promise<TransactionHistoryResult> {
  const txDetails = params.transactionDetails ?? 'full';
  const maxLimit = txDetails === 'full' ? 100 : 1000;
  const options: Record<string, unknown> = {
    transactionDetails: txDetails,
    sortOrder: params.sortOrder ?? 'desc',
    limit: Math.min(Math.max(1, params.limit ?? maxLimit), maxLimit),
    commitment: params.commitment ?? 'confirmed',
  };
  if (params.paginationToken) options.paginationToken = params.paginationToken;
  if (params.encoding) options.encoding = params.encoding;
  if (params.filters) options.filters = params.filters;
  const body = {
    jsonrpc: '2.0',
    id: 'getTransactionsForAddress',
    method: 'getTransactionsForAddress',
    params: [params.address, options],
  };
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`getTransactionsForAddress HTTP ${res.status}`);
  const json = (await res.json()) as { result?: any; error?: { code?: number; message?: string } };
  if (json.error) {
    const msg = json.error.message || 'getTransactionsForAddress error';
    throw new Error(`${msg}${json.error.code !== undefined ? ` (${json.error.code})` : ''}`);
  }
  const result = json.result ?? {};
  const transactions: any[] = Array.isArray(result.transactions)
    ? result.transactions
    : Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.items)
        ? result.items
        : Array.isArray(result)
          ? result
          : [];
  const paginationToken: string | null =
    typeof result.paginationToken === 'string' ? result.paginationToken :
    typeof result.cursor === 'string' ? result.cursor :
    typeof result.nextCursor === 'string' ? result.nextCursor :
    null;
  return { transactions, paginationToken };
}

function enhancedUnavailable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
  return msg.includes('method not found')
    || msg.includes('-32601')
    || msg.includes('unsupported')
    || msg.includes('not supported')
    || msg.includes('not implemented');
}

async function fetchTransactionsBatch(
  rpcUrl: string,
  sigs: ConfirmedSignatureInfo[],
  commitment: 'confirmed' | 'finalized',
): Promise<any[]> {
  const out: any[] = [];
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100);
    const body = chunk.map((si, idx) => ({
      jsonrpc: '2.0',
      id: idx,
      method: 'getTransaction',
      params: [
        si.signature,
        { commitment, encoding: 'json', maxSupportedTransactionVersion: 0 },
      ],
    }));
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`getTransaction batch HTTP ${res.status}`);
    const json = await res.json() as any[];
    for (let j = 0; j < chunk.length; j++) {
      const tx = Array.isArray(json)
        ? json.find((r: any) => r?.id === j)?.result ?? json[j]?.result
        : null;
      if (tx) out.push(tx);
    }
  }
  return out;
}

async function* iterateStandardTransactionsForAddress(
  rpcUrl: string,
  params: TransactionHistoryParams,
  opts?: { maxTxs?: number; shouldStop?: (tx: any) => boolean },
): AsyncGenerator<any[], void, void> {
  const conn = new Connection(rpcUrl, params.commitment ?? 'confirmed');
  const address = new PublicKey(params.address);
  const commitment = params.commitment ?? 'confirmed';
  const pageSize = Math.min(Math.max(1, params.limit ?? 1000), 1000);
  const blockTimeGte = params.filters?.blockTime?.gte;
  let before: string | undefined;
  let yielded = 0;
  const cap = opts?.maxTxs ?? Infinity;

  while (yielded < cap) {
    const sigs = await conn.getSignaturesForAddress(
      address,
      { limit: Math.min(pageSize, cap - yielded), ...(before ? { before } : {}) },
      commitment,
    );
    if (sigs.length === 0) return;
    before = sigs[sigs.length - 1].signature;

    const txs = await fetchTransactionsBatch(
      rpcUrl,
      sigs.filter((si) => !si.err),
      commitment,
    );
    const filtered = typeof blockTimeGte === 'number'
      ? txs.filter((tx) => typeof tx?.blockTime !== 'number' || tx.blockTime >= blockTimeGte)
      : txs;
    if (filtered.length > 0) {
      yield filtered;
      yielded += filtered.length;
      if (opts?.shouldStop && filtered.some(opts.shouldStop)) return;
    }
    if (typeof blockTimeGte === 'number' && sigs.some((si) => typeof si.blockTime === 'number' && si.blockTime < blockTimeGte)) return;
    if (sigs.length < pageSize) return;
  }
}

export async function* iterateTransactionsForAddress(
  rpcUrl: string,
  params: TransactionHistoryParams,
  opts?: { maxTxs?: number; shouldStop?: (tx: any) => boolean },
): AsyncGenerator<any[], void, void> {
  let cursor: string | undefined = params.paginationToken;
  let yielded = 0;
  const cap = opts?.maxTxs ?? Infinity;
  const pageMax = (params.transactionDetails ?? 'full') === 'full' ? 100 : 1000;

  try {
    while (yielded < cap) {
      const page = await getEnhancedTransactionsForAddress(rpcUrl, {
        ...params,
        limit: Math.min(pageMax, cap - yielded),
        paginationToken: cursor,
      });
      if (page.transactions.length === 0) return;
      yield page.transactions;
      yielded += page.transactions.length;
      if (opts?.shouldStop && page.transactions.some(opts.shouldStop)) return;
      if (!page.paginationToken) return;
      cursor = page.paginationToken;
    }
  } catch (e) {
    if (!enhancedUnavailable(e) || yielded > 0) throw e;
    console.warn('[tx-history] enhanced getTransactionsForAddress unavailable; falling back to standard Solana RPC history');
    yield* iterateStandardTransactionsForAddress(rpcUrl, params, opts);
  }
}
