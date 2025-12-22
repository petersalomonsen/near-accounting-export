// NEAR Intents Explorer API module for fetching intents transaction data
// This provides a faster alternative to binary search for discovering intents transactions
// API Documentation: https://explorer.near-intents.org/api/docs
// OpenAPI Spec: https://explorer.near-intents.org/api/v0/openapi.yaml

// API base URLs
const INTENTS_EXPLORER_API_BASE = process.env.INTENTS_EXPLORER_API_URL || 'https://explorer.near-intents.org';
const NEARBLOCKS_API_BASE = 'https://api.nearblocks.io/v1';

/**
 * Get headers for Intents Explorer API requests
 * JWT token is required for all API requests
 */
function getIntentsHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Accept': 'application/json'
    };
    const apiKey = process.env.INTENTS_EXPLORER_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

/**
 * Get headers for NearBlocks API requests (used for tx hash lookup)
 */
function getNearBlocksHeaders(): Record<string, string> {
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
 * API rate limit: 1 request per 5 seconds per partner
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get configured delay for API rate limiting
 * Default to 5100ms to respect the 1 request per 5 seconds limit
 */
function getIntentsRateLimitDelay(): number {
    const envDelay = process.env.INTENTS_EXPLORER_DELAY_MS;
    return envDelay ? parseInt(envDelay, 10) : 5100; // Default 5.1s for API rate limit
}

/**
 * Look up block height for a transaction hash using NearBlocks API
 */
export async function getBlockHeightFromTxHash(txHash: string): Promise<number | null> {
    try {
        await delay(100); // Small delay for NearBlocks rate limiting
        
        const url = `${NEARBLOCKS_API_BASE}/txns/${txHash}`;
        const response = await fetch(url, { headers: getNearBlocksHeaders() });
        
        if (!response.ok) {
            return null;
        }
        
        const data = await response.json() as { txns: Array<{ included_in_block_hash: string; block: { block_height: number } }> };
        const firstTxn = data.txns?.[0];
        if (firstTxn?.block?.block_height) {
            return firstTxn.block.block_height;
        }
        return null;
    } catch {
        return null;
    }
}

// Transaction from Intents Explorer API (matching actual API response format)
export interface IntentsExplorerTxn {
    originAsset: string;              // e.g., "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near"
    destinationAsset: string;         // e.g., "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
    depositAddress: string;
    depositAddressAndMemo: string;
    recipient: string;                // NEAR account ID
    status: 'SUCCESS' | 'FAILED' | 'INCOMPLETE_DEPOSIT' | 'PENDING_DEPOSIT' | 'PROCESSING' | 'REFUNDED';
    createdAt: string;                // ISO 8601 format
    createdAtTimestamp: number;       // Unix timestamp
    intentHashes: string | null;
    referral: string | null;
    amountInFormatted: string;
    amountOutFormatted: string;
    appFees: Array<{ fee: number; recipient: string }>;
    nearTxHashes: string[];           // Array of NEAR transaction hashes
    originChainTxHashes: string[];
    destinationChainTxHashes: string[];
    amountIn: string;
    amountInUsd: string;
    amountOut: string;
    amountOutUsd: string;
    refundTo: string;
    refundReason: string | null;
}

// Paginated response from the API
export interface IntentsExplorerPaginatedResponse {
    data: IntentsExplorerTxn[];
    totalPages: number;
    page: number;
    perPage: number;
    total: number;
    nextPage: number | null;
    prevPage: number | null;
}

// Simplified transaction block info for the main script
// Compatible with the TransactionBlock interface from nearblocks-api.ts
export interface IntentsTransactionBlock {
    blockHeight: number;              // Block height (resolved from transaction hash)
    blockTimestamp: string;           // ISO timestamp
    transactionHash: string;          // Primary transaction hash
    nearTxHashes: string[];           // All NEAR transaction hashes
    createdAtTimestamp: number;       // Unix timestamp for ordering
    recipient: string;                // Account that received the swap
    originAsset: string;              // Source asset
    destinationAsset: string;         // Destination asset
    tokenIds: string[];               // Extracted token IDs from assets
    amountIn: string;
    amountOut: string;
    status: string;
}

/**
 * Parse asset string to extract token contract ID
 * e.g., "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" -> "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"
 * e.g., "nep141:wrap.near" -> "wrap.near"
 * e.g., "near" -> "near"
 */
export function parseAssetToTokenId(asset: string): string | null {
    if (!asset) return null;
    
    // Handle native NEAR
    if (asset.toLowerCase() === 'near') {
        return 'near';
    }
    
    // For intents.near multi-token contract, token IDs need the full prefix format
    // e.g., "nep141:wrap.near" not just "wrap.near"
    // Return the asset as-is since the API already provides correct format
    return asset;
}

/**
 * Fetch paginated intents transactions from Intents Explorer API
 */
export async function fetchIntentsTransactions(
    options: {
        page?: number;
        perPage?: number;
        search?: string;          // Search by deposit address, recipient, or intent hashes
        startTimestampUnix?: number;
        endTimestampUnix?: number;
        statuses?: string;        // Comma-separated: FAILED,INCOMPLETE_DEPOSIT,PENDING_DEPOSIT,PROCESSING,REFUNDED,SUCCESS
    } = {}
): Promise<IntentsExplorerPaginatedResponse> {
    if (!process.env.INTENTS_EXPLORER_API_KEY) {
        throw new Error('INTENTS_EXPLORER_API_KEY is not configured. Obtain a JWT token from https://docs.google.com/forms/d/e/1FAIpQLSdrSrqSkKOMb_a8XhwF0f7N5xZ0Y5CYgyzxiAuoC2g4a2N68g/viewform');
    }
    
    const { 
        page = 1, 
        perPage = 50, 
        search,
        startTimestampUnix,
        endTimestampUnix,
        statuses = 'SUCCESS,REFUNDED' // Default to completed transactions
    } = options;
    
    const params = new URLSearchParams();
    params.set('page', page.toString());
    params.set('perPage', perPage.toString());
    params.set('statuses', statuses);
    
    if (search) {
        params.set('search', search);
    }
    if (startTimestampUnix) {
        params.set('startTimestampUnix', startTimestampUnix.toString());
    }
    if (endTimestampUnix) {
        params.set('endTimestampUnix', endTimestampUnix.toString());
    }
    
    const url = `${INTENTS_EXPLORER_API_BASE}/api/v0/transactions-pages?${params.toString()}`;
    
    await delay(getIntentsRateLimitDelay());
    
    const response = await fetch(url, { headers: getIntentsHeaders() });
    
    if (response.status === 401) {
        throw new Error('Intents Explorer API authentication failed. Check your INTENTS_EXPLORER_API_KEY.');
    }
    if (response.status === 429) {
        throw new Error('Intents Explorer API rate limit exceeded. Wait 5 seconds between requests.');
    }
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Intents Explorer API error: ${response.status} ${response.statusText} - ${text}`);
    }
    
    return response.json() as Promise<IntentsExplorerPaginatedResponse>;
}

/**
 * Get all intents transactions for an account within a time range
 * Returns transactions sorted by block height descending (newest first)
 * Resolves block heights from transaction hashes via NearBlocks API
 */
export async function getAllIntentsTransactionBlocks(
    accountId: string,
    options: {
        afterBlock?: number;
        beforeBlock?: number;
        maxPages?: number;
    } = {}
): Promise<IntentsTransactionBlock[]> {
    const { afterBlock, beforeBlock, maxPages = 20 } = options;
    
    // Note: The API doesn't support block-based filtering, so we fetch all transactions
    // and filter by block range after resolving block heights from transaction hashes
    
    const transactions: IntentsTransactionBlock[] = [];
    const seenTxHashes = new Set<string>();
    
    console.log(`Fetching intents transactions from Intents Explorer API for account ${accountId}...`);
    
    let page = 1;
    let hasMore = true;
    
    while (hasMore && page <= maxPages) {
        try {
            const response = await fetchIntentsTransactions({
                page,
                perPage: 50,
                search: accountId  // Search by recipient account
            });
            
            for (const txn of response.data) {
                // Only include transactions where this account is the recipient
                if (txn.recipient !== accountId) {
                    continue;
                }
                
                // Skip if no NEAR tx hashes
                if (!txn.nearTxHashes || txn.nearTxHashes.length === 0) {
                    continue;
                }
                
                // Skip if we've already seen these transaction hashes
                const txHashKey = txn.nearTxHashes.sort().join(',');
                if (seenTxHashes.has(txHashKey)) {
                    continue;
                }
                seenTxHashes.add(txHashKey);
                
                // Look up block height from the first transaction hash
                const primaryTxHash = txn.nearTxHashes[0];
                if (!primaryTxHash) {
                    console.log(`  Skipping transaction - no valid transaction hash`);
                    continue;
                }
                const blockHeight = await getBlockHeightFromTxHash(primaryTxHash);
                
                if (blockHeight === null) {
                    console.log(`  Skipping transaction - could not resolve block height for ${primaryTxHash}`);
                    continue;
                }
                
                // Note: We don't filter by block range here - let the main script decide
                // what transactions to process based on its search direction and range
                
                // Extract token IDs from assets
                const tokenIds: string[] = [];
                const originToken = parseAssetToTokenId(txn.originAsset);
                const destToken = parseAssetToTokenId(txn.destinationAsset);
                if (originToken) tokenIds.push(originToken);
                if (destToken && destToken !== originToken) tokenIds.push(destToken);
                
                transactions.push({
                    blockHeight,
                    blockTimestamp: txn.createdAt,
                    transactionHash: primaryTxHash,
                    nearTxHashes: txn.nearTxHashes,
                    createdAtTimestamp: txn.createdAtTimestamp,
                    recipient: txn.recipient,
                    originAsset: txn.originAsset,
                    destinationAsset: txn.destinationAsset,
                    tokenIds,
                    amountIn: txn.amountIn,
                    amountOut: txn.amountOut,
                    status: txn.status
                });
            }
            
            console.log(`  Page ${page}/${response.totalPages}: Found ${response.data.length} transactions (${transactions.length} with resolved blocks so far)`);
            
            // Check if there are more pages
            hasMore = response.nextPage !== null && page < response.totalPages;
            page++;
            
        } catch (error: any) {
            console.warn(`Error fetching intents transactions page ${page}: ${error.message}`);
            break;
        }
    }
    
    console.log(`  Found ${transactions.length} intents transactions for ${accountId}`);
    
    // Sort by block height descending (newest first)
    transactions.sort((a, b) => b.blockHeight - a.blockHeight);
    
    return transactions;
}

/**
 * Check if Intents Explorer API is available and configured
 * The API requires a JWT token obtained via application form
 */
export function isIntentsExplorerAvailable(): boolean {
    return !!process.env.INTENTS_EXPLORER_API_KEY;
}
