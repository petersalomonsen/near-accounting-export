// NearBlocks API module for fetching transaction data
// This provides a faster alternative to binary search for discovering transactions

const NEARBLOCKS_API_BASE = 'https://api.nearblocks.io/v1';

/**
 * Get headers for NearBlocks API requests
 */
function getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    const apiKey = process.env.NEARBLOCKS_API_KEY;
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

// Transaction from NearBlocks API
export interface NearBlocksTxn {
    id: string;
    receipt_id: string;
    predecessor_account_id: string;
    receiver_account_id: string;
    receipt_kind: string;
    receipt_block: {
        block_hash: string;
        block_height: number;
        block_timestamp: number;
    };
    receipt_outcome: {
        gas_burnt: number;
        tokens_burnt: string;
        executor_account_id: string;
        status: boolean;
    };
    transaction_hash: string;
    included_in_block_hash: string;
    block_timestamp: string;
    block: {
        block_height: number;
    };
    actions: Array<{
        action: string;
        method: string | null;
        deposit: number | string;
        fee: number | string;
        args: string | null;
    }>;
    actions_agg: {
        deposit: number | string;
    };
    outcomes: {
        status: boolean;
    };
    outcomes_agg: {
        transaction_fee: number | string;
    };
}

// FT Transaction from NearBlocks API
export interface NearBlocksFtTxn {
    event_index: string;
    affected_account_id: string;
    involved_account_id: string;
    delta_amount: string;
    cause: string;
    transaction_hash: string;
    included_in_block_hash: string;
    block_timestamp: string;
    block: {
        block_height: number;
    };
    outcomes: {
        status: boolean;
    };
    ft: {
        contract: string;
        name: string;
        symbol: string;
        decimals: number;
        icon: string | null;
        reference: string | null;
    };
}

export interface NearBlocksTxnResponse {
    txns: NearBlocksTxn[];
    cursor: string | null;
}

export interface NearBlocksFtTxnResponse {
    txns: NearBlocksFtTxn[];
    cursor: string | null;
}

// Simplified transaction block info for the main script
export interface TransactionBlock {
    blockHeight: number;
    blockTimestamp: string;
    transactionHash: string;
    type: 'near' | 'ft';
    ftContract?: string;
    ftAmount?: string;
}

/**
 * Fetch account transactions from NearBlocks API
 */
export async function fetchAccountTransactions(
    accountId: string,
    options: {
        perPage?: number;
        cursor?: string;
        afterBlock?: number;
        beforeBlock?: number;
    } = {}
): Promise<NearBlocksTxnResponse> {
    const { perPage = 25, cursor, afterBlock, beforeBlock } = options;
    
    let url = `${NEARBLOCKS_API_BASE}/account/${accountId}/txns?per_page=${perPage}`;
    
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
        throw new Error(`NearBlocks API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<NearBlocksTxnResponse>;
}

/**
 * Fetch FT transactions from NearBlocks API
 */
export async function fetchFtTransactions(
    accountId: string,
    options: {
        perPage?: number;
        cursor?: string;
        afterBlock?: number;
        beforeBlock?: number;
    } = {}
): Promise<NearBlocksFtTxnResponse> {
    const { perPage = 25, cursor, afterBlock, beforeBlock } = options;
    
    let url = `${NEARBLOCKS_API_BASE}/account/${accountId}/ft-txns?per_page=${perPage}`;
    
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
        throw new Error(`NearBlocks API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<NearBlocksFtTxnResponse>;
}

/**
 * Get all transaction blocks (NEAR + FT) for an account within a block range
 * Returns unique block heights where transactions occurred, sorted descending
 */
export async function getAllTransactionBlocks(
    accountId: string,
    options: {
        afterBlock?: number;
        beforeBlock?: number;
        maxPages?: number;
    } = {}
): Promise<TransactionBlock[]> {
    const { afterBlock, beforeBlock, maxPages = 10 } = options;
    
    const blocks: TransactionBlock[] = [];
    const seenBlocks = new Set<number>();
    
    console.log(`Fetching transaction blocks from NearBlocks API...`);
    
    // Fetch NEAR transactions
    let nearCursor: string | undefined;
    let nearPages = 0;
    
    while (nearPages < maxPages) {
        try {
            const response = await fetchAccountTransactions(accountId, {
                perPage: 25,
                cursor: nearCursor,
                afterBlock,
                beforeBlock
            });
            
            for (const txn of response.txns) {
                const blockHeight = txn.receipt_block.block_height;
                if (!seenBlocks.has(blockHeight)) {
                    seenBlocks.add(blockHeight);
                    blocks.push({
                        blockHeight,
                        blockTimestamp: txn.block_timestamp,
                        transactionHash: txn.transaction_hash,
                        type: 'near'
                    });
                }
            }
            
            nearPages++;
            
            if (!response.cursor || response.txns.length === 0) {
                break;
            }
            
            nearCursor = response.cursor;
        } catch (error: any) {
            console.warn(`Error fetching NEAR transactions: ${error.message}`);
            break;
        }
    }
    
    console.log(`  Found ${blocks.length} NEAR transaction blocks`);
    
    // Fetch FT transactions
    let ftCursor: string | undefined;
    let ftPages = 0;
    const ftBlocks: TransactionBlock[] = [];
    
    while (ftPages < maxPages) {
        try {
            const response = await fetchFtTransactions(accountId, {
                perPage: 25,
                cursor: ftCursor,
                afterBlock,
                beforeBlock
            });
            
            for (const txn of response.txns) {
                const blockHeight = txn.block.block_height;
                if (!seenBlocks.has(blockHeight)) {
                    seenBlocks.add(blockHeight);
                    ftBlocks.push({
                        blockHeight,
                        blockTimestamp: txn.block_timestamp,
                        transactionHash: txn.transaction_hash,
                        type: 'ft',
                        ftContract: txn.ft.contract,
                        ftAmount: txn.delta_amount
                    });
                }
            }
            
            ftPages++;
            
            if (!response.cursor || response.txns.length === 0) {
                break;
            }
            
            ftCursor = response.cursor;
        } catch (error: any) {
            console.warn(`Error fetching FT transactions: ${error.message}`);
            break;
        }
    }
    
    console.log(`  Found ${ftBlocks.length} additional FT transaction blocks`);
    
    // Combine and sort by block height descending
    const allBlocks = [...blocks, ...ftBlocks];
    allBlocks.sort((a, b) => b.blockHeight - a.blockHeight);
    
    console.log(`  Total: ${allBlocks.length} unique transaction blocks`);
    
    return allBlocks;
}

/**
 * Check if NearBlocks API is available (API key is set)
 */
export function isNearBlocksAvailable(): boolean {
    return !!process.env.NEARBLOCKS_API_KEY;
}
