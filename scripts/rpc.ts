// RPC helper module for NEAR blockchain interactions using @near-js/jsonrpc-client

import { NearRpcClient, query, block as getBlock } from '@near-js/jsonrpc-client';
import type { 
    AccountView, 
    CallResult,
    RpcBlockResponse 
} from '@near-js/jsonrpc-types';

const DEFAULT_RPC_ENDPOINT = 'https://archival-rpc.mainnet.fastnear.com';
const RPC_DELAY_MS = parseInt(process.env.RPC_DELAY_MS || '50', 10);

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
        client = new NearRpcClient({ endpoint });
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
 * View account state at a specific block
 */
export async function viewAccount(
    accountId: string,
    blockId: number | string
): Promise<AccountView> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    return wrapRpcCall(() => 
        query(getClient(), {
            requestType: 'view_account',
            accountId,
            blockId: typeof blockId === 'string' ? blockId : blockId,
            finality: typeof blockId === 'string' && blockId === 'final' ? 'final' : undefined
        }) as Promise<AccountView>
    );
}

/**
 * Call a view function on a contract
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
    
    const result = await wrapRpcCall(() =>
        query(getClient(), {
            requestType: 'call_function',
            accountId: contractId,
            methodName,
            argsBase64,
            blockId: typeof blockId === 'string' ? blockId : blockId,
            finality: typeof blockId === 'string' && blockId === 'final' ? 'final' : undefined
        }) as Promise<CallResult>
    );

    // Decode the result from base64/bytes
    const bytes = new Uint8Array(result.result);
    const text = new TextDecoder().decode(bytes);
    return JSON.parse(text);
}

/**
 * Fetch detailed block data including receipts
 */
export async function fetchBlockData(blockHeight: number): Promise<RpcBlockResponse> {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    // Try to fetch the block, if it fails with server error, retry with previous block
    let currentBlock = blockHeight;
    let lastError: any = null;

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await wrapRpcCall(() =>
                getBlock(getClient(), { blockId: currentBlock })
            );
        } catch (error: any) {
            lastError = error;
            if (error.message?.includes('500') || error.message?.includes('Server error')) {
                console.warn(`Server error at block ${currentBlock}, retrying with block ${currentBlock - 1}`);
                currentBlock--;
            } else {
                throw error;
            }
        }
    }

    throw lastError || new Error(`Failed to fetch block data after 3 attempts`);
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
    
    return wrapRpcCall(async () => {
        await delay(RPC_DELAY_MS);
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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
