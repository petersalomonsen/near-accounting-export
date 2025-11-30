// RPC helper module for NEAR blockchain interactions using @near-js/jsonrpc-client

import { NearRpcClient, query, block as getBlock } from '@near-js/jsonrpc-client';
import type { 
    AccountView, 
    CallResult,
    RpcBlockResponse 
} from '@near-js/jsonrpc-types';

const DEFAULT_RPC_ENDPOINT = 'https://archival-rpc.mainnet.fastnear.com';
const RPC_DELAY_MS = parseInt(process.env.RPC_DELAY_MS || '50', 10);

/**
 * Get headers for RPC requests, including Authorization if API key is set
 */
function getRpcHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    const apiKey = process.env.FASTNEAR_API_KEY;
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

// Stop signal for graceful cancellation
let stopSignal = false;

// Custom error class for rate limiting
export class RateLimitError extends Error {
    statusCode: number;
    
    constructor(message = 'Rate limit exceeded (429)') {
        super(message);
        this.name = 'RateLimitError';
        this.statusCode = 429;
    }
}

// RPC client instance
let client: NearRpcClient | null = null;

/**
 * Get or create the RPC client
 */
export function getClient(): NearRpcClient {
    if (!client) {
        const endpoint = process.env.NEAR_RPC_ENDPOINT || DEFAULT_RPC_ENDPOINT;
        const headers = getRpcHeaders();
        client = new NearRpcClient({ endpoint, headers });
    }
    return client;
}

/**
 * Set a custom RPC client
 */
export function setClient(newClient: NearRpcClient): void {
    client = newClient;
}

/**
 * Set the stop signal
 */
export function setStopSignal(value: boolean): void {
    stopSignal = value;
}

/**
 * Get the stop signal
 */
export function getStopSignal(): boolean {
    return stopSignal;
}

/**
 * Delay helper
 */
async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check for rate limit errors and handle appropriately
 */
function checkRateLimitError(error: any): void {
    const errorStr = error.message || '';
    if (errorStr.includes('429') || errorStr.includes('Too Many Requests') ||
        errorStr.includes('rate limit') || errorStr.includes('RATE_LIMIT') ||
        errorStr.includes('Rate limits exceeded')) {
        console.error('Rate limit detected, stopping search:', error);
        stopSignal = true;
        throw new RateLimitError();
    }
}

/**
 * Wrapper for RPC calls to handle rate limits and delays
 */
async function wrapRpcCall<T>(fn: () => Promise<T>): Promise<T> {
    if (stopSignal) {
        throw new Error('Operation cancelled - rate limit detected');
    }

    try {
        await delay(RPC_DELAY_MS);
        return await fn();
    } catch (error) {
        checkRateLimitError(error);
        throw error;
    }
}

/**
 * Get current block height
 */
export async function getCurrentBlockHeight(): Promise<number> {
    try {
        const blockResult = await wrapRpcCall(() => 
            getBlock(getClient(), { finality: 'final' })
        );
        return blockResult.header.height;
    } catch (error: any) {
        console.error('Error getting current block height:', error.message);
        throw new Error('Could not get current block height');
    }
}

/**
 * Check if an error is an unknown block error
 */
function isUnknownBlockError(error: any): boolean {
    const errorStr = error.message || '';
    const dataStr = typeof error.data === 'string' ? error.data : '';
    return errorStr.includes('UNKNOWN_BLOCK') || 
           dataStr.includes('UNKNOWN_BLOCK') ||
           errorStr.includes('DB Not Found Error: BLOCK HEIGHT') ||
           dataStr.includes('DB Not Found Error: BLOCK HEIGHT');
}

/**
 * Check if an error indicates the account doesn't exist at a block
 */
export function isAccountNotFoundError(error: any): boolean {
    const errorStr = error.message || '';
    const dataStr = typeof error.data === 'string' ? error.data : '';
    return errorStr.includes('does not exist') || 
           dataStr.includes('does not exist') ||
           errorStr.includes('UNKNOWN_ACCOUNT') ||
           dataStr.includes('UNKNOWN_ACCOUNT');
}

/**
 * View account state at a specific block
 * Retries with adjacent blocks if the block is not found (skipped block)
 */
export async function viewAccount(
    accountId: string,
    blockId: number | string
): Promise<AccountView> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    // For numeric block IDs, retry with adjacent blocks if not found
    if (typeof blockId === 'number') {
        let currentBlock = blockId;
        let lastError: any = null;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                return await wrapRpcCall(() => 
                    query(getClient(), {
                        requestType: 'view_account',
                        accountId,
                        blockId: currentBlock,
                        finality: undefined
                    }) as Promise<AccountView>
                );
            } catch (error: any) {
                lastError = error;
                if (isUnknownBlockError(error)) {
                    console.warn(`Block ${currentBlock} not found, trying block ${currentBlock - 1}`);
                    currentBlock--;
                } else if (isAccountNotFoundError(error)) {
                    // Account doesn't exist at this block - this is a valid state, not an error to retry
                    throw new Error(`Account ${accountId} does not exist at block ${blockId}`);
                } else {
                    console.error(`RPC error in viewAccount for ${accountId} at block ${blockId}:`, error.message);
                    throw error;
                }
            }
        }

        console.error(`RPC error in viewAccount for ${accountId} at block ${blockId}: Could not find valid block after 5 attempts`);
        throw lastError || new Error(`Could not find valid block near ${blockId}`);
    }

    // For string block IDs (like 'final'), just do a single attempt
    try {
        return await wrapRpcCall(() => 
            query(getClient(), {
                requestType: 'view_account',
                accountId,
                blockId: blockId,
                finality: blockId === 'final' ? 'final' : undefined
            }) as Promise<AccountView>
        );
    } catch (error: any) {
        console.error(`RPC error in viewAccount for ${accountId} at block ${blockId}:`, error.message);
        throw error;
    }
}

/**
 * Call a view function on a contract
 * Retries with adjacent blocks if the block is not found (skipped block)
 */
export async function callViewFunction(
    contractId: string,
    methodName: string,
    args: Record<string, any>,
    blockId: number | string
): Promise<string> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const argsBase64 = Buffer.from(JSON.stringify(args)).toString('base64');

    // For numeric block IDs, retry with adjacent blocks if not found
    if (typeof blockId === 'number') {
        let currentBlock = blockId;
        let lastError: any = null;

        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                const result = await wrapRpcCall(() =>
                    query(getClient(), {
                        requestType: 'call_function',
                        accountId: contractId,
                        methodName,
                        argsBase64,
                        blockId: currentBlock,
                        finality: undefined
                    }) as Promise<CallResult>
                );

                // Decode the result from base64/bytes
                const bytes = new Uint8Array(result.result);
                const text = new TextDecoder().decode(bytes);
                return JSON.parse(text);
            } catch (error: any) {
                lastError = error;
                if (isUnknownBlockError(error)) {
                    console.warn(`Block ${currentBlock} not found for ${contractId}.${methodName}, trying block ${currentBlock - 1}`);
                    currentBlock--;
                } else {
                    console.error(`RPC error in callViewFunction for ${contractId}.${methodName} at block ${blockId}:`, error.message);
                    throw error;
                }
            }
        }

        console.error(`RPC error in callViewFunction for ${contractId}.${methodName} at block ${blockId}: Could not find valid block after 5 attempts`);
        throw lastError || new Error(`Could not find valid block near ${blockId}`);
    }

    // For string block IDs (like 'final'), just do a single attempt
    try {
        const result = await wrapRpcCall(() =>
            query(getClient(), {
                requestType: 'call_function',
                accountId: contractId,
                methodName,
                argsBase64,
                blockId: blockId,
                finality: blockId === 'final' ? 'final' : undefined
            }) as Promise<CallResult>
        );

        // Decode the result from base64/bytes
        const bytes = new Uint8Array(result.result);
        const text = new TextDecoder().decode(bytes);
        return JSON.parse(text);
    } catch (error: any) {
        console.error(`RPC error in callViewFunction for ${contractId}.${methodName} at block ${blockId}:`, error.message);
        throw error;
    }
}

/**
 * Fetch detailed block data including receipts
 */
export async function fetchBlockData(blockHeight: number): Promise<RpcBlockResponse> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    // Try to fetch the block, if it fails with server error or unknown block, retry with previous block
    let currentBlock = blockHeight;
    let lastError: any = null;

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            return await wrapRpcCall(() =>
                getBlock(getClient(), { blockId: currentBlock })
            );
        } catch (error: any) {
            lastError = error;
            if (isUnknownBlockError(error) || error.message?.includes('500') || error.message?.includes('Server error')) {
                console.warn(`Block ${currentBlock} not found or server error, retrying with block ${currentBlock - 1}`);
                currentBlock--;
            } else {
                throw error;
            }
        }
    }

    throw lastError || new Error(`Failed to fetch block data after 5 attempts`);
}

/**
 * Get transaction status with receipts (not directly supported by jsonrpc-client, using fetch)
 */
export async function getTransactionStatusWithReceipts(
    txHash: string,
    senderId: string
): Promise<any> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const endpoint = process.env.NEAR_RPC_ENDPOINT || DEFAULT_RPC_ENDPOINT;
    const headers: Record<string, string> = { 
        'Content-Type': 'application/json',
        ...getRpcHeaders()
    };
    
    return wrapRpcCall(async () => {
        await delay(RPC_DELAY_MS);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: '1',
                method: 'tx',
                params: [txHash, senderId]
            })
        });

        if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
        }

        const data = await response.json() as any;
        
        if (data.error) {
            throw new Error(data.error.message || JSON.stringify(data.error));
        }

        return data.result;
    });
}
