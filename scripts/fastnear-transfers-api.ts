// FastNear Transfers API module
//
// Uses the transfers.main.fastnear.com /v0/transfers service, which provides
// account-centric NEAR and fungible-token (NEP-141) transfer history with the
// authoritative per-receipt amount AND the start/end-of-block balances already
// computed by FastNear's indexer.
//
// Why this exists (and why it is preferable to the discover-block ->
// reparse-receipts -> sample-ft_balance_of pipeline):
//
//   The older pipeline discovers a *transaction* block N (via the FastNear TX
//   /v0/account index) and then samples ft_balance_of at N and N+1, assuming an
//   FT transfer settles within one block. For multi-hop cross-contract calls
//   (e.g. claiming from distribution.nearmobile.near, whose ft_transfer settles
//   at N+2) the credit lands OUTSIDE that window, so no balance change is
//   detected and the transfer is silently dropped.
//
//   The transfers API reports every transfer at its real *receipt* block with
//   the real amount and the real start/end-of-block balances, so there is no
//   "which block did it settle in" guesswork. block_height, amount,
//   start_of_block_balance and end_of_block_balance map almost 1:1 onto a
//   BalanceChangeRecord.
//
// This is a free public API — no API key required.
//
// Scope: NEAR (native:near) and FT (nep141:* with asset_type "Ft") only.
// Intents internal multi-tokens (NEP-245 on intents.near) and staking-pool
// balances are NOT covered here and keep their existing discovery paths.

import { detectTokenGaps, type BalanceChangeRecord, type TokenGap } from './balance-tracker.js';

const FASTNEAR_TRANSFERS_API_BASE =
    process.env.FASTNEAR_TRANSFERS_API_URL || 'https://transfers.main.fastnear.com';

const FASTNEAR_TRANSFERS_DELAY_MS = parseInt(process.env.FASTNEAR_TRANSFERS_DELAY_MS || '50', 10);

// Retry tuning for rate limiting (HTTP 429) and transient 5xx errors.
// A full-history fetch is many pages, so the budget is generous and capped.
const FASTNEAR_TRANSFERS_MAX_RETRIES = parseInt(process.env.FASTNEAR_TRANSFERS_MAX_RETRIES || '8', 10);
const FASTNEAR_TRANSFERS_RETRY_BASE_MS = parseInt(process.env.FASTNEAR_TRANSFERS_RETRY_BASE_MS || '1000', 10);
const FASTNEAR_TRANSFERS_RETRY_CAP_MS = parseInt(process.env.FASTNEAR_TRANSFERS_RETRY_CAP_MS || '30000', 10);

/** Delay helper for rate limiting between paginated requests. */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Request headers, including Authorization when FASTNEAR_API_KEY is set (raises rate limits). */
function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const apiKey = process.env.FASTNEAR_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

export type TransferDirection = 'sender' | 'receiver';

/** A single transfer row as returned by /v0/transfers. */
export interface FastNearTransfer {
    account_id: string;
    action_index: number;
    amount: string;                  // base units, signed (+ when receiver, - when sender)
    asset_id: string;                // "native:near" | "nep141:<contract>"
    asset_type: string;              // "Native" | "Ft"
    block_height: string;            // stringified u64
    block_timestamp: string;         // nanoseconds since epoch, stringified
    end_of_block_balance: string;
    human_amount?: number;
    log_index: number;
    method_name: string | null;
    other_account_id: string | null; // counterparty
    predecessor_id: string | null;
    receipt_account_id: string | null; // contract that executed the receipt
    receipt_id: string | null;
    signer_id: string | null;
    start_of_block_balance: string;
    transaction_id: string | null;
    transfer_index: number;
    transfer_type?: string;
    usd_amount?: number;
}

export interface FastNearTransfersResponse {
    resume_token: string | null;
    transfers: FastNearTransfer[];
}

export interface FetchTransfersOptions {
    direction: TransferDirection;
    assetId?: string;
    desc?: boolean;
    limit?: number;
    fromTimestampMs?: number;
    toTimestampMs?: number;
    ignoreSystem?: boolean;
    minAmount?: string;
    resumeToken?: string;
}

/**
 * Fetch a single page of transfers for an account/direction.
 */
export async function fetchAccountTransfersPage(
    accountId: string,
    options: FetchTransfersOptions
): Promise<FastNearTransfersResponse> {
    const body: Record<string, unknown> = {
        account_id: accountId,
        direction: options.direction,
        desc: options.desc ?? true,
        limit: options.limit ?? 100,
    };
    if (options.assetId) body.asset_id = options.assetId;
    if (options.fromTimestampMs !== undefined) body.from_timestamp_ms = options.fromTimestampMs;
    if (options.toTimestampMs !== undefined) body.to_timestamp_ms = options.toTimestampMs;
    if (options.ignoreSystem !== undefined) body.ignore_system = options.ignoreSystem;
    if (options.minAmount !== undefined) body.min_amount = options.minAmount;
    if (options.resumeToken) body.resume_token = options.resumeToken;

    const url = `${FASTNEAR_TRANSFERS_API_BASE}/v0/transfers`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= FASTNEAR_TRANSFERS_MAX_RETRIES; attempt++) {
        const response = await fetch(url, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify(body),
        });

        if (response.ok) {
            return response.json() as Promise<FastNearTransfersResponse>;
        }

        // Retry on rate limiting (429) and transient server errors (5xx),
        // honoring Retry-After when present, otherwise exponential backoff.
        if ((response.status === 429 || response.status >= 500) && attempt < FASTNEAR_TRANSFERS_MAX_RETRIES) {
            const retryAfter = Number(response.headers.get('retry-after'));
            const base = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : Math.min(FASTNEAR_TRANSFERS_RETRY_BASE_MS * 2 ** attempt, FASTNEAR_TRANSFERS_RETRY_CAP_MS);
            // Full jitter to avoid synchronized retries hammering the limiter.
            const backoff = base / 2 + Math.random() * (base / 2);
            await delay(backoff);
            lastError = new Error(`FastNear Transfers API error: ${response.status} ${response.statusText}`);
            continue;
        }

        throw new Error(`FastNear Transfers API error: ${response.status} ${response.statusText}`);
    }

    throw lastError ?? new Error('FastNear Transfers API error: exhausted retries');
}

export interface GetAllTransfersOptions {
    /** One or both directions. Defaults to both. */
    directions?: TransferDirection[];
    assetId?: string;
    /** Only keep transfers with block_height > afterBlock (client-side; API has no block filter). */
    afterBlock?: number;
    /** Only keep transfers with block_height < beforeBlock. */
    beforeBlock?: number;
    fromTimestampMs?: number;
    toTimestampMs?: number;
    /** Safety cap on pages per direction. */
    maxPages?: number;
}

/**
 * Stable identity for a transfer so sender/receiver pages (and retries) dedupe.
 * A receipt can emit several transfers, distinguished by log/action/transfer index.
 */
function transferKey(t: FastNearTransfer): string {
    return [
        t.receipt_id ?? t.transaction_id ?? '',
        t.asset_id,
        t.log_index,
        t.action_index,
        t.transfer_index,
        t.amount,
    ].join(':');
}

/**
 * Fetch all transfers for an account across the requested directions,
 * paginating each direction and deduplicating the merged result.
 *
 * Results are returned newest-first (descending block_height).
 */
export async function getAllAccountTransfers(
    accountId: string,
    options: GetAllTransfersOptions = {}
): Promise<FastNearTransfer[]> {
    const directions = options.directions ?? ['receiver', 'sender'];
    const maxPages = options.maxPages ?? 1000;

    const seen = new Set<string>();
    const merged: FastNearTransfer[] = [];

    for (const direction of directions) {
        let resumeToken: string | null = null;
        let pageCount = 0;

        do {
            if (pageCount > 0) {
                await delay(FASTNEAR_TRANSFERS_DELAY_MS);
            }

            const page: FastNearTransfersResponse = await fetchAccountTransfersPage(accountId, {
                direction,
                assetId: options.assetId,
                desc: true,
                limit: 100,
                fromTimestampMs: options.fromTimestampMs,
                toTimestampMs: options.toTimestampMs,
                resumeToken: resumeToken || undefined,
            });

            let allBelowRange = page.transfers.length > 0;
            for (const t of page.transfers) {
                const blockHeight = Number(t.block_height);

                // Descending order: once everything on the page is at/below
                // afterBlock we can stop paginating this direction.
                if (options.afterBlock !== undefined && blockHeight > options.afterBlock) {
                    allBelowRange = false;
                }
                if (options.afterBlock !== undefined && blockHeight <= options.afterBlock) continue;
                if (options.beforeBlock !== undefined && blockHeight >= options.beforeBlock) continue;

                const key = transferKey(t);
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(t);
            }

            if (options.afterBlock !== undefined && allBelowRange) break;

            resumeToken = page.resume_token;
            pageCount++;
        } while (resumeToken && pageCount < maxPages);
    }

    merged.sort((a, b) => Number(b.block_height) - Number(a.block_height));
    return merged;
}

/**
 * Map a transfers-API asset_id to the V2 BalanceChangeRecord token_id convention:
 *   - "native:near"            -> "near"
 *   - "nep141:<contract>" (Ft) -> "<contract>"   (bare FT contract id)
 * The bare-contract form matches how FT records are stored today; the "nep141:"
 * prefix is reserved for intents internal tokens, which this API does not emit.
 */
export function assetIdToTokenId(assetId: string, assetType?: string): string {
    if (assetId === 'native:near' || assetType === 'Native') return 'near';
    if (assetId.startsWith('nep141:')) return assetId.slice('nep141:'.length);
    return assetId;
}

/** Convert a nanosecond block timestamp string to an ISO-8601 date string. */
function nsToIso(ns: string): string {
    const ms = Number(BigInt(ns) / 1000000n);
    return new Date(ms).toISOString();
}

/**
 * Map a FastNear transfer to a flat V2 BalanceChangeRecord.
 *
 * The transfer already carries authoritative balances, so no ft_balance_of
 * sampling is needed: start_of_block_balance -> balance_before and
 * end_of_block_balance -> balance_after.
 */
export function mapTransferToRecord(t: FastNearTransfer): BalanceChangeRecord {
    return {
        block_height: Number(t.block_height),
        block_timestamp: nsToIso(t.block_timestamp),
        tx_hash: t.transaction_id,
        tx_block: null, // transfers API reports the receipt block, not the tx-submission block
        signer_id: t.signer_id,
        receiver_id: t.receipt_account_id,
        predecessor_id: t.predecessor_id,
        token_id: assetIdToTokenId(t.asset_id, t.asset_type),
        receipt_id: t.receipt_id,
        counterparty: t.other_account_id,
        amount: t.amount,
        balance_before: t.start_of_block_balance,
        balance_after: t.end_of_block_balance,
    };
}

/**
 * High-level helper: fetch all NEAR + FT transfers for an account and return
 * them as V2 BalanceChangeRecords (newest-first).
 */
export async function getAccountTransferRecords(
    accountId: string,
    options: GetAllTransfersOptions = {}
): Promise<BalanceChangeRecord[]> {
    const transfers = await getAllAccountTransfers(accountId, options);
    return transfers.map(mapTransferToRecord);
}

/**
 * Fills a single continuity gap by sampling the chain directly. Given the
 * token, the block where the last good balance was known (`fromBlock`) and the
 * block where the balance no longer matches (`toBlock`), it must return any
 * BalanceChangeRecords needed to reconnect balance_after(from) to
 * balance_before(to). Returning [] means "could not reconstruct" (the gap is
 * left for a later cycle / logged).
 */
export type GapSampler = (gap: TokenGap) => Promise<BalanceChangeRecord[]>;

export interface ReconcileResult {
    /** Original records plus any records produced by the sampler. */
    records: BalanceChangeRecord[];
    /** Discontinuities detected in the transfers-derived records. */
    gaps: TokenGap[];
    /** Records contributed by the sampler to close gaps. */
    filled: BalanceChangeRecord[];
}

/**
 * Reconcile transfers-derived records against per-token balance continuity.
 *
 * The transfers API is the primary source; this is the safety net the user
 * asked for: where balance_after of one record does not equal balance_before of
 * the next (for the same token), a transfer was missed and we fall back to
 * balance *sampling* — but ONLY for those specific block ranges, never as the
 * default path.
 *
 * The actual sampling is injected (`sampler`) so this module stays free of the
 * heavy RPC/neardata machinery; the worker passes a sampler backed by the
 * existing getBalanceChangesAtBlock / findBalanceChangingTransaction code.
 */
export async function reconcileTransferGaps(
    records: BalanceChangeRecord[],
    sampler: GapSampler
): Promise<ReconcileResult> {
    const gaps = detectTokenGaps(records);
    if (gaps.length === 0) {
        return { records, gaps, filled: [] };
    }

    const filled: BalanceChangeRecord[] = [];
    for (const gap of gaps) {
        const recovered = await sampler(gap);
        filled.push(...recovered);
    }

    const merged = [...records, ...filled].sort((a, b) => b.block_height - a.block_height);
    return { records: merged, gaps, filled };
}
