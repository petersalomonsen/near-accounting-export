// Pikespeak API module for fetching NEAR account transaction history
// This provides an alternative/complementary data source to NearBlocks
// API Documentation: https://doc.pikespeak.ai/
// API Key: https://pikespeak.ai/myaccount

// API base URL
const PIKESPEAK_API_BASE = process.env.PIKESPEAK_API_URL || 'https://api.pikespeak.ai';

/**
 * Get headers for Pikespeak API requests
 * API key is required for all REST API endpoints
 */
function getPikespeakHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Accept': 'application/json'
    };
    const apiKey = process.env.PIKESPEAK_API_KEY;
    if (apiKey) {
        headers['x-api-key'] = apiKey;
    }
    return headers;
}

/**
 * Delay helper for rate limiting
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get configured delay for API rate limiting
 * Default to 100ms between requests
 */
function getPikespeakRateLimitDelay(): number {
    const envDelay = process.env.PIKESPEAK_DELAY_MS;
    return envDelay ? parseInt(envDelay, 10) : 100;
}

// Event types returned by event-historic endpoint
export type PikespeakEventType = 
    | 'NEAR_TRANSFER'
    | 'FT_TRANSFER'
    | 'STAKE_DEPOSIT'
    | 'STAKE_WITHDRAW'
    | 'FUNCTION_CALL'
    | 'DAO_FUNCTION_CALL'
    | 'DAO_TRANSFER'
    | 'DAO_TRANSFER_FROM_PROPOSAL'
    | 'DAO_ACT_PROPOSAL'
    | 'DAO_CHANGE_CONFIG'
    | 'DAO_CHANGE_POLICY';

// Event from /event-historic/{account} endpoint
export interface PikespeakEvent {
    direction: 'send' | 'receive';
    transaction_id: string;
    receipt_id: string;
    index: number;
    sender: string;
    receiver: string;
    type: PikespeakEventType;
    block_height: string;  // Note: returned as string
    timestamp: string;     // Unix timestamp in milliseconds as string
    transaction_type: string;
    token: string | null;  // FT contract ID for FT_TRANSFER
    '2fa': boolean;
    amount: string | null;
    transaction_view: Record<string, any>;
    amount_numeric: string | null;
}

// NEAR transfer from /account/near-transfer/{account} endpoint
export interface PikespeakNearTransfer {
    transaction_id: string;
    receipt_id: string;
    index: number;
    sender: string;
    receiver: string;
    amount: string;
    status: boolean;
    timestamp: string;  // Unix timestamp in nanoseconds as string
    block_height: number;
    deposit: boolean;   // true = outgoing, false = incoming
}

// FT transfer from /account/ft-transfer/{account} endpoint
export interface PikespeakFtTransfer {
    transaction_id: string;
    receipt_id: string;
    index: number;
    sender: string;
    receiver: string;
    amount: string;
    contract: string;  // FT contract ID
    status: boolean;
    timestamp: string;  // Unix timestamp in nanoseconds as string
    block_height: number;
}

// Staking position from /staking/staking/{account} endpoint
export interface PikespeakStakingPosition {
    pool: string;
    amount: string;
}

// Simplified transaction block info for the main script
// Compatible with the TransactionBlock interface from nearblocks-api.ts
export interface PikespeakTransactionBlock {
    blockHeight: number;
    transactionId: string;
    receiptId: string;
    eventType: PikespeakEventType;
    direction: 'send' | 'receive';
    amount: string | null;
    token: string | null;  // Contract ID for FT transfers
    sender: string;
    receiver: string;
    timestamp: number;  // Unix timestamp in ms
}

/**
 * Fetch events from /event-historic/{account} endpoint
 * This is the most comprehensive endpoint - returns ALL event types
 */
export async function fetchEventHistoric(
    accountId: string,
    options: {
        limit?: number;
        offset?: number;
    } = {}
): Promise<PikespeakEvent[]> {
    if (!process.env.PIKESPEAK_API_KEY) {
        throw new Error('PIKESPEAK_API_KEY is not configured. Get your API key from https://pikespeak.ai/myaccount');
    }
    
    const { limit = 50, offset = 0 } = options;
    
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    
    const url = `${PIKESPEAK_API_BASE}/event-historic/${accountId}?${params.toString()}`;
    
    await delay(getPikespeakRateLimitDelay());
    
    const response = await fetch(url, { headers: getPikespeakHeaders() });
    
    if (response.status === 401 || response.status === 403) {
        throw new Error('Pikespeak API authentication failed. Check your PIKESPEAK_API_KEY.');
    }
    if (response.status === 429) {
        throw new Error('Pikespeak API rate limit exceeded.');
    }
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pikespeak API error: ${response.status} ${response.statusText} - ${text}`);
    }
    
    return response.json() as Promise<PikespeakEvent[]>;
}

/**
 * Get total event count for an account
 */
export async function getEventCount(accountId: string): Promise<number> {
    if (!process.env.PIKESPEAK_API_KEY) {
        throw new Error('PIKESPEAK_API_KEY is not configured');
    }
    
    const url = `${PIKESPEAK_API_BASE}/event-historic/count/${accountId}`;
    
    await delay(getPikespeakRateLimitDelay());
    
    const response = await fetch(url, { headers: getPikespeakHeaders() });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pikespeak API error: ${response.status} - ${text}`);
    }
    
    const countStr = await response.json() as string;
    return parseInt(countStr, 10);
}

/**
 * Fetch NEAR transfers from /account/near-transfer/{account} endpoint
 */
export async function fetchNearTransfers(
    accountId: string,
    options: {
        limit?: number;
        offset?: number;
    } = {}
): Promise<PikespeakNearTransfer[]> {
    if (!process.env.PIKESPEAK_API_KEY) {
        throw new Error('PIKESPEAK_API_KEY is not configured');
    }
    
    const { limit = 50, offset = 0 } = options;
    
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    
    const url = `${PIKESPEAK_API_BASE}/account/near-transfer/${accountId}?${params.toString()}`;
    
    await delay(getPikespeakRateLimitDelay());
    
    const response = await fetch(url, { headers: getPikespeakHeaders() });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pikespeak API error: ${response.status} - ${text}`);
    }
    
    return response.json() as Promise<PikespeakNearTransfer[]>;
}

/**
 * Fetch FT transfers from /account/ft-transfer/{account} endpoint
 */
export async function fetchFtTransfers(
    accountId: string,
    options: {
        limit?: number;
        offset?: number;
    } = {}
): Promise<PikespeakFtTransfer[]> {
    if (!process.env.PIKESPEAK_API_KEY) {
        throw new Error('PIKESPEAK_API_KEY is not configured');
    }
    
    const { limit = 50, offset = 0 } = options;
    
    const params = new URLSearchParams();
    params.set('limit', limit.toString());
    params.set('offset', offset.toString());
    
    const url = `${PIKESPEAK_API_BASE}/account/ft-transfer/${accountId}?${params.toString()}`;
    
    await delay(getPikespeakRateLimitDelay());
    
    const response = await fetch(url, { headers: getPikespeakHeaders() });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pikespeak API error: ${response.status} - ${text}`);
    }
    
    return response.json() as Promise<PikespeakFtTransfer[]>;
}

/**
 * Fetch staking positions from /staking/staking/{account} endpoint
 */
export async function fetchStakingPositions(accountId: string): Promise<PikespeakStakingPosition[]> {
    if (!process.env.PIKESPEAK_API_KEY) {
        throw new Error('PIKESPEAK_API_KEY is not configured');
    }
    
    const url = `${PIKESPEAK_API_BASE}/staking/staking/${accountId}`;
    
    await delay(getPikespeakRateLimitDelay());
    
    const response = await fetch(url, { headers: getPikespeakHeaders() });
    
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Pikespeak API error: ${response.status} - ${text}`);
    }
    
    return response.json() as Promise<PikespeakStakingPosition[]>;
}

/**
 * Event types that indicate balance changes we care about for accounting
 */
const BALANCE_CHANGING_EVENT_TYPES: PikespeakEventType[] = [
    'NEAR_TRANSFER',
    'FT_TRANSFER',
    'STAKE_DEPOSIT',
    'STAKE_WITHDRAW',
    'DAO_TRANSFER',
    'DAO_TRANSFER_FROM_PROPOSAL'
];

/**
 * Get all transaction blocks from Pikespeak API using /event-historic endpoint
 * Returns unique block heights where balance-changing events occurred
 * 
 * Note: Pikespeak API doesn't support block-based filtering, so we fetch all events
 * and filter by block range in-memory after fetching. For large accounts with many
 * events, this may be slower than NearBlocks API when filtering to a specific range.
 */
export async function getAllPikespeakTransactionBlocks(
    accountId: string,
    options: {
        afterBlock?: number;   // Only include blocks > afterBlock
        beforeBlock?: number;  // Only include blocks < beforeBlock
        maxEvents?: number;
    } = {}
): Promise<PikespeakTransactionBlock[]> {
    const { afterBlock, beforeBlock } = options;
    // If maxEvents is undefined, use Infinity to fetch all available events
    const maxEvents = options.maxEvents ?? Infinity;
    
    const transactions: PikespeakTransactionBlock[] = [];
    const seenBlocks = new Set<number>();
    
    console.log(`Fetching transaction blocks from Pikespeak API for account ${accountId}...`);
    if (afterBlock || beforeBlock) {
        console.log(`  Block range filter: ${afterBlock ?? 0} - ${beforeBlock ?? 'latest'}`);
    }
    
    // First get total count
    let totalCount: number;
    try {
        totalCount = await getEventCount(accountId);
        console.log(`  Total events: ${totalCount}`);
    } catch (error: any) {
        console.warn(`  Could not get event count: ${error.message}`);
        totalCount = maxEvents === Infinity ? 10000 : maxEvents;
    }
    
    const limit = 50;
    let offset = 0;
    let fetchedEvents = 0;
    let skippedByRange = 0;
    
    // When maxEvents is Infinity, only limit by totalCount
    const effectiveMax = maxEvents === Infinity ? totalCount : Math.min(totalCount, maxEvents);
    
    // Track if we've seen any blocks in range (to enable early exit for sorted data)
    let seenBlocksInRange = false;
    let consecutiveOutOfRange = 0;
    const MAX_CONSECUTIVE_OUT_OF_RANGE = 200; // Stop if we've passed the range
    
    while (offset < effectiveMax) {
        try {
            const events = await fetchEventHistoric(accountId, { limit, offset });
            
            if (events.length === 0) {
                break;
            }
            
            for (const event of events) {
                fetchedEvents++;
                
                // Only include balance-changing events
                if (!BALANCE_CHANGING_EVENT_TYPES.includes(event.type)) {
                    continue;
                }
                
                const blockHeight = parseInt(event.block_height, 10);
                
                // Apply block range filter
                if (afterBlock !== undefined && blockHeight <= afterBlock) {
                    skippedByRange++;
                    consecutiveOutOfRange++;
                    // If we've seen blocks in range and now we're consistently out of range,
                    // we can stop early (events are sorted by time/block descending)
                    if (seenBlocksInRange && consecutiveOutOfRange > MAX_CONSECUTIVE_OUT_OF_RANGE) {
                        console.log(`  Early exit: passed block range filter (${consecutiveOutOfRange} consecutive out-of-range)`);
                        offset = effectiveMax; // Force exit from outer loop
                        break;
                    }
                    continue;
                }
                if (beforeBlock !== undefined && blockHeight >= beforeBlock) {
                    skippedByRange++;
                    // Don't increment consecutiveOutOfRange here - we haven't reached the range yet
                    continue;
                }
                
                // Reset consecutive counter when we find an in-range block
                consecutiveOutOfRange = 0;
                seenBlocksInRange = true;
                
                // Skip if we've already seen this block
                // (We want unique blocks, not duplicate events in same block)
                if (seenBlocks.has(blockHeight)) {
                    continue;
                }
                seenBlocks.add(blockHeight);
                
                transactions.push({
                    blockHeight,
                    transactionId: event.transaction_id,
                    receiptId: event.receipt_id,
                    eventType: event.type,
                    direction: event.direction,
                    amount: event.amount_numeric || event.amount,
                    token: event.token,
                    sender: event.sender,
                    receiver: event.receiver,
                    timestamp: parseInt(event.timestamp, 10)
                });
            }
            
            const rangeInfo = skippedByRange > 0 ? `, ${skippedByRange} filtered by range` : '';
            console.log(`  Fetched ${fetchedEvents}/${effectiveMax} events, ${transactions.length} unique balance-changing blocks${rangeInfo}`);
            
            offset += limit;
            
        } catch (error: any) {
            console.warn(`Error fetching Pikespeak events at offset ${offset}: ${error.message}`);
            break;
        }
    }
    
    console.log(`  Found ${transactions.length} unique balance-changing blocks from Pikespeak`);
    
    // Sort by block height descending (newest first)
    transactions.sort((a, b) => b.blockHeight - a.blockHeight);
    
    return transactions;
}

/**
 * Check if Pikespeak API is available and configured
 */
export function isPikespeakAvailable(): boolean {
    return !!process.env.PIKESPEAK_API_KEY;
}

/**
 * Get staking pool contracts from Pikespeak staking positions
 * This can help discover staking pools without needing to scan
 */
export async function getStakingPoolsFromPikespeak(accountId: string): Promise<string[]> {
    try {
        const positions = await fetchStakingPositions(accountId);
        return positions.map(p => p.pool);
    } catch {
        return [];
    }
}
