// Balance tracker for efficient transaction discovery using binary search
// Based on https://github.com/arizas/Ariz-Portfolio/blob/feature/balance-based-discovery/public_html/near/balance-tracker.js

import {
    viewAccount,
    callViewFunction,
    getCurrentBlockHeight,
    fetchBlockData,
    getTransactionStatusWithReceipts,
    getStopSignal
} from './rpc.js';

// Cache for balance snapshots to avoid redundant RPC calls
const balanceCache = new Map();

// Default fungible token contracts to track
const DEFAULT_TOKENS = [
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1', // USDC
    'wrap.near', // wNEAR
    'usdt.tether-token.near' // USDT
];

/**
 * Clear the balance cache
 */
export function clearBalanceCache() {
    balanceCache.clear();
}

/**
 * Get fungible token balances for account
 * @param {string} accountId
 * @param {number} blockId
 * @param {string[]} tokenContracts - List of token contracts to check
 * @returns {Promise<Object>} Map of token contract to balance
 */
async function getFungibleTokenBalances(accountId, blockId, tokenContracts = []) {
    const balances = {};

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
 * @param {string} accountId
 * @param {number} blockId
 * @returns {Promise<Object>} Map of token to balance
 */
async function getIntentsBalances(accountId, blockId) {
    const balances = {};

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
        const tokenIds = tokens.map(token => typeof token === 'string' ? token : token.token_id);

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
                tokenIds.forEach((tokenId, index) => {
                    balances[tokenId] = batchBalances[index] || '0';
                });
            }
        } catch (e) {
            console.warn(`Could not get balances for intents tokens:`, e.message);
            for (const token of tokens) {
                balances[token] = '0';
            }
        }
    } catch (e) {
        // Account might not have any intents tokens
    }

    return balances;
}

/**
 * Get all balances (NEAR, fungible tokens, intents) for an account at a specific block
 * @param {string} accountId - Account ID
 * @param {number|string} blockId - Block height or 'final'
 * @param {string[]|null|undefined} tokenContracts - Token contracts to check (null = none, undefined = defaults)
 * @param {string[]|null|undefined} intentsTokens - Intents tokens to check (null = none, undefined = auto-detect)
 * @param {boolean} checkNear - Whether to check NEAR balance
 * @returns {Promise<Object>} Balances object
 */
export async function getAllBalances(accountId, blockId, tokenContracts = undefined, intentsTokens = undefined, checkNear = true) {
    const cacheKey = `${accountId}:${blockId}:${JSON.stringify(tokenContracts)}:${JSON.stringify(intentsTokens)}:${checkNear}`;

    if (balanceCache.has(cacheKey)) {
        return balanceCache.get(cacheKey);
    }

    const result = {
        near: '0',
        fungibleTokens: {},
        intentsTokens: {}
    };

    // Get NEAR balance
    if (checkNear) {
        try {
            const account = await viewAccount(accountId, blockId);
            result.near = account?.amount || '0';
        } catch (e) {
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
            const intentsBalances = {};
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
            } catch (e) {
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
 * Detect balance changes between two snapshots
 * @param {Object} startBalance - Start balance snapshot
 * @param {Object} endBalance - End balance snapshot
 * @returns {Object} Changes detected
 */
function detectBalanceChanges(startBalance, endBalance) {
    const changes = {
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
 * @param {string} accountId - Account ID
 * @param {number} firstBlock - Start of search range
 * @param {number} lastBlock - End of search range
 * @param {string[]|null|undefined} tokenContracts - Token contracts to check
 * @param {string[]|null|undefined} intentsTokens - Intents tokens to check
 * @param {boolean} checkNear - Whether to check NEAR balance
 * @returns {Promise<Object>} Balance change info
 */
export async function findLatestBalanceChangingBlock(
    accountId,
    firstBlock,
    lastBlock,
    tokenContracts = undefined,
    intentsTokens = undefined,
    checkNear = true
) {
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
            endBalance
        };
    }

    detectedChanges.startBalance = startBalance;
    detectedChanges.endBalance = endBalance;

    const numBlocks = lastBlock - firstBlock;

    if (numBlocks <= 0) {
        detectedChanges.block = firstBlock;
        return detectedChanges;
    }

    if (numBlocks === 1) {
        detectedChanges.block = lastBlock;
        return detectedChanges;
    }

    const middleBlock = lastBlock - Math.floor(numBlocks / 2);

    // Build list of tokens to check in recursion
    const changedTokens = [];
    if (detectedChanges.tokensChanged) {
        Object.keys(detectedChanges.tokensChanged).forEach(token => {
            if (!changedTokens.includes(token)) {
                changedTokens.push(token);
            }
        });
    }

    const changedIntentsTokens = [];
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
 * Find transaction that caused a balance change
 * @param {string} targetAccountId - The account whose balance changed
 * @param {number} balanceChangeBlock - The block where the balance changed
 * @returns {Promise<Object>} Transaction info
 */
export async function findBalanceChangingTransaction(targetAccountId, balanceChangeBlock) {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    try {
        const blockData = await fetchBlockData(balanceChangeBlock);
        const blockTimestamp = blockData.block?.header?.timestamp;

        const matchingTxHashes = new Set();
        const transactions = [];

        // Check all shards for receipt execution outcomes
        for (const shard of blockData.shards || []) {
            for (const receiptOutcome of shard.receipt_execution_outcomes || []) {
                const receipt = receiptOutcome.receipt;
                const executionOutcome = receiptOutcome.execution_outcome;
                const txHash = receiptOutcome.tx_hash;

                const receiverId = receipt.receiver_id;
                const predecessorId = receipt.predecessor_id;
                const logs = executionOutcome?.outcome?.logs || [];

                let affectsTargetAccount = false;

                if (receiverId === targetAccountId || predecessorId === targetAccountId) {
                    affectsTargetAccount = true;
                }

                // Check receipt logs for EVENT_JSON entries mentioning the account
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

                    for (const txShard of blockData.shards || []) {
                        for (const tx of txShard.chunk?.transactions || []) {
                            if (tx.hash === txHash) {
                                transactions.push(tx);
                                break;
                            }
                        }
                    }
                }
            }
        }

        if (transactions.length > 0 || matchingTxHashes.size > 0) {
            const fetchedTransactions = [];

            for (const shard of blockData.shards || []) {
                for (const receiptOutcome of shard.receipt_execution_outcomes || []) {
                    const txHash = receiptOutcome.tx_hash;
                    const receipt = receiptOutcome.receipt;

                    if (matchingTxHashes.has(txHash) && receipt.receipt?.Action?.signer_id) {
                        const signerId = receipt.receipt.Action.signer_id;

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
                        } catch (error) {
                            console.error(`Error fetching transaction ${txHash}:`, error.message);
                        }
                    }
                }
            }

            return {
                transactions: fetchedTransactions.length > 0 ? fetchedTransactions : transactions,
                transactionHashes: Array.from(matchingTxHashes),
                transactionBlock: balanceChangeBlock,
                receiptBlock: balanceChangeBlock,
                blockTimestamp: blockTimestamp
            };
        }
    } catch (error) {
        console.error(`Error fetching block data:`, error.message);
    }

    return {
        transactions: [],
        transactionHashes: [],
        transactionBlock: null,
        receiptBlock: balanceChangeBlock,
        blockTimestamp: null
    };
}

/**
 * Find latest balance change with expanding search if needed
 * @param {string} accountId - Account ID
 * @param {number} startBlock - Start of search range
 * @param {number} endBlock - End of search range
 * @returns {Promise<Object>} Balance change info
 */
export async function findLatestBalanceChangeWithExpansion(accountId, startBlock, endBlock) {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    const change = await findLatestBalanceChangingBlock(accountId, startBlock, endBlock);

    if (change.hasChanges) {
        change.searchStart = startBlock;
        return change;
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
            expandedChange.searchStart = currentStart;
            return expandedChange;
        }

        expansionCount++;
        currentEnd = currentStart;
    }

    return {
        hasChanges: false,
        block: startBlock
    };
}

/**
 * Get block height estimate at a specific date
 * @param {Date|string} date - Date to estimate block height for
 * @returns {Promise<number>} Estimated block height
 */
export async function getBlockHeightAtDate(date) {
    const targetDate = typeof date === 'string' ? new Date(date) : date;
    const now = new Date();
    const secondsDiff = Math.floor((now - targetDate) / 1000);

    const currentBlock = await getCurrentBlockHeight();
    return Math.max(0, currentBlock - secondsDiff);
}
