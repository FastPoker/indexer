/**
 * Helius `getTransactionsForAddress` JSON-RPC client.
 *
 * Replaces the legacy `getSignaturesForAddress + per-tx getTransaction` loop:
 *   - Old: 1 credit (sig page) + N credits (one getTransaction per tx). 1000
 *     txs = ~1,001 credits, ~1,000 round-trips, throttled to avoid 429.
 *   - New: 10 credits per 100 returned (minimum 10). 1000 txs = 100 credits,
 *     ONE round-trip, no throttle. ~10× cheaper, dramatically faster wall-clock.
 *
 * The response is the standard Solana transaction object + meta (same shape as
 * `getTransaction`), so callers can keep their existing decoders. There is an
 * extra `transactionIndex` field; ignore if unused.
 *
 * Pagination via keyset cursor `paginationToken` of the form "slot:position".
 * The response includes `paginationToken` for the next page when more exists.
 *
 * Docs: https://www.helius.dev/docs/rpc/gettransactionsforaddress
 */

export interface HeliusTransactionsParams {
  address: string;
  /** "full" returns the entire tx object; "signatures" returns metadata only. */
  transactionDetails?: 'full' | 'signatures';
  sortOrder?: 'asc' | 'desc';
  /** 1-1000, default 1000. */
  limit?: number;
  /** Keyset cursor from a previous response's `paginationToken`. */
  paginationToken?: string;
  commitment?: 'confirmed' | 'finalized';
  /** Pass 'jsonParsed' to mirror getParsedTransaction; 'json' for raw. */
  encoding?: 'json' | 'jsonParsed' | 'base64' | 'base58';
  filters?: {
    blockTime?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    slot?: { gte?: number; lte?: number; gt?: number; lt?: number; eq?: number };
    signature?: string;
    status?: 'succeeded' | 'failed' | 'any';
    tokenAccounts?: 'balanceChanged' | 'mentioned';
  };
}

export interface HeliusTransactionsResult {
  transactions: any[]; // shape matches getTransaction response per item
  paginationToken: string | null;
}

/**
 * Issue one paginated call. Returns the page of txs plus the next-page token
 * (or null when the address history is exhausted).
 */
export async function getTransactionsForAddress(
  rpcUrl: string,
  params: HeliusTransactionsParams,
): Promise<HeliusTransactionsResult> {
  // Positional params per Helius docs: [address, options]. The first param is
  // the bare address string; the second is an options object. Sending a single
  // merged object yields `Invalid params: invalid type: map, expected a string`.
  // NOTE: Helius caps `limit` at 100 when transactionDetails === 'full' and at
  // 1000 when 'signatures'. We clamp accordingly so callers don't have to know.
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
  if (!res.ok) {
    throw new Error(`getTransactionsForAddress HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result?: any; error?: { message?: string } };
  if (json.error) throw new Error(json.error.message || 'getTransactionsForAddress error');
  const result = json.result ?? {};
  // Helius's response field name has varied across iterations. Accept any of
  // the plausible shapes and log once on first-hit so we don't silently
  // swallow a future schema change.
  const transactions: any[] = Array.isArray(result.transactions)
    ? result.transactions
    : Array.isArray(result.data)        // current Helius shape: { result: { data: [...] } }
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
  if (transactions.length === 0 && !_loggedEmptyShape) {
    _loggedEmptyShape = true;
    const preview = JSON.stringify(result).slice(0, 400);
    console.warn('[helius-tx] empty result; raw shape preview:', preview);
  }
  return { transactions, paginationToken };
}

let _loggedEmptyShape = false;

/**
 * Iterate over all transactions matching params, yielding pages one at a time.
 * Stops when the address is exhausted or `shouldStop(tx)` returns true for any
 * tx in a page (in which case that page is still yielded so the caller can
 * inspect the boundary tx). Pass `maxTxs` for a hard ceiling.
 */
export async function* iterateTransactionsForAddress(
  rpcUrl: string,
  params: HeliusTransactionsParams,
  opts?: { maxTxs?: number; shouldStop?: (tx: any) => boolean },
): AsyncGenerator<any[], void, void> {
  let cursor: string | undefined = params.paginationToken;
  let yielded = 0;
  const cap = opts?.maxTxs ?? Infinity;
  // Page size depends on transactionDetails mode — full mode is capped at 100
  // by Helius; signatures mode supports 1000.
  const pageMax = (params.transactionDetails ?? 'full') === 'full' ? 100 : 1000;
  while (yielded < cap) {
    const limit = Math.min(pageMax, cap - yielded);
    const page = await getTransactionsForAddress(rpcUrl, {
      ...params,
      limit,
      paginationToken: cursor,
    });
    if (page.transactions.length === 0) return;
    yield page.transactions;
    yielded += page.transactions.length;
    if (opts?.shouldStop && page.transactions.some(opts.shouldStop)) return;
    if (!page.paginationToken) return;
    cursor = page.paginationToken;
  }
}
