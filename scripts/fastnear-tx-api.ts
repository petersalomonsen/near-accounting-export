// FastNear TX API module for fetching transaction data
// Uses the tx.main.fastnear.com service which provides comprehensive
// transaction history for NEAR accounts via simple paginated POST calls.
// This is a free public API — no API key required.

const FASTNEAR_TX_API_BASE = process.env.FASTNEAR_TX_API_URL || 'https://tx.main.fastnear.com';

const FASTNEAR_TX_DELAY_MS = parseInt(process.env.FASTNEAR_TX_DELAY_MS || '50', 10);

/**
 * Delay helper for rate limiting
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Transaction entry from FastNear TX API /v0/account
export interface FastNearAccountTx {
    account_id: string;
    transaction_hash: string;
    tx_block_height: number;
    tx_block_timestamp: string; // nanoseconds since epoch
    tx_index: number;
    is_signer: boolean;
    is_receiver: boolean;
    is_predecessor: boolean;
    is_real_signer: boolean;
    is_real_receiver: boolean;
    is_any_signer: boolean;
    is_delegated_signer: boolean;
    is_event_log: boolean;
    is_explicit_refund_to: boolean;
    is_function_call: boolean;
    is_action_arg: boolean;
    is_success: boolean;
}

export interface FastNearAccountResponse {
    account_txs: FastNearAccountTx[];
    resume_token: string | null;
    txs_count: number;
}

// Simplified transaction block info matching the project pattern
export interface FastNearTransactionBlock {
    blockHeight: number;
    blockTimestamp: string;
    transactionHash: string;
}

/**
 * Fetch account transactions from FastNear TX API (single page)
 */
export async function fetchAccountTransactions(
    accountId: string,
    options: {
        limit?: number;
        resumeToken?: string;
    } = {}
): Promise<FastNearAccountResponse> {
    const { limit = 100, resumeToken } = options;

    const body: Record<string, unknown> = {
        account_id: accountId,
        limit,
    };
    if (resumeToken) {
        body.resume_token = resumeToken;
    }

    const url = `${FASTNEAR_TX_API_BASE}/v0/account`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

    if (!response.ok) {
        throw new Error(`FastNear TX API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<FastNearAccountResponse>;
}

/**
 * Fetch all transaction blocks for an account from FastNear TX API.
 * Paginates through the full history using resume_token.
 *
 * Returns blocks filtered by optional afterBlock/beforeBlock range,
 * deduplicated by block height.
 */
export async function getAllFastNearTxTransactionBlocks(
    accountId: string,
    options: {
        afterBlock?: number;
        beforeBlock?: number;
    } = {}
): Promise<FastNearTransactionBlock[]> {
    const { afterBlock, beforeBlock } = options;

    const seenBlockHeights = new Set<number>();
    const blocks: FastNearTransactionBlock[] = [];
    let resumeToken: string | null = null;
    let pageCount = 0;
    const maxPages = 1000; // safety limit

    console.log(`[FastNear TX] Fetching transactions for ${accountId}...`);

    do {
        if (pageCount > 0) {
            await delay(FASTNEAR_TX_DELAY_MS);
        }

        const response = await fetchAccountTransactions(accountId, {
            limit: 100,
            resumeToken: resumeToken || undefined,
        });

        if (pageCount === 0) {
            console.log(`[FastNear TX] Total transactions for ${accountId}: ${response.txs_count}`);
        }

        let allBelowRange = response.account_txs.length > 0;
        for (const tx of response.account_txs) {
            const blockHeight = tx.tx_block_height;

            // Results come in descending order (newest first).
            // If we have an afterBlock filter, track whether all txs on this page
            // are at or below it — if so, we can stop paginating.
            if (afterBlock !== undefined && blockHeight > afterBlock) {
                allBelowRange = false;
            }

            // Apply block range filters
            if (afterBlock !== undefined && blockHeight <= afterBlock) continue;
            if (beforeBlock !== undefined && blockHeight >= beforeBlock) continue;

            // Deduplicate by block height
            if (seenBlockHeights.has(blockHeight)) continue;
            seenBlockHeights.add(blockHeight);

            // Convert nanosecond timestamp to ISO string
            const timestampMs = Math.floor(Number(BigInt(tx.tx_block_timestamp) / 1000000n));
            const blockTimestamp = new Date(timestampMs).toISOString();

            blocks.push({
                blockHeight,
                blockTimestamp,
                transactionHash: tx.transaction_hash,
            });
        }

        // Stop early if all transactions on this page are below our range
        if (afterBlock !== undefined && allBelowRange) {
            console.log(`[FastNear TX] All transactions on page are below block ${afterBlock}, stopping early`);
            break;
        }

        resumeToken = response.resume_token;
        pageCount++;

        if (pageCount % 10 === 0) {
            console.log(`[FastNear TX] Fetched ${pageCount} pages, ${blocks.length} unique blocks so far...`);
        }
    } while (resumeToken && pageCount < maxPages);

    console.log(`[FastNear TX] Done: ${blocks.length} unique blocks from ${pageCount} pages`);

    // Sort by block height ascending (oldest first)
    blocks.sort((a, b) => a.blockHeight - b.blockHeight);

    return blocks;
}

/**
 * FastNear TX API is always available (public, no key required)
 */
export function isFastNearTxAvailable(): boolean {
    return true;
}
