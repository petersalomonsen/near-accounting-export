// RPC helper module for NEAR blockchain interactions
import { JsonRpcProvider } from '@near-js/providers';

// Configuration
const RPC_DELAY_MS = parseInt(process.env.RPC_DELAY_MS || '50', 10);
const DEFAULT_RPC_ENDPOINT = 'https://archival-rpc.mainnet.near.org';

// Helper to add delay between RPC calls
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Stop signal for cancellation
let stopSignal = false;

export function setStopSignal(value) {
    stopSignal = value;
}

export function getStopSignal() {
    return stopSignal;
}

// Custom error class for rate limiting
export class RateLimitError extends Error {
    constructor(message = 'Rate limit exceeded (429)') {
        super(message);
        this.name = 'RateLimitError';
        this.statusCode = 429;
    }
}

// RPC provider instance
let provider = null;

/**
 * Get or create the RPC provider
 * @returns {JsonRpcProvider}
 */
export function getProvider() {
    if (!provider) {
        const endpoint = process.env.NEAR_RPC_ENDPOINT || DEFAULT_RPC_ENDPOINT;
        provider = new JsonRpcProvider({ url: endpoint });
    }
    return provider;
}

/**
 * Set a custom provider (useful for testing)
 * @param {JsonRpcProvider} customProvider 
 */
export function setProvider(customProvider) {
    provider = customProvider;
}

/**
 * Check for rate limit errors and handle appropriately
 * @param {Error} error 
 */
function checkRateLimitError(error) {
    const errorStr = error.message || '';
    if (errorStr.includes('429') || errorStr.includes('Too Many Requests') ||
        errorStr.includes('rate limit') || errorStr.includes('RATE_LIMIT')) {
        console.error('Rate limit detected, stopping search:', error);
        stopSignal = true;
        throw new RateLimitError();
    }
}

/**
 * Wrapper for RPC calls to handle rate limits and delays
 * @param {Function} fn - Function to call
 * @param  {...any} args - Arguments to pass
 */
async function wrapRpcCall(fn, ...args) {
    if (stopSignal) {
        throw new Error('Operation cancelled - rate limit detected');
    }

    try {
        await delay(RPC_DELAY_MS);
        return await fn(...args);
    } catch (error) {
        checkRateLimitError(error);
        throw error;
    }
}

/**
 * Get current block height
 * @returns {Promise<number>} Current block height
 */
export async function getCurrentBlockHeight() {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const provider = getProvider();
    const result = await wrapRpcCall(() => provider.status());
    
    if (result?.sync_info?.latest_block_height) {
        return result.sync_info.latest_block_height;
    }
    throw new Error('Could not get current block height');
}

/**
 * View account details at specific block
 * @param {string} accountId - Account ID
 * @param {number|string} blockId - Block height or 'final'
 * @returns {Promise<Object>} Account info
 */
export async function viewAccount(accountId, blockId) {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const provider = getProvider();
    
    try {
        const params = blockId === 'final'
            ? { request_type: 'view_account', finality: 'final', account_id: accountId }
            : { request_type: 'view_account', block_id: blockId, account_id: accountId };
        
        return await wrapRpcCall(() => provider.query(params));
    } catch (error) {
        // Handle account not existing
        if (error.message?.includes('does not exist') || 
            error.message?.includes('UNKNOWN_ACCOUNT')) {
            return {
                amount: '0',
                locked: '0',
                code_hash: '',
                storage_usage: 0,
                storage_paid_at: 0
            };
        }
        
        // Handle server errors by retrying with a different block
        if (error.message?.includes('Server error') && blockId !== 'final' && typeof blockId === 'number') {
            console.warn(`Server error at block ${blockId}, retrying with block ${blockId - 1}`);
            return await viewAccount(accountId, blockId - 1);
        }
        
        throw error;
    }
}

/**
 * Call view function on a contract
 * @param {string} contractId - Contract ID
 * @param {string} methodName - Method name
 * @param {Object} args - Arguments
 * @param {number|string} blockId - Block height or 'final'
 * @returns {Promise<any>} Result
 */
export async function callViewFunction(contractId, methodName, args = {}, blockId = 'final') {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const provider = getProvider();
    const argsBase64 = Buffer.from(JSON.stringify(args)).toString('base64');
    
    const params = blockId === 'final'
        ? {
            request_type: 'call_function',
            finality: 'final',
            account_id: contractId,
            method_name: methodName,
            args_base64: argsBase64
        }
        : {
            request_type: 'call_function',
            block_id: blockId,
            account_id: contractId,
            method_name: methodName,
            args_base64: argsBase64
        };
    
    const result = await wrapRpcCall(() => provider.query(params));
    
    // Parse the result if it's a valid UTF-8 string
    if (result?.result) {
        try {
            const resultStr = Buffer.from(result.result).toString('utf-8');
            return JSON.parse(resultStr);
        } catch (e) {
            return result;
        }
    }
    
    return result;
}

/**
 * Get transaction status with receipts
 * @param {string} txHash - Transaction hash
 * @param {string} signerId - Signer ID
 * @returns {Promise<Object>} Transaction result
 */
export async function getTransactionStatusWithReceipts(txHash, signerId) {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const provider = getProvider();
    return await wrapRpcCall(() => provider.txStatusReceipts(txHash, signerId, 'EXECUTED_OPTIMISTIC'));
}

/**
 * Get block data
 * @param {number} blockHeight - Block height
 * @returns {Promise<Object>} Block data
 */
export async function getBlock(blockHeight) {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const provider = getProvider();
    return await wrapRpcCall(() => provider.block({ blockId: blockHeight }));
}

/**
 * Fetch block data from neardata.xyz API (includes receipt execution outcomes)
 * @param {number} blockHeight - Block height
 * @returns {Promise<Object>} Block data with receipt execution outcomes
 */
export async function fetchBlockData(blockHeight) {
    if (stopSignal) {
        throw new Error('Operation cancelled by user');
    }

    const url = `https://mainnet.neardata.xyz/v0/block/${blockHeight}`;
    
    await delay(RPC_DELAY_MS);
    const response = await fetch(url);
    
    if (!response.ok) {
        throw new Error(`Failed to fetch block data: ${response.status}`);
    }
    
    return await response.json();
}
