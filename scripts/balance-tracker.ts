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
import { sanitizeTransaction } from './transaction-sanitizer.js';

// Types
export interface BalanceSnapshot {
    near: string;
    fungibleTokens: Record<string, string>;
    intentsTokens: Record<string, string>;
    stakingPools?: Record<string, string>;  // Staking pool contract -> total balance (staked + unstaked)
}

export interface BalanceChanges {
    hasChanges: boolean;
    nearChanged: boolean;
    tokensChanged: Record<string, { start: string; end: string; diff: string }>;
    intentsChanged: Record<string, { start: string; end: string; diff: string }>;
    stakingChanged?: Record<string, { start: string; end: string; diff: string }>;
    nearDiff?: string;
    startBalance?: BalanceSnapshot;
    endBalance?: BalanceSnapshot;
    block?: number;
}

/**
 * Transfer detail capturing the counterparty and amount for a balance change
 */
export interface TransferDetail {
    type: 'near' | 'ft' | 'mt' | 'staking_reward' | 'action_receipt_gas_reward';  // NEAR native, Fungible Token, Multi-Token (intents), Staking Reward, Contract Gas Reward
    direction: 'in' | 'out';
    amount: string;
    counterparty: string;  // The other account involved in the transfer (for gas rewards: the caller who triggered the contract execution)
    tokenId?: string;  // For FT: contract address, for MT: token identifier, for staking_reward: pool address
    memo?: string;
    txHash?: string;
    txBlock?: number;         // Block where the transaction was submitted
    receiptId?: string;
    signerId?: string;        // Who signed the transaction
    receiverId?: string;      // The receiver account in the receipt
    predecessorId?: string;   // The predecessor account that initiated this receipt
}

export interface TransactionInfo {
    transactions: any[];
    transactionHashes: string[];
    transactionBlock: number | null;
    receiptBlock: number;
    blockTimestamp: number | null;
    transfers: TransferDetail[];  // Detailed transfer information
}

export interface StakingBalanceChange {
    block: number;
    epochId?: string;
    timestamp?: number;
    pool: string;
    startBalance: string;
    endBalance: string;
    diff: string;
}

/**
 * Per-token balance change record - the core data structure for accounting.
 * Each record represents a single token balance change at a specific block.
 *
 * This is the flat output format described in BALANCE-DISCOVERY-FLOW.md.
 * Benefits:
 * - One row per token change (easy CSV export, SQL, spreadsheets)
 * - No nested objects to parse
 * - Complete context for accounting in one record
 * - Token-agnostic (same format for NEAR, FT, MT, staking)
 */
export interface BalanceChangeRecord {
    // Block context
    block_height: number;
    block_timestamp: string | null;  // ISO 8601 date string, null if unknown

    // Transaction context (where the transaction originated)
    tx_hash: string | null;           // null for synthetic entries (e.g., staking rewards)
    tx_block: number | null;          // Block where tx was submitted (may differ from receipt block)
    signer_id: string | null;         // Who signed the transaction
    receiver_id: string | null;       // The receiver account in the receipt
    predecessor_id: string | null;    // The predecessor account that initiated this receipt

    // Token and transfer data
    token_id: string;                 // "near" | FT contract | "nep141:xxx" for intents | staking pool
    receipt_id: string | null;
    counterparty: string | null;      // Who sent or received the token
    amount: string;                   // Change amount (positive = in, negative = out)
    balance_before: string;           // Token balance before this block
    balance_after: string;            // Token balance after this block
}

// Mainnet epoch length in blocks (roughly 12 hours)
const EPOCH_LENGTH = 43200;

// Contract creation blocks - skip querying contracts before they existed
// For intents.near, we use the block when mt_tokens_for_owner became available
const CONTRACT_CREATION_BLOCKS: Record<string, number> = {
    'intents.near': 148600000,  // mt_tokens_for_owner available from around this block
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': 79039276,  // USDC - Created Nov 22, 2022
    'usdt.tether-token.near': 91079307,  // USDT - estimate, created around March 2023
    'wrap.near': 34550000,  // wNEAR - one of the earliest FTs
};

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
 * Check if a contract existed at a given block height
 */
function contractExistsAtBlock(contractId: string, blockId: number | string): boolean {
    const blockNum = typeof blockId === 'string' ? parseInt(blockId) : blockId;
    const creationBlock = CONTRACT_CREATION_BLOCKS[contractId];
    if (creationBlock && blockNum < creationBlock) {
        return false;
    }
    return true;
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
    const blockNum = typeof blockId === 'string' ? parseInt(blockId) : blockId;

    for (const token of tokenContracts) {
        if (getStopSignal()) {
            throw new Error('Operation cancelled by user');
        }

        // Skip tokens that didn't exist yet at this block
        if (!contractExistsAtBlock(token, blockNum)) {
            balances[token] = '0';
            continue;
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
    const blockNum = typeof blockId === 'string' ? parseInt(blockId) : blockId;

    // Skip if intents.near didn't exist yet at this block
    if (!contractExistsAtBlock('intents.near', blockNum)) {
        return balances;
    }

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
 * Get staking pool balances for account
 * Uses get_account_total_balance which returns the sum of staked and unstaked balance
 * 
 * Note: Staking pool balances change per epoch (roughly every 12 hours) due to rewards,
 * or when there's a deposit/withdrawal. These should be tracked separately from 
 * transaction-based balance changes.
 */
export async function getStakingPoolBalances(
    accountId: string,
    blockId: number | string,
    stakingPools: string[] = []
): Promise<Record<string, string>> {
    const balances: Record<string, string> = {};

    for (const pool of stakingPools) {
        if (getStopSignal()) {
            throw new Error('Operation cancelled by user');
        }

        try {
            const balance = await callViewFunction(
                pool,
                'get_account_total_balance',
                { account_id: accountId },
                blockId
            );
            // Balance is returned as a quoted string like "1000000000000000000000000000"
            balances[pool] = typeof balance === 'string' ? balance.replace(/"/g, '') : String(balance || '0');
        } catch (e) {
            // Pool might not exist at this block or account has no stake
            balances[pool] = '0';
        }
    }

    return balances;
}

/**
 * Find staking balance changes between two blocks by checking at epoch boundaries.
 * Staking rewards accrue per epoch (~12 hours / 43200 blocks), so we only need to
 * check at epoch boundaries rather than every block.
 * 
 * @param accountId - The account to check
 * @param startBlock - Start of the range
 * @param endBlock - End of the range  
 * @param stakingPools - List of staking pool contract IDs to check
 * @returns Array of staking balance changes found at epoch boundaries
 */
export async function findStakingBalanceChanges(
    accountId: string,
    startBlock: number,
    endBlock: number,
    stakingPools: string[]
): Promise<StakingBalanceChange[]> {
    if (stakingPools.length === 0) {
        return [];
    }

    const changes: StakingBalanceChange[] = [];
    
    // Get initial balances
    let prevBalances = await getStakingPoolBalances(accountId, startBlock, stakingPools);
    let prevBlock = startBlock;

    // Calculate the first epoch boundary after startBlock
    // Epoch boundaries occur at blocks that are multiples of EPOCH_LENGTH
    const firstEpochBoundary = Math.ceil(startBlock / EPOCH_LENGTH) * EPOCH_LENGTH;
    
    // Calculate total epochs to check for progress reporting
    const totalEpochs = Math.ceil((endBlock - firstEpochBoundary) / EPOCH_LENGTH) + 1;
    let epochsChecked = 0;

    // Check at each epoch boundary
    for (let block = firstEpochBoundary; block <= endBlock; block += EPOCH_LENGTH) {
        if (getStopSignal()) {
            throw new Error('Operation cancelled by user');
        }
        
        epochsChecked++;
        console.log(`  Checking epoch ${epochsChecked}/${totalEpochs} at block ${block}...`);

        const currentBalances = await getStakingPoolBalances(accountId, block, stakingPools);

        // Check each pool for changes
        for (const pool of stakingPools) {
            const prevBalance = BigInt(prevBalances[pool] || '0');
            const currentBalance = BigInt(currentBalances[pool] || '0');

            if (prevBalance !== currentBalance) {
                changes.push({
                    block,
                    pool,
                    startBalance: prevBalance.toString(),
                    endBalance: currentBalance.toString(),
                    diff: (currentBalance - prevBalance).toString()
                });
            }
        }

        prevBalances = currentBalances;
        prevBlock = block;
    }

    // Check final block if it's not an epoch boundary
    if (endBlock > prevBlock) {
        const finalBalances = await getStakingPoolBalances(accountId, endBlock, stakingPools);

        for (const pool of stakingPools) {
            const prevBalance = BigInt(prevBalances[pool] || '0');
            const finalBalance = BigInt(finalBalances[pool] || '0');

            if (prevBalance !== finalBalance) {
                changes.push({
                    block: endBlock,
                    pool,
                    startBalance: prevBalance.toString(),
                    endBalance: finalBalance.toString(),
                    diff: (finalBalance - prevBalance).toString()
                });
            }
        }
    }

    return changes;
}

/**
 * Get all balances (NEAR, fungible tokens, intents, staking pools) for an account at a specific block
 */
export async function getAllBalances(
    accountId: string,
    blockId: number | string,
    tokenContracts: string[] | null | undefined = undefined,
    intentsTokens: string[] | null | undefined = undefined,
    checkNear = true,
    stakingPools: string[] | null | undefined = undefined
): Promise<BalanceSnapshot> {
    const cacheKey = `${accountId}:${blockId}:${JSON.stringify(tokenContracts)}:${JSON.stringify(intentsTokens)}:${checkNear}:${JSON.stringify(stakingPools)}`;

    if (balanceCache.has(cacheKey)) {
        return balanceCache.get(cacheKey)!;
    }

    const result: BalanceSnapshot = {
        near: '0',
        fungibleTokens: {},
        intentsTokens: {},
        stakingPools: {}
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

    // Get staking pool balances if specified
    if (stakingPools === null) {
        result.stakingPools = {};
    } else if (stakingPools !== undefined && stakingPools.length > 0) {
        result.stakingPools = await getStakingPoolBalances(accountId, blockId, stakingPools);
    } else {
        result.stakingPools = {};
    }

    balanceCache.set(cacheKey, result);
    return result;
}

/**
 * Enrich a balance snapshot with additional FT and intents token balances.
 * 
 * This is used when FT/intents transfers are discovered after the initial balance query.
 * Only queries tokens that aren't already in the snapshot (efficient - no redundant queries).
 * 
 * @param accountId - The account to query balances for
 * @param blockId - Block height to query balances at (can be number or string)
 * @param existingSnapshot - The existing balance snapshot to enrich
 * @param additionalFtContracts - FT contract IDs to add (e.g., ['arizcredits.near'])
 * @param additionalIntentsTokens - Intents token IDs to add (e.g., ['nep141:wrap.near'])
 * @returns Promise<BalanceSnapshot> - Enriched snapshot with merged token balances
 * 
 * @example
 * // After discovering FT transfer of arizcredits.near
 * const enriched = await enrichBalanceSnapshot(
 *   'account.near',
 *   12345678,
 *   existingSnapshot,
 *   ['arizcredits.near'],
 *   []
 * );
 * // enriched.fungibleTokens now includes arizcredits.near balance
 */
export async function enrichBalanceSnapshot(
    accountId: string,
    blockId: number | string,
    existingSnapshot: BalanceSnapshot,
    additionalFtContracts: string[],
    additionalIntentsTokens: string[]
): Promise<BalanceSnapshot> {
    // Filter out tokens already in the snapshot
    const missingFtContracts = additionalFtContracts.filter(
        token => !(token in existingSnapshot.fungibleTokens)
    );
    const missingIntentsTokens = additionalIntentsTokens.filter(
        token => !(token in existingSnapshot.intentsTokens)
    );

    if (missingFtContracts.length === 0 && missingIntentsTokens.length === 0) {
        return existingSnapshot;
    }

    // Query the missing tokens
    const newFtBalances = missingFtContracts.length > 0
        ? await getFungibleTokenBalances(accountId, blockId, missingFtContracts)
        : {};
    
    const newIntentsBalances: Record<string, string> = {};
    if (missingIntentsTokens.length > 0) {
        try {
            if (getStopSignal()) {
                throw new Error('Operation cancelled by user');
            }

            const batchBalances = await callViewFunction(
                'intents.near',
                'mt_batch_balance_of',
                {
                    token_ids: missingIntentsTokens,
                    account_id: accountId
                },
                blockId
            );

            if (batchBalances && Array.isArray(batchBalances)) {
                missingIntentsTokens.forEach((token, index) => {
                    newIntentsBalances[token] = batchBalances[index] || '0';
                });
            }
        } catch (e: any) {
            console.warn(`Could not get batch balances for intents tokens:`, e.message);
            for (const token of missingIntentsTokens) {
                newIntentsBalances[token] = '0';
            }
        }
    }

    // Return enriched snapshot
    return {
        near: existingSnapshot.near,
        fungibleTokens: { ...existingSnapshot.fungibleTokens, ...newFtBalances },
        intentsTokens: { ...existingSnapshot.intentsTokens, ...newIntentsBalances },
        stakingPools: existingSnapshot.stakingPools || {}
    };
}

/**
 * Get balance changes at a specific block by comparing block-1 to block.
 *
 * IMPORTANT: FT and MT token balances update at block N+1, not block N.
 * NEAR balances update at block N.
 *
 * To handle this correctly:
 * - NEAR: queries at block N-1 and N
 * - FT/MT: queries at block N and N+1
 *
 * This is more efficient than binary search when we already know the block.
 */
export async function getBalanceChangesAtBlock(
    accountId: string,
    blockHeight: number,
    tokenContracts: string[] | null | undefined = undefined,
    intentsTokens: string[] | null | undefined = undefined,
    stakingPools: string[] | null | undefined = undefined
): Promise<BalanceChanges> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    // Get NEAR balance at block-1 and block (NEAR updates at block N)
    const nearBalanceBefore = await getAllBalances(accountId, blockHeight - 1, null, null, true, null);
    const nearBalanceAfter = await getAllBalances(accountId, blockHeight, null, null, true, null);

    // Get FT/MT balances at block and block+1 (FT/MT update at block N+1)
    const ftMtBalanceBefore = tokenContracts || intentsTokens
        ? await getAllBalances(accountId, blockHeight, tokenContracts, intentsTokens, false, stakingPools)
        : { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: {} };

    const ftMtBalanceAfter = tokenContracts || intentsTokens
        ? await getAllBalances(accountId, blockHeight + 1, tokenContracts, intentsTokens, false, stakingPools)
        : { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: {} };

    // Merge NEAR with FT/MT balances
    const balanceBeforeRaw: BalanceSnapshot = {
        near: nearBalanceBefore.near,
        fungibleTokens: ftMtBalanceBefore.fungibleTokens,
        intentsTokens: ftMtBalanceBefore.intentsTokens,
        stakingPools: ftMtBalanceBefore.stakingPools || {}
    };

    const balanceAfterRaw: BalanceSnapshot = {
        near: nearBalanceAfter.near,
        fungibleTokens: ftMtBalanceAfter.fungibleTokens,
        intentsTokens: ftMtBalanceAfter.intentsTokens,
        stakingPools: ftMtBalanceAfter.stakingPools || {}
    };

    // Normalize snapshots to ensure both have the same token keys
    const { before: balanceBefore, after: balanceAfter } = normalizeBalanceSnapshots(
        balanceBeforeRaw,
        balanceAfterRaw
    );

    const changes = detectBalanceChanges(balanceBefore, balanceAfter);
    changes.block = blockHeight;
    changes.startBalance = balanceBefore;
    changes.endBalance = balanceAfter;

    return changes;
}

/**
 * Detect balance changes between two snapshots
 */
export function detectBalanceChanges(
    startBalance: BalanceSnapshot,
    endBalance: BalanceSnapshot
): BalanceChanges {
    const changes: BalanceChanges = {
        hasChanges: false,
        nearChanged: false,
        tokensChanged: {},
        intentsChanged: {},
        stakingChanged: {}
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

    // Check staking pools
    const allStakingPools = new Set([
        ...Object.keys(startBalance.stakingPools || {}),
        ...Object.keys(endBalance.stakingPools || {})
    ]);

    for (const pool of allStakingPools) {
        const startAmount = BigInt(startBalance.stakingPools?.[pool] || '0');
        const endAmount = BigInt(endBalance.stakingPools?.[pool] || '0');
        if (startAmount !== endAmount) {
            changes.hasChanges = true;
            if (!changes.stakingChanged) {
                changes.stakingChanged = {};
            }
            changes.stakingChanged[pool] = {
                start: startAmount.toString(),
                end: endAmount.toString(),
                diff: (endAmount - startAmount).toString()
            };
        }
    }

    return changes;
}

/**
 * Normalize two balance snapshots to ensure they contain the same token keys.
 *
 * When tokens are auto-discovered at different blocks, balanceBefore and balanceAfter
 * may contain different token sets. This function unifies them by:
 * - Collecting all token keys from both snapshots
 * - Filling in '0' for any tokens missing from either snapshot
 *
 * This makes it easier to compare before/after states and ensures consistent output.
 *
 * @param before - The balance snapshot before the transaction
 * @param after - The balance snapshot after the transaction
 * @returns Object containing normalized before and after snapshots
 *
 * @example
 * const { before, after } = normalizeBalanceSnapshots(
 *   { near: '100', fungibleTokens: { 'a': '10' }, intentsTokens: {}, stakingPools: {} },
 *   { near: '90', fungibleTokens: { 'b': '20' }, intentsTokens: {}, stakingPools: {} }
 * );
 * // before.fungibleTokens = { 'a': '10', 'b': '0' }
 * // after.fungibleTokens = { 'a': '0', 'b': '20' }
 */
export function normalizeBalanceSnapshots(
    before: BalanceSnapshot,
    after: BalanceSnapshot
): { before: BalanceSnapshot; after: BalanceSnapshot } {
    // Collect all token keys from both snapshots
    const allFungibleTokens = new Set([
        ...Object.keys(before.fungibleTokens || {}),
        ...Object.keys(after.fungibleTokens || {})
    ]);

    const allIntentsTokens = new Set([
        ...Object.keys(before.intentsTokens || {}),
        ...Object.keys(after.intentsTokens || {})
    ]);

    const allStakingPools = new Set([
        ...Object.keys(before.stakingPools || {}),
        ...Object.keys(after.stakingPools || {})
    ]);

    // Create normalized fungibleTokens
    const normalizedBeforeFt: Record<string, string> = {};
    const normalizedAfterFt: Record<string, string> = {};
    for (const token of allFungibleTokens) {
        normalizedBeforeFt[token] = before.fungibleTokens?.[token] || '0';
        normalizedAfterFt[token] = after.fungibleTokens?.[token] || '0';
    }

    // Create normalized intentsTokens
    const normalizedBeforeIntents: Record<string, string> = {};
    const normalizedAfterIntents: Record<string, string> = {};
    for (const token of allIntentsTokens) {
        normalizedBeforeIntents[token] = before.intentsTokens?.[token] || '0';
        normalizedAfterIntents[token] = after.intentsTokens?.[token] || '0';
    }

    // Create normalized stakingPools
    const normalizedBeforeStaking: Record<string, string> = {};
    const normalizedAfterStaking: Record<string, string> = {};
    for (const pool of allStakingPools) {
        normalizedBeforeStaking[pool] = before.stakingPools?.[pool] || '0';
        normalizedAfterStaking[pool] = after.stakingPools?.[pool] || '0';
    }

    return {
        before: {
            near: before.near,
            fungibleTokens: normalizedBeforeFt,
            intentsTokens: normalizedBeforeIntents,
            stakingPools: normalizedBeforeStaking
        },
        after: {
            near: after.near,
            fungibleTokens: normalizedAfterFt,
            intentsTokens: normalizedAfterIntents,
            stakingPools: normalizedAfterStaking
        }
    };
}

/**
 * Create flat BalanceChangeRecords from balance changes at a block.
 * This converts the nested TransactionEntry format to per-token flat records.
 *
 * @param blockHeight - The block where changes occurred
 * @param blockTimestamp - Block timestamp in nanoseconds (NEAR format) or null
 * @param changes - The BalanceChanges object with detected changes
 * @param transfers - Optional transfer details for counterparty/tx info
 * @param txHashes - Transaction hashes for this block
 * @returns Array of flat BalanceChangeRecord objects (one per changed token)
 */
export function createBalanceChangeRecords(
    blockHeight: number,
    blockTimestamp: number | null,
    changes: BalanceChanges,
    transfers?: TransferDetail[],
    txHashes?: string[]
): BalanceChangeRecord[] {
    const records: BalanceChangeRecord[] = [];

    // Format timestamp to ISO 8601
    const timestampStr = blockTimestamp
        ? new Date(Math.floor(blockTimestamp / 1_000_000)).toISOString()
        : null;

    // Helper to find matching transfer
    const findTransfer = (tokenId: string, type: 'near' | 'ft' | 'mt' | 'staking_reward'): TransferDetail | undefined => {
        if (!transfers) return undefined;
        return transfers.find(t => {
            if (type === 'near') return t.type === 'near' || t.type === 'action_receipt_gas_reward';
            if (type === 'ft') return t.type === 'ft' && t.tokenId === tokenId;
            if (type === 'mt') return t.type === 'mt' && t.tokenId === tokenId;
            if (type === 'staking_reward') return t.type === 'staking_reward' && t.tokenId === tokenId;
            return false;
        });
    };

    // Process NEAR changes
    if (changes.nearChanged && changes.nearDiff) {
        const transfer = findTransfer('near', 'near');
        const balanceBefore = changes.startBalance?.near || '0';
        const balanceAfter = changes.endBalance?.near || '0';

        records.push({
            block_height: blockHeight,
            block_timestamp: timestampStr,
            tx_hash: transfer?.txHash || txHashes?.[0] || null,
            tx_block: transfer?.txBlock || null,
            signer_id: transfer?.signerId || null,
            receiver_id: transfer?.receiverId || null,
            predecessor_id: transfer?.predecessorId || null,
            token_id: 'near',
            receipt_id: transfer?.receiptId || null,
            counterparty: transfer?.counterparty || null,
            amount: changes.nearDiff,
            balance_before: balanceBefore,
            balance_after: balanceAfter
        });
    }

    // Process fungible token changes
    for (const [tokenId, change] of Object.entries(changes.tokensChanged)) {
        const transfer = findTransfer(tokenId, 'ft');

        records.push({
            block_height: blockHeight,
            block_timestamp: timestampStr,
            tx_hash: transfer?.txHash || txHashes?.[0] || null,
            tx_block: transfer?.txBlock || null,
            signer_id: transfer?.signerId || null,
            receiver_id: transfer?.receiverId || null,
            predecessor_id: transfer?.predecessorId || null,
            token_id: tokenId,
            receipt_id: transfer?.receiptId || null,
            counterparty: transfer?.counterparty || null,
            amount: change.diff,
            balance_before: change.start,
            balance_after: change.end
        });
    }

    // Process intents token changes
    for (const [tokenId, change] of Object.entries(changes.intentsChanged)) {
        const transfer = findTransfer(tokenId, 'mt');

        records.push({
            block_height: blockHeight,
            block_timestamp: timestampStr,
            tx_hash: transfer?.txHash || txHashes?.[0] || null,
            tx_block: transfer?.txBlock || null,
            signer_id: transfer?.signerId || null,
            receiver_id: transfer?.receiverId || null,
            predecessor_id: transfer?.predecessorId || null,
            token_id: tokenId,
            receipt_id: transfer?.receiptId || null,
            counterparty: transfer?.counterparty || null,
            amount: change.diff,
            balance_before: change.start,
            balance_after: change.end
        });
    }

    // Process staking pool changes
    if (changes.stakingChanged) {
        for (const [poolId, change] of Object.entries(changes.stakingChanged)) {
            const transfer = findTransfer(poolId, 'staking_reward');

            records.push({
                block_height: blockHeight,
                block_timestamp: timestampStr,
                tx_hash: transfer?.txHash || null,
                tx_block: transfer?.txBlock || null,
                signer_id: transfer?.signerId || null,
                receiver_id: transfer?.receiverId || null,
                predecessor_id: transfer?.predecessorId || null,
                token_id: poolId,
                receipt_id: transfer?.receiptId || null,
                counterparty: transfer?.counterparty || poolId,  // Pool is the counterparty for staking
                amount: change.diff,
                balance_before: change.start,
                balance_after: change.end
            });
        }
    }

    return records;
}

/**
 * Gap information for a specific token between two consecutive records.
 */
export interface TokenGap {
    token_id: string;
    from_block: number;
    to_block: number;
    expected_balance: string;  // balance_after from previous record
    actual_balance: string;    // balance_before from next record
    diff: string;              // actual - expected
}

/**
 * Detect gaps in per-token balance change records.
 * For each token, checks if consecutive records have matching balances:
 * record[N].balance_after should equal record[N+1].balance_before
 *
 * @param records - Array of BalanceChangeRecord objects (can be for multiple tokens)
 * @returns Array of TokenGap objects representing detected gaps
 */
export function detectTokenGaps(records: BalanceChangeRecord[]): TokenGap[] {
    const gaps: TokenGap[] = [];

    // Group records by token_id
    const recordsByToken = new Map<string, BalanceChangeRecord[]>();
    for (const record of records) {
        const tokenRecords = recordsByToken.get(record.token_id) || [];
        tokenRecords.push(record);
        recordsByToken.set(record.token_id, tokenRecords);
    }

    // For each token, check consecutive records
    for (const [tokenId, tokenRecords] of recordsByToken) {
        // Sort by block height
        const sorted = [...tokenRecords].sort((a, b) => a.block_height - b.block_height);

        // Check consecutive pairs
        for (let i = 0; i < sorted.length - 1; i++) {
            const current = sorted[i]!;
            const next = sorted[i + 1]!;

            // Check if balance_after matches next balance_before
            if (current.balance_after !== next.balance_before) {
                const expected = BigInt(current.balance_after);
                const actual = BigInt(next.balance_before);
                const diff = actual - expected;

                gaps.push({
                    token_id: tokenId,
                    from_block: current.block_height,
                    to_block: next.block_height,
                    expected_balance: current.balance_after,
                    actual_balance: next.balance_before,
                    diff: diff.toString()
                });
            }
        }
    }

    return gaps;
}

/**
 * Get all unique token IDs from balance change records.
 */
export function getUniqueTokenIds(records: BalanceChangeRecord[]): string[] {
    return [...new Set(records.map(r => r.token_id))];
}

/**
 * Filter balance change records by token ID.
 */
export function filterRecordsByToken(records: BalanceChangeRecord[], tokenId: string): BalanceChangeRecord[] {
    return records.filter(r => r.token_id === tokenId);
}

/**
 * Get the latest record for each token.
 */
export function getLatestRecordPerToken(records: BalanceChangeRecord[]): Map<string, BalanceChangeRecord> {
    const latest = new Map<string, BalanceChangeRecord>();

    for (const record of records) {
        const existing = latest.get(record.token_id);
        if (!existing || record.block_height > existing.block_height) {
            latest.set(record.token_id, record);
        }
    }

    return latest;
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
    checkNear = true,
    depth = 0
): Promise<BalanceChanges> {
    if (getStopSignal()) {
        throw new Error('Operation cancelled by user');
    }

    // Show progress during binary search
    const rangeSize = lastBlock - firstBlock;
    if (depth === 0 || rangeSize > 100000) {
        process.stdout.write(`\r  Binary search: blocks ${firstBlock.toLocaleString()} - ${lastBlock.toLocaleString()} (range: ${rangeSize.toLocaleString()})   `);
    }

    // Note: stakingPools not included in binary search - staking rewards are tracked at epoch boundaries
    const startBalance = await getAllBalances(accountId, firstBlock, tokenContracts, intentsTokens, checkNear);
    const endBalance = await getAllBalances(accountId, lastBlock, tokenContracts, intentsTokens, checkNear);

    const detectedChanges = detectBalanceChanges(startBalance, endBalance);

    if (!detectedChanges.hasChanges) {
        if (depth === 0) console.log(''); // New line after progress
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
        const completeStartBalance = await getAllBalances(accountId, firstBlock - 1, tokenContracts, intentsTokens, checkNear);
        const completeEndBalance = await getAllBalances(accountId, firstBlock, tokenContracts, intentsTokens, checkNear);
        const completeChanges = detectBalanceChanges(completeStartBalance, completeEndBalance);
        completeChanges.block = firstBlock;
        completeChanges.startBalance = completeStartBalance;
        completeChanges.endBalance = completeEndBalance;
        return completeChanges;
    }

    if (numBlocks === 1) {
        // Re-fetch complete balances to ensure we have full snapshot
        const completeStartBalance = await getAllBalances(accountId, lastBlock - 1, tokenContracts, intentsTokens, checkNear);
        const completeEndBalance = await getAllBalances(accountId, lastBlock, tokenContracts, intentsTokens, checkNear);
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
        detectedChanges.nearChanged,
        depth + 1
    );

    if (lastHalfChanges.hasChanges) {
        if (depth === 0) console.log(''); // New line after progress
        return lastHalfChanges;
    } else {
        return await findLatestBalanceChangingBlock(
            accountId,
            firstBlock,
            middleBlock,
            changedTokens.length > 0 ? changedTokens : null,
            changedIntentsTokens.length > 0 ? changedIntentsTokens : null,
            detectedChanges.nearChanged,
            depth + 1
        );
    }
}

/**
 * Receipt context for transfer detail enrichment
 */
interface ReceiptContext {
    txHash: string;
    receiptId: string;
    receiverId: string;
    predecessorId: string;
}

/**
 * Parse NEP-141 FT transfer events from logs
 * Supports both EVENT_JSON (NEP-141 standard) and plain text logs (wrap.near style)
 */
function parseFtTransferEvents(
    logs: string[],
    targetAccountId: string,
    contractId: string,
    ctx: ReceiptContext
): TransferDetail[] {
    const transfers: TransferDetail[] = [];

    for (const log of logs) {
        // Try EVENT_JSON format (NEP-141 standard)
        if (log.startsWith('EVENT_JSON:')) {
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
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
                            });
                        } else if (newOwner === targetAccountId) {
                            transfers.push({
                                type: 'ft',
                                direction: 'in',
                                amount,
                                counterparty: oldOwner,
                                tokenId: contractId,
                                memo,
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
                            });
                        }
                    }
                }
            } catch (e) {
                // Skip invalid JSON
            }
        }
        // Try plain text format (wrap.near style): "Transfer X from Y to Z"
        else if (log.includes(targetAccountId)) {
            const plainTransferMatch = log.match(/^Transfer (\d+) from ([^\s]+) to ([^\s]+)$/);
            if (plainTransferMatch) {
                const amount = plainTransferMatch[1]!;
                const fromAccount = plainTransferMatch[2]!;
                const toAccount = plainTransferMatch[3]!;

                if (toAccount === targetAccountId) {
                    transfers.push({
                        type: 'ft',
                        direction: 'in',
                        amount,
                        counterparty: fromAccount,
                        tokenId: contractId,
                        txHash: ctx.txHash,
                        receiptId: ctx.receiptId,
                        receiverId: ctx.receiverId,
                        predecessorId: ctx.predecessorId
                    });
                } else if (fromAccount === targetAccountId) {
                    transfers.push({
                        type: 'ft',
                        direction: 'out',
                        amount,
                        counterparty: toAccount,
                        tokenId: contractId,
                        txHash: ctx.txHash,
                        receiptId: ctx.receiptId,
                        receiverId: ctx.receiverId,
                        predecessorId: ctx.predecessorId
                    });
                }
            }
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
    ctx: ReceiptContext
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
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
                            });
                        } else if (newOwner === targetAccountId) {
                            transfers.push({
                                type: 'mt',
                                direction: 'in',
                                amount,
                                counterparty: oldOwner,
                                tokenId,
                                memo,
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
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
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
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
                                txHash: ctx.txHash,
                                receiptId: ctx.receiptId,
                                receiverId: ctx.receiverId,
                                predecessorId: ctx.predecessorId
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
 * Helper to process receipts from a block and extract transfers
 */
function processBlockReceipts(
    neardataBlock: NeardataBlockResponse,
    targetAccountId: string,
    transfers: TransferDetail[],
    matchingTxHashes: Set<string>,
    processedReceipts: Set<string>,
    balanceBefore?: bigint
): void {
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

            // Create receipt context for passing to parse functions
            const ctx: ReceiptContext = {
                txHash,
                receiptId,
                receiverId: receiverId || '',
                predecessorId: predecessorId || ''
            };

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
                                    receiptId,
                                    receiverId: ctx.receiverId,
                                    predecessorId: ctx.predecessorId
                                });
                            } else if (receiverId === targetAccountId) {
                                transfers.push({
                                    type: 'near',
                                    direction: 'in',
                                    amount: String(amountBigInt),
                                    counterparty: predecessorId,
                                    memo,
                                    txHash,
                                    receiptId,
                                    receiverId: ctx.receiverId,
                                    predecessorId: ctx.predecessorId
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
                const ftTransfers = parseFtTransferEvents(logs, targetAccountId, receiverId, ctx);
                if (ftTransfers.length > 0) {
                    transfers.push(...ftTransfers);
                    affectsTargetAccount = true;
                }

                // Parse MT (intents) transfer events from logs
                const mtTransfers = parseMtTransferEvents(logs, targetAccountId, receiverId, ctx);
                if (mtTransfers.length > 0) {
                    transfers.push(...mtTransfers);
                    affectsTargetAccount = true;
                }

                processedReceipts.add(receiptId);
            }

            // Check receipt logs for EVENT_JSON entries mentioning the account (fallback)
            // Also check plain text logs like wrap.near uses: "Transfer X from Y to Z"
            if (!affectsTargetAccount) {
                for (const log of logs) {
                    if (log.startsWith('EVENT_JSON:')) {
                        try {
                            const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
                            const eventStr = JSON.stringify(eventData);
                            if (eventStr.includes(targetAccountId)) {
                                affectsTargetAccount = true;
                                // Parse FT transfers from this receipt
                                const ftTransfers = parseFtTransferEvents(logs, targetAccountId, receiverId, ctx);
                                if (ftTransfers.length > 0) {
                                    transfers.push(...ftTransfers);
                                }
                                break;
                            }
                        } catch (e) {
                            // Skip invalid JSON
                        }
                    }
                    // Check for plain text transfer logs (wrap.near style)
                    // Format: "Transfer X from Y to Z"
                    else if (log.includes(targetAccountId)) {
                        const plainTransferMatch = log.match(/^Transfer (\d+) from ([^\s]+) to ([^\s]+)$/);
                        if (plainTransferMatch) {
                            const amount = plainTransferMatch[1];
                            const fromAccount = plainTransferMatch[2];
                            const toAccount = plainTransferMatch[3];

                            if (toAccount === targetAccountId) {
                                transfers.push({
                                    type: 'ft',
                                    direction: 'in',
                                    amount: amount!,
                                    counterparty: fromAccount!,
                                    tokenId: receiverId, // The FT contract
                                    txHash,
                                    receiptId,
                                    receiverId: ctx.receiverId,
                                    predecessorId: ctx.predecessorId
                                });
                                affectsTargetAccount = true;
                            } else if (fromAccount === targetAccountId) {
                                transfers.push({
                                    type: 'ft',
                                    direction: 'out',
                                    amount: amount!,
                                    counterparty: toAccount!,
                                    tokenId: receiverId, // The FT contract
                                    txHash,
                                    receiptId,
                                    receiverId: ctx.receiverId,
                                    predecessorId: ctx.predecessorId
                                });
                                affectsTargetAccount = true;
                            }
                        }
                    }
                }
            }

            if (affectsTargetAccount && txHash && !matchingTxHashes.has(txHash)) {
                matchingTxHashes.add(txHash);
            }
        }
        
        // Process state_changes to find action_receipt_gas_reward for the target account
        for (const stateChange of shard.state_changes || []) {
            if (stateChange.type === 'account_update' && 
                stateChange.cause?.type === 'action_receipt_gas_reward' &&
                stateChange.change?.account_id === targetAccountId) {
                
                const receiptHash = stateChange.cause.receipt_hash;
                
                // Find the receipt that caused this gas reward to get the caller (predecessor)
                let caller = 'unknown';
                let txHash: string | undefined;
                
                for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                    if (receiptExecution.receipt?.receipt_id === receiptHash) {
                        caller = receiptExecution.receipt.predecessor_id;
                        txHash = receiptExecution.tx_hash;
                        break;
                    }
                }
                
                // Calculate the gas reward amount by finding the previous account state
                // First try to find the receipt_processing state change for the same receipt
                let previousAmount: bigint | null = null;
                for (const prevChange of shard.state_changes || []) {
                    if (prevChange.type === 'account_update' &&
                        prevChange.cause?.type === 'receipt_processing' &&
                        prevChange.cause?.receipt_hash === receiptHash &&
                        prevChange.change?.account_id === targetAccountId) {
                        previousAmount = BigInt(prevChange.change.amount);
                        break;
                    }
                }
                
                // If no receipt_processing found, try to find the most recent account state change
                // in this block before the gas reward (any cause type)
                if (previousAmount === null) {
                    // Collect all state changes for this account, in order
                    const accountChanges: Array<{amount: bigint, cause: string, receiptHash?: string}> = [];
                    for (const sc of shard.state_changes || []) {
                        if (sc.type === 'account_update' && sc.change?.account_id === targetAccountId) {
                            accountChanges.push({
                                amount: BigInt(sc.change.amount),
                                cause: sc.cause?.type || 'unknown',
                                receiptHash: sc.cause?.receipt_hash
                            });
                        }
                    }
                    
                    // Find the index of our gas reward change and use the previous one
                    for (let i = 0; i < accountChanges.length; i++) {
                        const change = accountChanges[i];
                        if (change && change.cause === 'action_receipt_gas_reward' && 
                            change.receiptHash === receiptHash) {
                            const prevChange = accountChanges[i - 1];
                            if (i > 0 && prevChange) {
                                previousAmount = prevChange.amount;
                            }
                            break;
                        }
                    }
                }
                
                // If still no previous amount found, use the balanceBefore parameter
                if (previousAmount === null && balanceBefore !== undefined) {
                    previousAmount = balanceBefore;
                }
                
                if (previousAmount !== null) {
                    const newAmount = BigInt(stateChange.change.amount);
                    const gasRewardAmount = newAmount - previousAmount;

                    if (gasRewardAmount > 0n) {
                        transfers.push({
                            type: 'action_receipt_gas_reward',
                            direction: 'in',
                            amount: gasRewardAmount.toString(),
                            counterparty: caller,
                            memo: 'contract gas reward (30% of gas burnt)',
                            txHash,
                            receiptId: receiptHash,
                            receiverId: targetAccountId,  // Gas reward goes to the target account
                            predecessorId: caller  // The caller triggered the gas reward
                        });

                        if (txHash && !matchingTxHashes.has(txHash)) {
                            matchingTxHashes.add(txHash);
                        }
                    }
                }
            }
        }
    }
}

/**
 * Find transaction that caused a balance change
 * Uses neardata.xyz API to get complete block data with execution outcomes and logs
 * Also checks subsequent blocks for cross-contract call receipts
 * @param balanceBefore - Optional NEAR balance before this block (used for gas reward calculation when no receipt_processing state change exists)
 */
export async function findBalanceChangingTransaction(
    targetAccountId: string,
    balanceChangeBlock: number,
    balanceBefore?: bigint
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

            // Process the main block
            processBlockReceipts(neardataBlock, targetAccountId, transfers, matchingTxHashes, processedReceipts, balanceBefore);

            // Also check subsequent blocks for cross-contract call receipts.
            // This is needed because NEAR deducts the deposit from sender's balance when
            // the OUTGOING receipt is CREATED, not when it EXECUTES on the receiver.
            // 
            // Example: DAO staking via act_proposal
            // - Block N: act_proposal executes, creates receipt to staking pool with deposit
            //   Sender's balance is immediately reduced by the deposit amount
            // - Block N+1: deposit_and_stake receipt executes on staking pool
            //   The receipt with deposit details (counterparty, amount, method) is here
            //
            // Example 2: Intents withdrawal creating FT transfer
            // - Block N: act_proposal executes, starts withdrawal from intents.near
            //   Creates receipt chain that eventually results in FT transfer to target
            // - Block N+4: FT contract (wrap.near) executes ft_transfer to target
            //   The FT transfer receipt (with logs) that credits the target is here
            //
            // So when we detect a balance change at block N, we need to check subsequent
            // blocks (N+1, N+2, ...) to find the receipts that show where the funds went
            // or came from.
            // 
            // We always check subsequent blocks because:
            // - Gas rewards don't explain the full balance change (e.g., staking deposits)
            // - Cross-contract FT transfers (e.g., wrap.near via intents) execute later
            // - Multiple receipt chains can execute across several blocks
            const MAX_SUBSEQUENT_BLOCKS = 5;
            for (let i = 1; i <= MAX_SUBSEQUENT_BLOCKS; i++) {
                const subsequentBlock = await fetchNeardataBlock(balanceChangeBlock + i);
                if (subsequentBlock) {
                    processBlockReceipts(subsequentBlock, targetAccountId, transfers, matchingTxHashes, processedReceipts);
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
                                    const txData = {
                                        hash: txHash,
                                        signerId: txInfo.signer_id,
                                        receiverId: txInfo.receiver_id,
                                        actions: txInfo.actions || []
                                    };
                                    // Sanitize transaction to remove large binary payloads
                                    fetchedTransactions.push(sanitizeTransaction(txData));
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

        // With standard RPC, we need to:
        // 1. Find transactions in chunks that involve the target account
        // 2. Use tx RPC to get full transaction details with receipts
        const matchingTxHashes = new Set<string>();
        const fetchedTransactions: any[] = [];

        for (const chunk of blockData.chunks || []) {
            // Check transactions in this chunk
            for (const tx of (chunk as any).transactions || []) {
                const txStr = JSON.stringify(tx);
                if (txStr.includes(targetAccountId)) {
                    const txHash = tx.hash;
                    const signerId = tx.signer_id;
                    
                    if (txHash && signerId && !matchingTxHashes.has(txHash)) {
                        matchingTxHashes.add(txHash);
                        
                        try {
                            // Get full transaction status with receipts
                            const txResult = await getTransactionStatusWithReceipts(txHash, signerId);
                            
                            if (txResult?.transaction) {
                                const txData = {
                                    hash: txHash,
                                    signerId: txResult.transaction.signer_id,
                                    receiverId: txResult.transaction.receiver_id,
                                    actions: txResult.transaction.actions || []
                                };
                                // Sanitize transaction to remove large binary payloads
                                fetchedTransactions.push(sanitizeTransaction(txData));
                                
                                // Extract transfers from receipts_outcome
                                for (const receiptOutcome of txResult.receipts_outcome || []) {
                                    const outcome = receiptOutcome.outcome;
                                    const receiptId = receiptOutcome.id;
                                    const logs = outcome?.logs || [];

                                    // Parse logs for FT transfers using existing function
                                    // We need to determine the contract ID from the receipt
                                    // For now, we'll extract it from receipt executor_id if available
                                    const contractId = (receiptOutcome as any).executor_id || '';
                                    const receiptCtx: ReceiptContext = {
                                        txHash,
                                        receiptId,
                                        receiverId: contractId,
                                        predecessorId: ''
                                    };
                                    const ftTransfers = parseFtTransferEvents(logs, targetAccountId, contractId, receiptCtx);
                                    transfers.push(...ftTransfers);
                                }
                            }
                        } catch (txError: any) {
                            console.warn(`Could not fetch transaction ${txHash}: ${txError.message}`);
                        }
                    }
                }
            }
            
            // Also check receipts for incoming transfers
            for (const receipt of (chunk as any).receipts || []) {
                const receiptStr = JSON.stringify(receipt);
                if (receiptStr.includes(targetAccountId)) {
                    // Try to get the predecessor (origin tx hash is not directly available in receipt)
                    const predecessorId = receipt.predecessor_id;
                    const receiverId = receipt.receiver_id;

                    // Check for Transfer action
                    const actions = receipt.receipt?.Action?.actions || [];
                    for (const action of actions) {
                        if (action.Transfer) {
                            const deposit = action.Transfer.deposit;
                            if (deposit && BigInt(deposit) > 0n) {
                                const direction = receiverId === targetAccountId ? 'in' : 'out';
                                const counterparty = direction === 'in' ? predecessorId : receiverId;

                                transfers.push({
                                    type: 'near',
                                    direction,
                                    amount: deposit,
                                    counterparty: counterparty || 'unknown',
                                    receiptId: receipt.receipt_id,
                                    receiverId: receiverId || '',
                                    predecessorId: predecessorId || ''
                                });
                            }
                        }

                        // Check for FunctionCall with deposit
                        if (action.FunctionCall) {
                            const deposit = action.FunctionCall.deposit;
                            if (deposit && BigInt(deposit) > 0n) {
                                const direction = receiverId === targetAccountId ? 'in' : 'out';
                                const counterparty = direction === 'in' ? predecessorId : receiverId;

                                transfers.push({
                                    type: 'near',
                                    direction,
                                    amount: deposit,
                                    counterparty: counterparty || 'unknown',
                                    receiptId: receipt.receipt_id,
                                    receiverId: receiverId || '',
                                    predecessorId: predecessorId || ''
                                });
                            }
                        }
                    }
                }
            }
        }

        return {
            transactions: fetchedTransactions,
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
