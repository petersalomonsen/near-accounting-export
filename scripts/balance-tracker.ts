// Balance tracker for efficient transaction discovery using binary search
// Based on https://github.com/arizas/Ariz-Portfolio/blob/feature/balance-based-discovery/public_html/near/balance-tracker.js

import {
    viewAccount,
    callViewFunction,
    getCurrentBlockHeight,
    fetchBlockData,
    fetchNeardataBlock,
    getTransactionStatusWithReceipts,
    getStopSignal,
    isAccountNotFoundError
} from './rpc.js';
import type { RpcBlockResponse } from '@near-js/jsonrpc-types';
import type { ReceiptExecutionOutcome, NeardataBlockResponse } from './rpc.js';

// Types
export interface BalanceSnapshot {
    near: string;
    fungibleTokens: Record<string, string>;
    intentsTokens: Record<string, string>;
}

export interface BalanceChanges {
    hasChanges: boolean;
    nearChanged: boolean;
    tokensChanged: Record<string, { start: string; end: string; diff: string }>;
    intentsChanged: Record<string, { start: string; end: string; diff: string }>;
    nearDiff?: string;
    startBalance?: BalanceSnapshot;
    endBalance?: BalanceSnapshot;
    block?: number;
}

/**
 * Transfer detail capturing the counterparty and amount for a balance change
 */
export interface TransferDetail {
    type: 'near' | 'ft' | 'mt';  // NEAR native, Fungible Token, Multi-Token (intents)
    direction: 'in' | 'out';
    amount: string;
    counterparty: string;  // The other account involved in the transfer
    tokenId?: string;  // For FT: contract address, for MT: token identifier
    memo?: string;
    txHash?: string;
    receiptId?: string;
}

export interface TransactionInfo {
    transactions: any[];
    transactionHashes: string[];
    transactionBlock: number | null;
    receiptBlock: number;
    blockTimestamp: number | null;
    transfers: TransferDetail[];  // Detailed transfer information
}

// Cache for balance snapshots to avoid redundant RPC calls
const balanceCache = new Map<string, BalanceSnapshot>();

// Default fungible token contracts to track
const DEFAULT_TOKENS = [
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
    'wrap.near', // wNEAR
    'usdt.tether-token.near' // USDT
];

/**
 * Clear the balance cache
 */
export function clearBalanceCache(): void {
    balanceCache.clear();
}

/**
 * Check if an account exists at a specific block
 * Returns true if account exists, false if it doesn't exist
 */
export async function accountExistsAtBlock(
    accountId: string,
    blockId: number
): Promise<boolean> {
    try {
        await viewAccount(accountId, blockId);
        return true;
    } catch (e: any) {
        if (e.message?.includes('does not exist')) {
            return false;
        }
        throw e;
    }
}

/**
 * Get fungible token balances for account
 */
async function getFungibleTokenBalances(
    accountId: string,
    blockId: number | string,
    tokenContracts: string[] = []
): Promise<Record<string, string>> {
    const balances: Record<string, string> = {};

    for (const token of tokenContracts) {
        if (getStopSignal()) {
            throw new Error('Operation cancelled by user');
        }

        try {
            const balance = await callViewFunction(
                token,
                'ft_balance_of',
                { account_id: accountId },
                blockId
            );
            balances[token] = balance || '0';
        } catch (e) {
            // Token might not exist at this block or account has no balance
            balances[token] = '0';
        }
    }

    return balances;
}

/**
 * Get Intents multi-token balances
 */
async function getIntentsBalances(
    accountId: string,
    blockId: number | string
): Promise<Record<string, string>> {
    const balances: Record<string, string> = {};

    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    try {
        // First get the tokens owned by the account
        const tokens = await callViewFunction(
            'intents.near',
            'mt_tokens_for_owner',
            { account_id: accountId },
            blockId
        );

        if (!tokens || tokens.length === 0) {
            return balances;
        }

        // Extract token IDs from the token objects
        const tokenIds = Array.isArray(tokens) ? tokens.map((token: any) => 
            typeof token === 'string' ? token : token.token_id
        ) : [];

        // Get balances for all tokens in batch
        try {
            if (getStopSignal()) {
                throw new Error('Operation cancelled by user');
            }

            const batchBalances = await callViewFunction(
                'intents.near',
                'mt_batch_balance_of',
                {
                    token_ids: tokenIds,
                    account_id: accountId
                },
                blockId
            );

            if (batchBalances && Array.isArray(batchBalances)) {
                tokenIds.forEach((tokenId: string, index: number) => {
                    balances[tokenId] = batchBalances[index] || '0';
                });
            }
        } catch (e: any) {
            console.warn(`Could not get balances for intents tokens:`, e.message);
            for (const tokenId of tokenIds) {
                balances[tokenId] = '0';
            }
        }
    } catch (e) {
        // Account might not have any intents tokens
    }

    return balances;
}

/**
 * Get all balances (NEAR, fungible tokens, intents) for an account at a specific block
 */
export async function getAllBalances(
    accountId: string,
    blockId: number | string,
    tokenContracts: string[] | null | undefined = undefined,
    intentsTokens: string[] | null | undefined = undefined,
    checkNear = true
): Promise<BalanceSnapshot> {
    const cacheKey = `${accountId}:${blockId}:${JSON.stringify(tokenContracts)}:${JSON.stringify(intentsTokens)}:${checkNear}`;

    if (balanceCache.has(cacheKey)) {
        return balanceCache.get(cacheKey)!;
    }

    const result: BalanceSnapshot = {
        near: '0',
        fungibleTokens: {},
        intentsTokens: {}
    };

    // Get NEAR balance
    if (checkNear) {
        try {
            const account = await viewAccount(accountId, blockId);
            result.near = account?.amount || '0';
        } catch (e: any) {
            if (!e.message?.includes('does not exist')) {
                throw e;
            }
        }
    }

    // Get fungible token balances if specified
    if (tokenContracts === null) {
        result.fungibleTokens = {};
    } else if (tokenContracts !== undefined) {
        if (tokenContracts.length > 0) {
            result.fungibleTokens = await getFungibleTokenBalances(accountId, blockId, tokenContracts);
        } else {
            result.fungibleTokens = {};
        }
    } else {
        result.fungibleTokens = await getFungibleTokenBalances(accountId, blockId, DEFAULT_TOKENS);
    }

    // Get intents tokens if specified
    if (intentsTokens === null) {
        result.intentsTokens = {};
    } else if (intentsTokens !== undefined) {
        if (intentsTokens.length > 0) {
            const intentsBalances: Record<string, string> = {};
            try {
                if (getStopSignal()) {
                    throw new Error('Operation cancelled by user');
                }

                const batchBalances = await callViewFunction(
                    'intents.near',
                    'mt_batch_balance_of',
                    {
                        token_ids: intentsTokens,
                        account_id: accountId
                    },
                    blockId
                );

                if (batchBalances && Array.isArray(batchBalances)) {
                    intentsTokens.forEach((token, index) => {
                        intentsBalances[token] = batchBalances[index] || '0';
                    });
                }
            } catch (e: any) {
                console.warn(`Could not get batch balances for intents tokens:`, e.message);
                for (const token of intentsTokens) {
                    intentsBalances[token] = '0';
                }
            }
            result.intentsTokens = intentsBalances;
        } else {
            result.intentsTokens = {};
        }
    } else {
        result.intentsTokens = await getIntentsBalances(accountId, blockId);
    }

    balanceCache.set(cacheKey, result);
    return result;
}

/**
 * Get balance changes at a specific block by comparing block-1 to block
 * This is more efficient than binary search when we already know the block
 */
export async function getBalanceChangesAtBlock(
    accountId: string,
    blockHeight: number,
    tokenContracts: string[] | null | undefined = undefined,
    intentsTokens: string[] | null | undefined = undefined
): Promise<BalanceChanges> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    // Get balances before and after the block
    const balanceBefore = await getAllBalances(accountId, blockHeight - 1, tokenContracts, intentsTokens, true);
    const balanceAfter = await getAllBalances(accountId, blockHeight, tokenContracts, intentsTokens, true);

    const changes = detectBalanceChanges(balanceBefore, balanceAfter);
    changes.block = blockHeight;
    changes.startBalance = balanceBefore;
    changes.endBalance = balanceAfter;

    return changes;
}

/**
 * Detect balance changes between two snapshots
 */
function detectBalanceChanges(
    startBalance: BalanceSnapshot,
    endBalance: BalanceSnapshot
): BalanceChanges {
    const changes: BalanceChanges = {
        hasChanges: false,
        nearChanged: false,
        tokensChanged: {},
        intentsChanged: {}
    };

    // Check NEAR balance
    const startNear = BigInt(startBalance.near || '0');
    const endNear = BigInt(endBalance.near || '0');
    if (startNear !== endNear) {
        changes.hasChanges = true;
        changes.nearChanged = true;
        changes.nearDiff = (endNear - startNear).toString();
    }

    // Check fungible tokens
    const allTokens = new Set([
        ...Object.keys(startBalance.fungibleTokens || {}),
        ...Object.keys(endBalance.fungibleTokens || {})
    ]);

    for (const token of allTokens) {
        const startAmount = BigInt(startBalance.fungibleTokens?.[token] || '0');
        const endAmount = BigInt(endBalance.fungibleTokens?.[token] || '0');
        if (startAmount !== endAmount) {
            changes.hasChanges = true;
            changes.tokensChanged[token] = {
                start: startAmount.toString(),
                end: endAmount.toString(),
                diff: (endAmount - startAmount).toString()
            };
        }
    }

    // Check intents tokens
    const allIntents = new Set([
        ...Object.keys(startBalance.intentsTokens || {}),
        ...Object.keys(endBalance.intentsTokens || {})
    ]);

    for (const token of allIntents) {
        const startAmount = BigInt(startBalance.intentsTokens?.[token] || '0');
        const endAmount = BigInt(endBalance.intentsTokens?.[token] || '0');
        if (startAmount !== endAmount) {
            changes.hasChanges = true;
            changes.intentsChanged[token] = {
                start: startAmount.toString(),
                end: endAmount.toString(),
                diff: (endAmount - startAmount).toString()
            };
        }
    }

    return changes;
}

/**
 * Find the latest block where a balance changed using binary search
 */
export async function findLatestBalanceChangingBlock(
    accountId: string,
    firstBlock: number,
    lastBlock: number,
    tokenContracts: string[] | null | undefined = undefined,
    intentsTokens: string[] | null | undefined = undefined,
    checkNear = true
): Promise<BalanceChanges> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    const startBalance = await getAllBalances(accountId, firstBlock, tokenContracts, intentsTokens, checkNear);
    const endBalance = await getAllBalances(accountId, lastBlock, tokenContracts, intentsTokens, checkNear);

    const detectedChanges = detectBalanceChanges(startBalance, endBalance);

    if (!detectedChanges.hasChanges) {
        return {
            hasChanges: false,
            block: lastBlock,
            startBalance,
            endBalance,
            nearChanged: false,
            tokensChanged: {},
            intentsChanged: {}
        };
    }

    detectedChanges.startBalance = startBalance;
    detectedChanges.endBalance = endBalance;

    const numBlocks = lastBlock - firstBlock;

    if (numBlocks <= 0) {
        // Re-fetch complete balances to ensure we have full snapshot
        const completeStartBalance = await getAllBalances(accountId, firstBlock - 1, undefined, undefined, true);
        const completeEndBalance = await getAllBalances(accountId, firstBlock, undefined, undefined, true);
        const completeChanges = detectBalanceChanges(completeStartBalance, completeEndBalance);
        completeChanges.block = firstBlock;
        completeChanges.startBalance = completeStartBalance;
        completeChanges.endBalance = completeEndBalance;
        return completeChanges;
    }

    if (numBlocks === 1) {
        // Re-fetch complete balances to ensure we have full snapshot
        const completeStartBalance = await getAllBalances(accountId, lastBlock - 1, undefined, undefined, true);
        const completeEndBalance = await getAllBalances(accountId, lastBlock, undefined, undefined, true);
        const completeChanges = detectBalanceChanges(completeStartBalance, completeEndBalance);
        completeChanges.block = lastBlock;
        completeChanges.startBalance = completeStartBalance;
        completeChanges.endBalance = completeEndBalance;
        return completeChanges;
    }

    const middleBlock = lastBlock - Math.floor(numBlocks / 2);

    // Build list of tokens to check in recursion
    const changedTokens: string[] = [];
    if (detectedChanges.tokensChanged) {
        Object.keys(detectedChanges.tokensChanged).forEach(token => {
            if (!changedTokens.includes(token)) {
                changedTokens.push(token);
            }
        });
    }

    const changedIntentsTokens: string[] = [];
    if (detectedChanges.intentsChanged) {
        Object.keys(detectedChanges.intentsChanged).forEach(token => {
            changedIntentsTokens.push(token);
        });
    }

    const lastHalfChanges = await findLatestBalanceChangingBlock(
        accountId,
        middleBlock,
        lastBlock,
        changedTokens.length > 0 ? changedTokens : null,
        changedIntentsTokens.length > 0 ? changedIntentsTokens : null,
        detectedChanges.nearChanged
    );

    if (lastHalfChanges.hasChanges) {
        return lastHalfChanges;
    } else {
        return await findLatestBalanceChangingBlock(
            accountId,
            firstBlock,
            middleBlock,
            changedTokens.length > 0 ? changedTokens : null,
            changedIntentsTokens.length > 0 ? changedIntentsTokens : null,
            detectedChanges.nearChanged
        );
    }
}

/**
 * Parse NEP-141 FT transfer events from logs
 */
function parseFtTransferEvents(
    logs: string[],
    targetAccountId: string,
    contractId: string,
    txHash: string,
    receiptId: string
): TransferDetail[] {
    const transfers: TransferDetail[] = [];
    
    for (const log of logs) {
        if (!log.startsWith('EVENT_JSON:')) continue;
        
        try {
            const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
            
            // NEP-141 ft_transfer event
            if (eventData.standard === 'nep141' && eventData.event === 'ft_transfer') {
                for (const transfer of eventData.data || []) {
                    const oldOwner = transfer.old_owner_id;
                    const newOwner = transfer.new_owner_id;
                    const amount = transfer.amount;
                    const memo = transfer.memo;
                    
                    if (oldOwner === targetAccountId) {
                        transfers.push({
                            type: 'ft',
                            direction: 'out',
                            amount,
                            counterparty: newOwner,
                            tokenId: contractId,
                            memo,
                            txHash,
                            receiptId
                        });
                    } else if (newOwner === targetAccountId) {
                        transfers.push({
                            type: 'ft',
                            direction: 'in',
                            amount,
                            counterparty: oldOwner,
                            tokenId: contractId,
                            memo,
                            txHash,
                            receiptId
                        });
                    }
                }
            }
        } catch (e) {
            // Skip invalid JSON
        }
    }
    
    return transfers;
}

/**
 * Parse NEP-245 Multi-Token (intents) transfer events from logs
 */
function parseMtTransferEvents(
    logs: string[],
    targetAccountId: string,
    contractId: string,
    txHash: string,
    receiptId: string
): TransferDetail[] {
    const transfers: TransferDetail[] = [];
    
    for (const log of logs) {
        if (!log.startsWith('EVENT_JSON:')) continue;
        
        try {
            const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
            
            // NEP-245 mt_transfer event
            if (eventData.standard === 'nep245' && eventData.event === 'mt_transfer') {
                for (const transfer of eventData.data || []) {
                    const oldOwner = transfer.old_owner_id;
                    const newOwner = transfer.new_owner_id;
                    const tokenIds = transfer.token_ids || [];
                    const amounts = transfer.amounts || [];
                    const memo = transfer.memo;
                    
                    for (let i = 0; i < tokenIds.length; i++) {
                        const tokenId = tokenIds[i];
                        const amount = amounts[i] || '0';
                        
                        if (oldOwner === targetAccountId) {
                            transfers.push({
                                type: 'mt',
                                direction: 'out',
                                amount,
                                counterparty: newOwner,
                                tokenId,
                                memo,
                                txHash,
                                receiptId
                            });
                        } else if (newOwner === targetAccountId) {
                            transfers.push({
                                type: 'mt',
                                direction: 'in',
                                amount,
                                counterparty: oldOwner,
                                tokenId,
                                memo,
                                txHash,
                                receiptId
                            });
                        }
                    }
                }
            }
            
            // Also check for mt_mint and mt_burn events
            if (eventData.standard === 'nep245' && eventData.event === 'mt_mint') {
                for (const mint of eventData.data || []) {
                    const owner = mint.owner_id;
                    const tokenIds = mint.token_ids || [];
                    const amounts = mint.amounts || [];
                    const memo = mint.memo;
                    
                    if (owner === targetAccountId) {
                        for (let i = 0; i < tokenIds.length; i++) {
                            transfers.push({
                                type: 'mt',
                                direction: 'in',
                                amount: amounts[i] || '0',
                                counterparty: contractId, // Minted from contract
                                tokenId: tokenIds[i],
                                memo,
                                txHash,
                                receiptId
                            });
                        }
                    }
                }
            }
            
            if (eventData.standard === 'nep245' && eventData.event === 'mt_burn') {
                for (const burn of eventData.data || []) {
                    const owner = burn.owner_id;
                    const tokenIds = burn.token_ids || [];
                    const amounts = burn.amounts || [];
                    const memo = burn.memo;
                    
                    if (owner === targetAccountId) {
                        for (let i = 0; i < tokenIds.length; i++) {
                            transfers.push({
                                type: 'mt',
                                direction: 'out',
                                amount: amounts[i] || '0',
                                counterparty: contractId, // Burned to contract
                                tokenId: tokenIds[i],
                                memo,
                                txHash,
                                receiptId
                            });
                        }
                    }
                }
            }
        } catch (e) {
            // Skip invalid JSON
        }
    }
    
    return transfers;
}

/**
 * Find transaction that caused a balance change
 * Uses neardata.xyz API to get complete block data with execution outcomes and logs
 */
export async function findBalanceChangingTransaction(
    targetAccountId: string,
    balanceChangeBlock: number
): Promise<TransactionInfo> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    const transfers: TransferDetail[] = [];

    try {
        // First try neardata.xyz which provides complete execution outcomes with logs
        const neardataBlock = await fetchNeardataBlock(balanceChangeBlock);
        
        if (neardataBlock) {
            const blockTimestamp = neardataBlock.block?.header?.timestamp;
            const matchingTxHashes = new Set<string>();
            const processedReceipts = new Set<string>();

            // Check all shards for receipt execution outcomes
            for (const shard of neardataBlock.shards || []) {
                for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                    const receipt = receiptExecution.receipt;
                    const executionOutcome = receiptExecution.execution_outcome;
                    const txHash = receiptExecution.tx_hash;
                    const receiptId = receipt?.receipt_id || executionOutcome?.id;

                    const receiverId = receipt?.receiver_id;
                    const predecessorId = receipt?.predecessor_id;
                    const logs = executionOutcome?.outcome?.logs || [];

                    let affectsTargetAccount = false;

                    // Check if this is a direct transfer to/from the account
                    if (receiverId === targetAccountId || predecessorId === targetAccountId) {
                        affectsTargetAccount = true;
                        
                        // Check for NEAR transfer actions and other actions with deposits
                        const actions = receipt?.receipt?.Action?.actions || [];
                        for (const action of actions) {
                            // Helper to record a NEAR transfer
                            const recordNearTransfer = (amount: string | bigint, memo?: string) => {
                                const amountBigInt = typeof amount === 'bigint' ? amount : BigInt(amount);
                                if (amountBigInt > 0n) {
                                    if (predecessorId === targetAccountId) {
                                        transfers.push({
                                            type: 'near',
                                            direction: 'out',
                                            amount: String(amountBigInt),
                                            counterparty: receiverId,
                                            memo,
                                            txHash,
                                            receiptId
                                        });
                                    } else if (receiverId === targetAccountId) {
                                        transfers.push({
                                            type: 'near',
                                            direction: 'in',
                                            amount: String(amountBigInt),
                                            counterparty: predecessorId,
                                            memo,
                                            txHash,
                                            receiptId
                                        });
                                    }
                                }
                            };

                            // Transfer action
                            if (action.Transfer?.deposit) {
                                recordNearTransfer(action.Transfer.deposit);
                            }
                            // FunctionCall action with attached deposit
                            if (action.FunctionCall?.deposit) {
                                recordNearTransfer(action.FunctionCall.deposit, action.FunctionCall.method_name);
                            }
                            // Stake action - locks NEAR as stake
                            if (action.Stake?.stake) {
                                recordNearTransfer(action.Stake.stake, 'stake');
                            }
                            // TransferToGasKey action
                            if (action.TransferToGasKey?.deposit) {
                                recordNearTransfer(action.TransferToGasKey.deposit, 'transfer_to_gas_key');
                            }
                        }
                    }

                    // Parse FT transfer events from logs
                    if (!processedReceipts.has(receiptId)) {
                        const ftTransfers = parseFtTransferEvents(logs, targetAccountId, receiverId, txHash, receiptId);
                        if (ftTransfers.length > 0) {
                            transfers.push(...ftTransfers);
                            affectsTargetAccount = true;
                        }
                        
                        // Parse MT (intents) transfer events from logs
                        const mtTransfers = parseMtTransferEvents(logs, targetAccountId, receiverId, txHash, receiptId);
                        if (mtTransfers.length > 0) {
                            transfers.push(...mtTransfers);
                            affectsTargetAccount = true;
                        }
                        
                        processedReceipts.add(receiptId);
                    }

                    // Check receipt logs for EVENT_JSON entries mentioning the account (fallback)
                    if (!affectsTargetAccount) {
                        for (const log of logs) {
                            if (log.startsWith('EVENT_JSON:')) {
                                try {
                                    const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
                                    const eventStr = JSON.stringify(eventData);
                                    if (eventStr.includes(targetAccountId)) {
                                        affectsTargetAccount = true;
                                        break;
                                    }
                                } catch (e) {
                                    // Skip invalid JSON
                                }
                            }
                        }
                    }

                    if (affectsTargetAccount && txHash && !matchingTxHashes.has(txHash)) {
                        matchingTxHashes.add(txHash);
                    }
                }
            }

            if (matchingTxHashes.size > 0) {
                // Fetch full transaction details for each matching tx
                const fetchedTransactions: any[] = [];
                
                for (const shard of neardataBlock.shards || []) {
                    for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                        const txHash = receiptExecution.tx_hash;
                        const signerId = receiptExecution.receipt?.receipt?.Action?.signer_id;

                        if (matchingTxHashes.has(txHash) && signerId && 
                            !fetchedTransactions.find(t => t.hash === txHash)) {
                            try {
                                const txResult = await getTransactionStatusWithReceipts(txHash, signerId);

                                if (txResult?.transaction) {
                                    const txInfo = txResult.transaction;
                                    fetchedTransactions.push({
                                        hash: txHash,
                                        signerId: txInfo.signer_id,
                                        receiverId: txInfo.receiver_id,
                                        actions: txInfo.actions || []
                                    });
                                }
                            } catch (error: any) {
                                console.error(`Error fetching transaction ${txHash}:`, error.message);
                            }
                        }
                    }
                }

                return {
                    transactions: fetchedTransactions,
                    transactionHashes: Array.from(matchingTxHashes),
                    transactionBlock: balanceChangeBlock,
                    receiptBlock: balanceChangeBlock,
                    blockTimestamp: blockTimestamp || null,
                    transfers
                };
            }
        }

        // Fallback to standard RPC if neardata.xyz fails
        const blockData: RpcBlockResponse = await fetchBlockData(balanceChangeBlock);
        const blockTimestamp = blockData.header?.timestamp;

        // With standard RPC, we can only get basic block data without logs
        // Try to find receipts mentioning the target account
        const matchingTxHashes = new Set<string>();

        for (const chunk of blockData.chunks || []) {
            for (const receipt of (chunk as any).receipts || []) {
                const receiptStr = JSON.stringify(receipt);
                if (receiptStr.includes(targetAccountId)) {
                    const signerId = receipt.receipt?.Action?.signerId;
                    if (signerId) {
                        // We found a receipt but don't have the tx_hash from standard RPC
                        // We'd need to use tx status to get more info
                    }
                }
            }
        }

        return {
            transactions: [],
            transactionHashes: Array.from(matchingTxHashes),
            transactionBlock: matchingTxHashes.size > 0 ? balanceChangeBlock : null,
            receiptBlock: balanceChangeBlock,
            blockTimestamp: blockTimestamp || null,
            transfers
        };
    } catch (error: any) {
        console.error(`Error fetching block data:`, error.message);
    }

    return {
        transactions: [],
        transactionHashes: [],
        transactionBlock: null,
        receiptBlock: balanceChangeBlock,
        blockTimestamp: null,
        transfers
    };
}

/**
 * Find latest balance change with expanding search if needed
 */
export async function findLatestBalanceChangeWithExpansion(
    accountId: string,
    startBlock: number,
    endBlock: number
): Promise<BalanceChanges & { searchStart?: number }> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    const change = await findLatestBalanceChangingBlock(accountId, startBlock, endBlock);

    if (change.hasChanges) {
        return { ...change, searchStart: startBlock };
    }

    let currentStart = startBlock;
    let currentEnd = startBlock;
    let searchWindow = endBlock - startBlock;
    let expansionCount = 0;
    const maxExpansions = 10;

    while (expansionCount < maxExpansions && currentStart > 0) {
        if (getStopSignal()) {
            throw new Error('Operation cancelled by user');
        }

        searchWindow *= 2;
        currentStart = Math.max(0, currentEnd - searchWindow);

        console.log(`No changes found in blocks ${startBlock}-${endBlock}, expanding to ${currentStart}-${currentEnd} (expansion ${expansionCount + 1})`);

        const expandedChange = await findLatestBalanceChangingBlock(accountId, currentStart, currentEnd);

        if (expandedChange.hasChanges) {
            return { ...expandedChange, searchStart: currentStart };
        }

        expansionCount++;
        currentEnd = currentStart;
    }

    return {
        hasChanges: false,
        block: startBlock,
        nearChanged: false,
        tokensChanged: {},
        intentsChanged: {}
    };
}

/**
 * Get block height estimate at a specific date
 */
export async function getBlockHeightAtDate(date: Date | string): Promise<number> {
    const targetDate = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const secondsDiff = Math.floor((now.getTime() - targetDate.getTime()) / 1000);

    const currentBlock = await getCurrentBlockHeight();
    return Math.max(0, currentBlock - secondsDiff);
}
