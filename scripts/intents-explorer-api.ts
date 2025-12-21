// NEAR Intents Explorer API module for fetching intents transaction data
// This provides a faster alternative to binary search for discovering intents transactions

const INTENTS_EXPLORER_API_BASE = 'https://api.intents.near.org/v1';

/**
 * Get headers for Intents Explorer API requests
 */
function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    const apiKey = process.env.INTENTS_EXPLORER_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

/**
 * Delay helper for rate limiting
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Transaction from Intents Explorer API
export interface IntentsExplorerTxn {
    transaction_hash: string;
    block_height: number;
    block_timestamp: string;
    account_id: string;
    token_ids: string[];
    amounts: string[];
    direction: 'in' | 'out';
    counterparty?: string;
}

export interface IntentsExplorerTxnResponse {
    transactions: IntentsExplorerTxn[];
    cursor?: string | null;
    has_more: boolean;
}

// Simplified transaction block info for the main script
export interface IntentsTransactionBlock {
    blockHeight: number;
    blockTimestamp: string;
    transactionHash: string;
    tokenIds: string[];
    amounts: string[];
}

/**
 * Fetch intents transactions from Intents Explorer API
 */
export async function fetchIntentsTransactions(
    accountId: string,
    options: {
        perPage?: number;
        cursor?: string;
        afterBlock?: number;
        beforeBlock?: number;
    } = {}
): Promise<IntentsExplorerTxnResponse> {
    const { perPage = 25, cursor, afterBlock, beforeBlock } = options;
    
    let url = `${INTENTS_EXPLORER_API_BASE}/transactions/${accountId}?limit=${perPage}`;
    
    if (cursor) {
        url += `&cursor=${cursor}`;
    }
    if (afterBlock) {
        url += `&after_block=${afterBlock}`;
    }
    if (beforeBlock) {
        url += `&before_block=${beforeBlock}`;
    }
    
    await delay(100); // Rate limiting
    
    const response = await fetch(url, { headers: getHeaders() });
    
    if (!response.ok) {
        throw new Error(`Intents Explorer API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<IntentsExplorerTxnResponse>;
}

/**
 * Get all intents transaction blocks for an account within a block range
 * Returns unique block heights where intents transactions occurred, sorted descending
 */
export async function getAllIntentsTransactionBlocks(
    accountId: string,
    options: {
        afterBlock?: number;
        beforeBlock?: number;
        maxPages?: number;
    } = {}
): Promise<IntentsTransactionBlock[]> {
    const { afterBlock, beforeBlock, maxPages = 10 } = options;
    
    const blocks: IntentsTransactionBlock[] = [];
    const seenBlocks = new Set<number>();
    
    console.log(`Fetching intents transaction blocks from Intents Explorer API...`);
    
    let cursor: string | undefined;
    let pages = 0;
    
    while (pages < maxPages) {
        try {
            const response = await fetchIntentsTransactions(accountId, {
                perPage: 25,
                cursor,
                afterBlock,
                beforeBlock
            });
            
            for (const txn of response.transactions) {
                const blockHeight = txn.block_height;
                if (!seenBlocks.has(blockHeight)) {
                    seenBlocks.add(blockHeight);
                    blocks.push({
                        blockHeight,
                        blockTimestamp: txn.block_timestamp,
                        transactionHash: txn.transaction_hash,
                        tokenIds: txn.token_ids,
                        amounts: txn.amounts
                    });
                }
            }
            
            pages++;
            
            if (!response.has_more || !response.cursor || response.transactions.length === 0) {
                break;
            }
            
            cursor = response.cursor;
        } catch (error: any) {
            console.warn(`Error fetching intents transactions: ${error.message}`);
            break;
        }
    }
    
    console.log(`  Found ${blocks.length} intents transaction blocks`);
    
    // Sort by block height descending
    blocks.sort((a, b) => b.blockHeight - a.blockHeight);
    
    return blocks;
}

/**
 * Check if Intents Explorer API is available (API key is set or public access)
 */
export function isIntentsExplorerAvailable(): boolean {
    // The API may work without a key, but having a key provides higher rate limits
    // For now, we'll make it always available and let the API call fail if it doesn't work
    return true;
}
