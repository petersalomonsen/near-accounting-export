#!/usr/bin/env node
// Main script for getting NEAR account accounting history
// Saves history to a JSON file and supports continuing from existing data

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

import {
    getCurrentBlockHeight,
    setStopSignal,
    getStopSignal,
    fetchNeardataBlock,
    fetchBlockData,
    getBlockTimestamp
} from './rpc.js';
import {
    findLatestBalanceChangingBlock,
    findBalanceChangingTransaction,
    clearBalanceCache,
    getBalanceChangesAtBlock,
    accountExistsAtBlock,
    getStakingPoolBalances,
    findStakingBalanceChanges,
    getAllBalances,
    enrichBalanceSnapshot,
    detectBalanceChanges
} from './balance-tracker.js';
import {
    getAllTransactionBlocks,
    isNearBlocksAvailable
} from './nearblocks-api.js';
import {
    getAllIntentsTransactionBlocks,
    isIntentsExplorerAvailable
} from './intents-explorer-api.js';
import {
    getAllPikespeakTransactionBlocks,
    isPikespeakAvailable
} from './pikespeak-api.js';
import {
    detectGaps,
    type Gap,
    type GapAnalysis
} from './gap-detection.js';
import type { BalanceSnapshot, BalanceChanges, TransactionInfo, TransferDetail, StakingBalanceChange } from './balance-tracker.js';
import type { TransactionBlock } from './nearblocks-api.js';
import type { IntentsTransactionBlock } from './intents-explorer-api.js';
import type { PikespeakTransactionBlock } from './pikespeak-api.js';

// Types
interface VerificationError {
    type: string;
    token?: string;
    expected: string;
    actual: string;
    message: string;
}

interface VerificationResult {
    valid: boolean;
    errors: VerificationError[];
}

export interface TransactionEntry {
    block: number;
    transactionBlock?: number | null;  // Block where transaction was submitted (may be null for synthetic entries or older data)
    timestamp: number | null;
    transactionHashes: string[];
    transactions: any[];
    transfers?: TransferDetail[];  // Detailed transfer information with counterparties
    balanceBefore?: BalanceSnapshot;
    balanceAfter?: BalanceSnapshot;
    changes: {
        nearChanged: boolean;
        nearDiff?: string;
        tokensChanged: Record<string, { start: string; end: string; diff: string }>;
        intentsChanged: Record<string, { start: string; end: string; diff: string }>;
        stakingChanged?: Record<string, { start: string; end: string; diff: string }>;
    };
    // verificationWithNext removed - gap detection is computed on-demand using gap-detection module
}

interface AccountHistory {
    accountId: string;
    createdAt: string;
    updatedAt: string;
    transactions: TransactionEntry[];
    stakingPools?: string[];  // Discovered staking pool contracts
    metadata: {
        firstBlock: number | null;
        lastBlock: number | null;
        totalTransactions: number;
        historyComplete?: boolean;  // True when backward search found the beginning of account history
    };
}

// Re-export the type for external use
export type { AccountHistory };

interface GetAccountHistoryOptions {
    accountId: string;
    outputFile: string;
    direction?: 'forward' | 'backward';
    maxTransactions?: number;
    startBlock?: number;
    endBlock?: number;
    stakingOnly?: boolean;
    maxEpochsToCheck?: number;  // Max staking epochs to check per call (for incremental sync)
}

interface ParsedArgs {
    accountId: string | null;
    outputFile: string | null;
    direction: 'forward' | 'backward';
    maxTransactions: number;
    startBlock: number | null;
    endBlock: number | null;
    verify: boolean;
    fillGapsOnly: boolean;
    enrich: boolean;
    stakingOnly: boolean;
    help: boolean;
}

interface VerificationResults {
    valid: boolean;
    totalTransactions: number;
    verifiedCount: number;
    errorCount: number;
    errors: Array<{
        previousBlock: number;
        currentBlock: number;
        errors: VerificationError[];
    }>;
    error?: string;
}

/**
 * Load existing accounting history from file
 */
function loadExistingHistory(filePath: string): AccountHistory | null {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error: any) {
        console.error(`Error loading existing history from ${filePath}:`, error.message);
    }
    return null;
}

/**
 * Save accounting history to file
 */
function saveHistory(filePath: string, history: AccountHistory): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

/**
 * Discover staking pools from transaction transfers
 * Looks for transfers to contracts that match staking pool patterns
 * (e.g., deposit_and_stake, unstake, withdraw operations)
 */
interface StakingPoolRange {
    pool: string;
    firstDepositBlock: number;
    lastWithdrawalBlock: number | null; // null if still has balance
}

function discoverStakingPoolsWithRanges(history: AccountHistory): StakingPoolRange[] {
    const poolData = new Map<string, { deposits: number[], withdrawals: number[] }>();
    
    // Common staking pool contract patterns
    const stakingPoolPatterns = [
        /\.poolv1\.near$/,
        /\.pool\.near$/,
        /\.poolv2\.near$/
    ];
    
    // Method names for deposits vs withdrawals
    const depositMethods = ['deposit_and_stake', 'stake'];
    const withdrawMethods = ['unstake', 'unstake_all', 'withdraw_all', 'withdraw'];
    
    // Sort transactions by block
    const sortedTxs = [...history.transactions].sort((a, b) => a.block - b.block);
    
    for (const tx of sortedTxs) {
        if (!tx.transfers) continue;
        
        for (const transfer of tx.transfers) {
            const counterparty = transfer.counterparty;
            if (!counterparty) continue;
            
            // Check if the counterparty matches a staking pool pattern
            const isStakingPool = stakingPoolPatterns.some(pattern => pattern.test(counterparty));
            if (!isStakingPool) continue;
            
            if (!poolData.has(counterparty)) {
                poolData.set(counterparty, { deposits: [], withdrawals: [] });
            }
            
            const data = poolData.get(counterparty)!;
            
            // Determine if this is a deposit or withdrawal based on direction and method
            if (transfer.direction === 'out') {
                // Outgoing NEAR to pool = deposit
                const isDeposit = !transfer.memo || depositMethods.includes(transfer.memo);
                if (isDeposit) {
                    data.deposits.push(tx.block);
                }
            } else if (transfer.direction === 'in') {
                // Incoming NEAR from pool = withdrawal
                data.withdrawals.push(tx.block);
            }
        }
    }
    
    const result: StakingPoolRange[] = [];
    
    for (const [pool, data] of poolData) {
        if (data.deposits.length === 0) continue;
        
        const firstDepositBlock = Math.min(...data.deposits);
        // Last withdrawal is the latest block where we received NEAR from the pool
        // This might not be a "full withdrawal" - we'll check the balance to confirm
        const lastWithdrawalBlock = data.withdrawals.length > 0 
            ? Math.max(...data.withdrawals) 
            : null;
        
        result.push({
            pool,
            firstDepositBlock,
            lastWithdrawalBlock
        });
    }
    
    return result;
}

function discoverStakingPools(history: AccountHistory): string[] {
    const stakingPools = new Set<string>(history.stakingPools || []);
    
    // Common staking pool contract patterns
    const stakingPoolPatterns = [
        /\.poolv1\.near$/,
        /\.pool\.near$/,
        /\.poolv2\.near$/
    ];
    
    // Common staking method names that indicate a staking pool
    const stakingMethods = ['deposit_and_stake', 'stake', 'unstake', 'unstake_all', 'withdraw_from_staking_pool'];
    
    for (const tx of history.transactions) {
        if (!tx.transfers) continue;
        
        for (const transfer of tx.transfers) {
            const counterparty = transfer.counterparty;
            if (!counterparty) continue;
            
            // Check if the counterparty matches a staking pool pattern
            const isStakingPool = stakingPoolPatterns.some(pattern => pattern.test(counterparty));
            
            // Or if the method name indicates staking
            const isStakingMethod = transfer.memo && stakingMethods.includes(transfer.memo);
            
            if (isStakingPool || isStakingMethod) {
                stakingPools.add(counterparty);
            }
        }
    }
    
    return Array.from(stakingPools);
}

/**
 * Enrich transaction entry with staking pool balances if it involves staking pool transfers
 */
async function enrichWithStakingPoolBalances(
    accountId: string,
    entry: TransactionEntry
): Promise<void> {
    if (!entry.transfers || entry.transfers.length === 0) {
        return;
    }

    // Find staking pool transfers (deposits/withdrawals)
    const stakingPoolPattern = /\.pool.*\.near$/;
    const stakingPools = entry.transfers
        .filter(t => t.counterparty && stakingPoolPattern.test(t.counterparty))
        .map(t => t.counterparty!)
        .filter((pool, index, self) => self.indexOf(pool) === index); // unique

    if (stakingPools.length === 0) {
        return;
    }

    // Query staking balances for these pools
    try {
        const stakingBalances = await getStakingPoolBalances(accountId, entry.block, stakingPools);

        // Add to balanceAfter if we got results
        if (Object.keys(stakingBalances).length > 0) {
            if (!entry.balanceAfter) {
                entry.balanceAfter = {
                    near: '0',
                    fungibleTokens: {},
                    intentsTokens: {},
                    stakingPools: {}
                };
            }
            if (!entry.balanceAfter.stakingPools) {
                entry.balanceAfter.stakingPools = {};
            }
            Object.assign(entry.balanceAfter.stakingPools, stakingBalances);
        }
    } catch (error) {
        // Don't fail the whole process if staking balance query fails
        console.error(`  Warning: Could not fetch staking balance for pools at block ${entry.block}:`, error);
    }
}

/**
 * Collect staking reward entries between transactions
 * Creates synthetic transaction entries for staking balance changes at epoch boundaries
 * Only checks epochs where staking was active (between first deposit and full withdrawal)
 */
export async function collectStakingRewards(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    maxEpochsToCheck?: number,
    endBlockLimit?: number
): Promise<number> {
    const poolRanges = discoverStakingPoolsWithRanges(history);
    
    if (poolRanges.length === 0) {
        console.log('No staking pools discovered from transaction history');
        return 0;
    }
    
    const stakingPools = poolRanges.map(r => r.pool);
    console.log(`\nDiscovered staking pools: ${stakingPools.join(', ')}`);
    history.stakingPools = stakingPools;

    // Get current block height or use provided limit to check active pools up to present
    const currentBlockHeight = endBlockLimit || await getCurrentBlockHeight();

    // For each pool, determine the actual active staking range
    // Check balance at last withdrawal to see if it was a full withdrawal
    const activeRanges: { pool: string, startBlock: number, endBlock: number }[] = [];

    for (const range of poolRanges) {
        let endBlock: number;
        
        if (range.lastWithdrawalBlock) {
            // Check if balance is 0 after the last withdrawal
            const balanceAfterWithdrawal = await getStakingPoolBalances(
                accountId, 
                range.lastWithdrawalBlock + 10, // Check slightly after to ensure receipt processed
                [range.pool]
            );
            
            if (BigInt(balanceAfterWithdrawal[range.pool] || '0') === 0n) {
                // Full withdrawal - only check epochs up to the withdrawal
                endBlock = range.lastWithdrawalBlock;
                console.log(`  ${range.pool}: active from block ${range.firstDepositBlock} to ${endBlock} (fully withdrawn)`);
            } else {
                // Partial withdrawal - still active, check to current block height
                endBlock = currentBlockHeight;
                console.log(`  ${range.pool}: active from block ${range.firstDepositBlock} to ${endBlock} (still staking)`);
            }
        } else {
            // No withdrawals yet - check to current block height
            endBlock = currentBlockHeight;
            console.log(`  ${range.pool}: active from block ${range.firstDepositBlock} to ${endBlock} (still staking)`);
        }
        
        activeRanges.push({
            pool: range.pool,
            startBlock: range.firstDepositBlock,
            endBlock
        });
    }
    
    // Find all staking balance changes at epoch boundaries for each pool's active range
    let allChanges: StakingBalanceChange[] = [];
    let updatedExistingEntries = 0;

    // Cache queried balances to avoid redundant RPC calls
    const queriedBalances = new Map<string, Record<string, string>>(); // key: `${block}`, value: { pool -> balance }

    // Build a map of existing staking data by block and pool
    const existingStakingData = new Map<string, Set<string>>();
    for (const tx of history.transactions) {
        if (tx.balanceAfter?.stakingPools) {
            for (const pool of Object.keys(tx.balanceAfter.stakingPools)) {
                const key = `${tx.block}:${pool}`;
                if (!existingStakingData.has(key)) {
                    existingStakingData.set(key, new Set());
                }
                existingStakingData.get(key)!.add(pool);
            }
        }
    }
    
    const EPOCH_LENGTH = 43200;
    
    for (const range of activeRanges) {
        console.log(`\nChecking staking balance changes for ${range.pool}...`);
        console.log(`  Block range: ${range.startBlock} - ${range.endBlock}`);
        
        // Calculate which epoch boundaries need to be checked
        const firstEpochBoundary = Math.ceil(range.startBlock / EPOCH_LENGTH) * EPOCH_LENGTH;
        const epochBoundaries: number[] = [];
        
        for (let block = firstEpochBoundary; block <= range.endBlock; block += EPOCH_LENGTH) {
            const key = `${block}:${range.pool}`;
            if (!existingStakingData.has(key)) {
                epochBoundaries.push(block);
            }
        }
        
        // Also check the final block if it's not an epoch boundary
        if (range.endBlock > firstEpochBoundary && range.endBlock % EPOCH_LENGTH !== 0) {
            const key = `${range.endBlock}:${range.pool}`;
            if (!existingStakingData.has(key)) {
                epochBoundaries.push(range.endBlock);
            }
        }
        
        const totalEpochs = Math.ceil((range.endBlock - firstEpochBoundary) / EPOCH_LENGTH);
        const alreadyChecked = totalEpochs - epochBoundaries.length;
        if (alreadyChecked > 0) {
            console.log(`  Skipping ${alreadyChecked} epoch(s) with existing staking data`);
        }
        
        if (epochBoundaries.length === 0) {
            console.log('  All epochs already have staking data');
            continue;
        }
        
        // Limit epochs to check if maxEpochsToCheck is set (for incremental sync)
        const epochsToCheck = maxEpochsToCheck && maxEpochsToCheck < epochBoundaries.length
            ? epochBoundaries.slice(0, maxEpochsToCheck)
            : epochBoundaries;

        if (maxEpochsToCheck && epochsToCheck.length < epochBoundaries.length) {
            console.log(`  Limited to ${epochsToCheck.length} epoch(s) this cycle (${epochBoundaries.length - epochsToCheck.length} remaining for next cycle)`);
        }

        console.log(`  Checking ${epochsToCheck.length} epoch(s) without existing data`);

        // Manually check each epoch boundary that needs data
        let prevBalances = await getStakingPoolBalances(accountId, range.startBlock, [range.pool]);
        let prevBlock = range.startBlock;

        for (let i = 0; i < epochsToCheck.length; i++) {
            if (getStopSignal()) {
                throw new Error('Operation cancelled by user');
            }

            const block = epochsToCheck[i];
            if (block === undefined) {
                continue;
            }

            console.log(`    Checking epoch ${i + 1}/${epochsToCheck.length} at block ${block}...`);

            const currentBalances = await getStakingPoolBalances(accountId, block, [range.pool]);

            // Cache the queried balance for later reuse
            const blockKey = block.toString();
            if (!queriedBalances.has(blockKey)) {
                queriedBalances.set(blockKey, {});
            }
            Object.assign(queriedBalances.get(blockKey)!, currentBalances);

            const prevBalance = BigInt(prevBalances[range.pool] || '0');
            const currentBalance = BigInt(currentBalances[range.pool] || '0');

            // Update existing entry if this block already exists in history
            const existingEntry = history.transactions.find(tx => tx.block === block);
            const poolBalance = currentBalances[range.pool];
            if (existingEntry && poolBalance !== undefined) {
                // Add the newly queried pool balance to the existing entry
                if (!existingEntry.balanceAfter) {
                    existingEntry.balanceAfter = {
                        near: '0',
                        fungibleTokens: {},
                        intentsTokens: {},
                        stakingPools: {}
                    };
                }
                if (!existingEntry.balanceAfter.stakingPools) {
                    existingEntry.balanceAfter.stakingPools = {};
                }
                existingEntry.balanceAfter.stakingPools[range.pool] = poolBalance;

                // Also update balanceBefore if it exists
                if (existingEntry.balanceBefore) {
                    if (!existingEntry.balanceBefore.stakingPools) {
                        existingEntry.balanceBefore.stakingPools = {};
                    }
                    // Get balance from previous block to populate balanceBefore
                    const prevBlockBalances = await getStakingPoolBalances(accountId, block - 1, [range.pool]);
                    const prevPoolBalance = prevBlockBalances[range.pool];
                    if (prevPoolBalance !== undefined) {
                        existingEntry.balanceBefore.stakingPools[range.pool] = prevPoolBalance;
                    }
                }

                updatedExistingEntries++;
            }

            if (prevBalance !== currentBalance) {
                allChanges.push({
                    block,
                    pool: range.pool,
                    startBalance: prevBalance.toString(),
                    endBalance: currentBalance.toString(),
                    diff: (currentBalance - prevBalance).toString()
                });
            }

            prevBalances = currentBalances;
            prevBlock = block;
        }
    }
    
    if (allChanges.length === 0) {
        console.log('No staking balance changes found');
        return 0;
    }
    
    console.log(`\nFound ${allChanges.length} staking balance change(s) total`);
    
    // Filter out changes that occur at the same block as existing transactions
    // (those are deposits/withdrawals, not rewards)
    const existingBlocks = new Set(history.transactions.map(tx => tx.block));
    const rewardChanges = allChanges.filter(change => !existingBlocks.has(change.block));
    
    if (rewardChanges.length === 0) {
        console.log('All staking changes coincide with existing transactions (deposits/withdrawals)');

        // Save the file if we updated existing entries
        if (updatedExistingEntries > 0) {
            console.log(`Updated ${updatedExistingEntries} existing entries with new pool data`);
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
        }

        return 0;
    }
    
    console.log(`Creating ${rewardChanges.length} staking reward entries...`);
    
    // Create synthetic transaction entries for staking rewards
    let addedCount = 0;
    for (const change of rewardChanges) {
        if (getStopSignal()) {
            break;
        }
        
        // Get staking pool balances at this block and the previous
        // Prefer cached individual pool balance, but query for the specific pool if not cached
        const blockKey = change.block.toString();
        const prevBlockKey = (change.block - 1).toString();

        const cachedAfter = queriedBalances.get(blockKey);
        const cachedBefore = queriedBalances.get(prevBlockKey);

        // For staking-only entries, we only need the balance of the pool that changed
        const balancesAfter = cachedAfter && cachedAfter[change.pool]
            ? cachedAfter
            : await getStakingPoolBalances(accountId, change.block, [change.pool]);

        const balancesBefore = cachedBefore && cachedBefore[change.pool]
            ? cachedBefore
            : await getStakingPoolBalances(accountId, change.block - 1, [change.pool]);
        
        // Fetch block timestamp
        const blockTimestamp = await getBlockTimestamp(change.block);
        
        // Create the synthetic transaction entry
        const entry: TransactionEntry = {
            block: change.block,
            transactionBlock: null, // Synthetic entry, no transaction block
            timestamp: blockTimestamp,
            transactionHashes: [], // No actual transaction
            transactions: [], // No actual transaction
            transfers: [{
                type: 'staking_reward',
                direction: BigInt(change.diff) >= 0n ? 'in' : 'out',
                amount: change.diff.replace('-', ''), // Absolute value
                counterparty: change.pool,
                tokenId: change.pool,
                memo: 'staking_reward'
            } as TransferDetail],
            balanceBefore: {
                near: '0', // Not tracked for staking-only entries
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: balancesBefore
            },
            balanceAfter: {
                near: '0',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: balancesAfter
            },
            changes: {
                nearChanged: false,
                tokensChanged: {},
                intentsChanged: {},
                stakingChanged: {
                    [change.pool]: {
                        start: change.startBalance,
                        end: change.endBalance,
                        diff: change.diff
                    }
                }
            }
        };
        
        history.transactions.push(entry);
        addedCount++;
        
        // Save periodically
        if (addedCount % 10 === 0) {
            history.updatedAt = new Date().toISOString();
            history.metadata.totalTransactions = history.transactions.length;
            saveHistory(outputFile, history);
            console.log(`  Added ${addedCount} staking reward entries...`);
        }
    }
    
    // Final sort and save
    history.transactions.sort((a, b) => b.block - a.block); // Sort descending by block
    history.updatedAt = new Date().toISOString();
    history.metadata.totalTransactions = history.transactions.length;
    saveHistory(outputFile, history);
    
    return addedCount;
}

/**
 * Verify that a transaction's balance changes match the expected changes
 */
function verifyTransactionConnectivity(
    transaction: TransactionEntry,
    previousTransaction: TransactionEntry | null
): VerificationResult {
    const result: VerificationResult = {
        valid: true,
        errors: []
    };

    if (!previousTransaction) {
        return result; // First transaction, nothing to verify against
    }

    // Verify NEAR balance connectivity
    const expectedStartNear = previousTransaction.balanceAfter?.near || '0';
    const actualStartNear = transaction.balanceBefore?.near || '0';

    if (expectedStartNear !== actualStartNear) {
        result.valid = false;
        result.errors.push({
            type: 'near_balance_mismatch',
            expected: expectedStartNear,
            actual: actualStartNear,
            message: `NEAR balance mismatch: expected ${expectedStartNear} but got ${actualStartNear}`
        });
    }

    // Verify fungible token balances connectivity
    const prevTokens = previousTransaction.balanceAfter?.fungibleTokens || {};
    const currTokens = transaction.balanceBefore?.fungibleTokens || {};
    const allTokens = new Set([...Object.keys(prevTokens), ...Object.keys(currTokens)]);

    for (const token of allTokens) {
        const expected = prevTokens[token] || '0';
        const actual = currTokens[token] || '0';
        if (expected !== actual) {
            result.valid = false;
            result.errors.push({
                type: 'token_balance_mismatch',
                token,
                expected,
                actual,
                message: `Token ${token} balance mismatch: expected ${expected} but got ${actual}`
            });
        }
    }

    // Verify intents token balances connectivity
    const prevIntents = previousTransaction.balanceAfter?.intentsTokens || {};
    const currIntents = transaction.balanceBefore?.intentsTokens || {};
    const allIntents = new Set([...Object.keys(prevIntents), ...Object.keys(currIntents)]);

    for (const token of allIntents) {
        const expected = prevIntents[token] || '0';
        const actual = currIntents[token] || '0';
        if (expected !== actual) {
            result.valid = false;
            result.errors.push({
                type: 'intents_balance_mismatch',
                token,
                expected,
                actual,
                message: `Intents token ${token} balance mismatch: expected ${expected} but got ${actual}`
            });
        }
    }

    return result;
}

/**
 * Check if a transaction entry is a staking-only entry (synthetic staking reward)
 * Staking-only entries don't track NEAR/FT/intents balances and should be excluded from gap detection
 */
export function isStakingOnlyEntry(tx: TransactionEntry): boolean {
    // Staking-only entries have:
    // - No transaction hashes (synthetic entry)
    // - stakingChanged in changes
    // - near balance of '0' (not tracked)
    const hasNoTxHashes = !tx.transactionHashes || tx.transactionHashes.length === 0;
    const hasStakingChanges = Boolean(tx.changes?.stakingChanged && Object.keys(tx.changes.stakingChanged).length > 0);
    const hasNoOtherChanges = !tx.changes?.nearChanged && 
        Object.keys(tx.changes?.tokensChanged || {}).length === 0 &&
        Object.keys(tx.changes?.intentsChanged || {}).length === 0;
    
    return hasNoTxHashes && hasStakingChanges && hasNoOtherChanges;
}

// Note: detectGaps is now imported from './gap-detection.js' module

/**
 * Extract FT and intents tokens from transaction transfers.
 * 
 * Scans through transfer details and extracts unique token contract IDs
 * for fungible tokens (FT) and multi-tokens (intents).
 * 
 * @param transfers - Array of transfer details from a transaction
 * @returns Object containing Sets of unique FT and intents token IDs
 * 
 * @example
 * const txInfo = await findBalanceChangingTransaction(accountId, block);
 * const { ftTokens, intentsTokens } = extractTokensFromTransfers(txInfo.transfers);
 * // ftTokens: Set(['arizcredits.near', 'wrap.near'])
 * // intentsTokens: Set(['nep141:wrap.near'])
 */
function extractTokensFromTransfers(transfers: TransferDetail[]): {
    ftTokens: Set<string>;
    intentsTokens: Set<string>;
} {
    const ftTokens = new Set<string>(
        (transfers || [])
            .filter(t => t.type === 'ft' && t.tokenId)
            .map(t => t.tokenId!)
    );
    
    const intentsTokens = new Set<string>(
        (transfers || [])
            .filter(t => t.type === 'mt' && t.tokenId)
            .map(t => t.tokenId!)
    );
    
    return { ftTokens, intentsTokens };
}

/**
 * Enrich balance snapshots with FT/intents tokens discovered from transfers.
 * 
 * This ensures balance snapshots include all tokens that had transfers in the transaction.
 * Mutates the balanceChange object in place by:
 * - Enriching startBalance and endBalance with discovered tokens
 * - Recalculating tokensChanged and intentsChanged with the enriched balances
 * 
 * @param accountId - The account to query balances for
 * @param blockHeight - The block height where the balance change occurred
 * @param balanceChange - The balance change object to enrich (mutated in place)
 * @param discoveredTokens - Sets of FT and intents token IDs discovered from transfers
 * 
 * @example
 * const txInfo = await findBalanceChangingTransaction(accountId, block);
 * const tokens = extractTokensFromTransfers(txInfo.transfers);
 * await enrichBalancesWithDiscoveredTokens(accountId, block, balanceChange, tokens);
 * // balanceChange.startBalance and endBalance now include discovered FT tokens
 */
async function enrichBalancesWithDiscoveredTokens(
    accountId: string,
    blockHeight: number,
    balanceChange: BalanceChanges,
    discoveredTokens: { ftTokens: Set<string>; intentsTokens: Set<string> }
): Promise<void> {
    const { ftTokens, intentsTokens } = discoveredTokens;
    
    if (ftTokens.size === 0 && intentsTokens.size === 0) {
        return;
    }
    
    // Enrich balance snapshots
    if (balanceChange.startBalance) {
        balanceChange.startBalance = await enrichBalanceSnapshot(
            accountId,
            blockHeight - 1,
            balanceChange.startBalance,
            Array.from(ftTokens),
            Array.from(intentsTokens)
        );
    }
    
    if (balanceChange.endBalance) {
        balanceChange.endBalance = await enrichBalanceSnapshot(
            accountId,
            blockHeight,
            balanceChange.endBalance,
            Array.from(ftTokens),
            Array.from(intentsTokens)
        );
    }
    
    // Recalculate changes with enriched balances
    if (balanceChange.startBalance && balanceChange.endBalance) {
        const updatedChanges = detectBalanceChanges(balanceChange.startBalance, balanceChange.endBalance);
        balanceChange.tokensChanged = updatedChanges.tokensChanged;
        balanceChange.intentsChanged = updatedChanges.intentsChanged;
    }
}

/**
 * Combined transaction block info from any API source
 */
interface CombinedTransactionBlock {
    blockHeight: number;
    source: 'nearblocks' | 'intents' | 'pikespeak';
    tokenIds?: string[];  // For intents/pikespeak transactions
}

/**
 * Fetch transaction blocks from all available APIs within a specific block range.
 * Returns blocks sorted by height (highest first for backward search, lowest first for forward).
 */
async function fetchTransactionBlocksFromAPIs(
    accountId: string,
    options: {
        afterBlock?: number;   // Only include blocks > afterBlock
        beforeBlock?: number;  // Only include blocks < beforeBlock  
        maxBlocks?: number;    // Maximum number of blocks to return
        direction?: 'forward' | 'backward';
    } = {}
): Promise<CombinedTransactionBlock[]> {
    const { afterBlock, beforeBlock, maxBlocks, direction = 'backward' } = options;
    
    const allKnownBlocks: CombinedTransactionBlock[] = [];
    const seenBlockHeights = new Set<number>();
    
    const rangeDesc = afterBlock || beforeBlock 
        ? ` (range: ${afterBlock ?? 0} - ${beforeBlock ?? 'latest'})`
        : '';
    
    // Collect from NearBlocks API
    if (isNearBlocksAvailable()) {
        console.log(`  Fetching from NearBlocks API${rangeDesc}...`);
        
        try {
            const maxPages = maxBlocks ? Math.ceil(maxBlocks / 25) + 10 : undefined;
            const knownBlocks = await getAllTransactionBlocks(accountId, {
                afterBlock,
                beforeBlock,
                maxPages
            });
            
            for (const block of knownBlocks) {
                // Apply range filter (NearBlocks already supports this but double-check)
                if (afterBlock !== undefined && block.blockHeight <= afterBlock) continue;
                if (beforeBlock !== undefined && block.blockHeight >= beforeBlock) continue;
                
                if (!seenBlockHeights.has(block.blockHeight)) {
                    seenBlockHeights.add(block.blockHeight);
                    allKnownBlocks.push({
                        blockHeight: block.blockHeight,
                        source: 'nearblocks'
                    });
                }
            }
            console.log(`    Found ${knownBlocks.length} blocks from NearBlocks`);
        } catch (error: any) {
            console.warn(`    NearBlocks API error: ${error.message}`);
        }
    }
    
    // Collect from Intents Explorer API
    if (isIntentsExplorerAvailable()) {
        console.log(`  Fetching from Intents Explorer API${rangeDesc}...`);
        
        try {
            const maxPages = maxBlocks ? Math.ceil(maxBlocks / 25) + 10 : undefined;
            const intentsBlocks = await getAllIntentsTransactionBlocks(accountId, {
                afterBlock,
                beforeBlock,
                maxPages
            });
            
            let newIntentsBlocks = 0;
            for (const block of intentsBlocks) {
                // Apply range filter
                if (afterBlock !== undefined && block.blockHeight <= afterBlock) continue;
                if (beforeBlock !== undefined && block.blockHeight >= beforeBlock) continue;
                
                if (!seenBlockHeights.has(block.blockHeight)) {
                    seenBlockHeights.add(block.blockHeight);
                    allKnownBlocks.push({
                        blockHeight: block.blockHeight,
                        source: 'intents',
                        tokenIds: block.tokenIds
                    });
                    newIntentsBlocks++;
                }
            }
            console.log(`    Found ${intentsBlocks.length} blocks from Intents Explorer (${newIntentsBlocks} new)`);
        } catch (error: any) {
            console.warn(`    Intents Explorer API error: ${error.message}`);
        }
    }
    
    // Collect from Pikespeak API
    if (isPikespeakAvailable()) {
        console.log(`  Fetching from Pikespeak API${rangeDesc}...`);
        
        try {
            const maxEvents = maxBlocks ? maxBlocks * 5 : undefined;
            const pikespeakBlocks = await getAllPikespeakTransactionBlocks(accountId, {
                afterBlock,
                beforeBlock,
                maxEvents
            });
            
            let newPikespeakBlocks = 0;
            for (const block of pikespeakBlocks) {
                // Apply range filter (Pikespeak module already filters but double-check)
                if (afterBlock !== undefined && block.blockHeight <= afterBlock) continue;
                if (beforeBlock !== undefined && block.blockHeight >= beforeBlock) continue;
                
                if (!seenBlockHeights.has(block.blockHeight)) {
                    seenBlockHeights.add(block.blockHeight);
                    const tokenIds = block.token ? [block.token] : undefined;
                    allKnownBlocks.push({
                        blockHeight: block.blockHeight,
                        source: 'pikespeak',
                        tokenIds
                    });
                    newPikespeakBlocks++;
                }
            }
            console.log(`    Found ${pikespeakBlocks.length} blocks from Pikespeak (${newPikespeakBlocks} new)`);
        } catch (error: any) {
            console.warn(`    Pikespeak API error: ${error.message}`);
        }
    }
    
    // Sort by block height based on direction
    if (direction === 'backward') {
        allKnownBlocks.sort((a, b) => b.blockHeight - a.blockHeight);
    } else {
        allKnownBlocks.sort((a, b) => a.blockHeight - b.blockHeight);
    }
    
    // Limit to maxBlocks if specified
    if (maxBlocks && allKnownBlocks.length > maxBlocks) {
        return allKnownBlocks.slice(0, maxBlocks);
    }
    
    return allKnownBlocks;
}

/**
 * Process API-discovered blocks and add balance changes to history.
 * Returns the number of new transactions added.
 */
async function processDiscoveredBlocks(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    blocks: CombinedTransactionBlock[],
    maxTransactions: number
): Promise<number> {
    let transactionsFound = 0;
    const existingBlocks = new Set(history.transactions.map(t => t.block));
    
    // Filter out already processed blocks
    const newBlocks = blocks.filter(b => !existingBlocks.has(b.blockHeight));
    
    if (newBlocks.length === 0) {
        return 0;
    }
    
    console.log(`  Processing ${Math.min(newBlocks.length, maxTransactions)} blocks...`);
    
    for (const txBlock of newBlocks) {
        if (getStopSignal()) {
            console.log('Stop signal received, saving progress...');
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
            break;
        }
        
        if (transactionsFound >= maxTransactions) {
            break;
        }
        
        // Clear cache periodically
        if (transactionsFound % 10 === 0) {
            clearBalanceCache();
        }
        
        try {
            // First, find the transaction details to discover which tokens changed
            const txInfo = await findBalanceChangingTransaction(accountId, txBlock.blockHeight);
            
            // Determine which tokens changed from the transfers
            const changedIntentsTokens = new Set<string>();
            const changedFungibleTokens = new Set<string>();
            
            for (const transfer of txInfo.transfers || []) {
                if (transfer.type === 'mt' && transfer.tokenId) {
                    changedIntentsTokens.add(transfer.tokenId);
                } else if (transfer.type === 'ft' && transfer.tokenId) {
                    changedFungibleTokens.add(transfer.tokenId);
                }
            }
            
            // Merge with API-provided tokenIds if available
            if (txBlock.tokenIds && txBlock.tokenIds.length > 0) {
                txBlock.tokenIds.forEach(t => changedIntentsTokens.add(t));
            }
            
            // Get balance changes at this specific block, querying only the tokens that changed
            // If no token changes detected, pass empty array to avoid querying all tokens
            const intentsTokensToCheck = changedIntentsTokens.size > 0 ? Array.from(changedIntentsTokens) : null;
            const fungibleTokensToCheck = changedFungibleTokens.size > 0 ? Array.from(changedFungibleTokens) : null;
            
            const balanceChange = await getBalanceChangesAtBlock(
                accountId, 
                txBlock.blockHeight,
                fungibleTokensToCheck,
                intentsTokensToCheck,
                undefined
            );
            
            if (!balanceChange.hasChanges) {
                // No balance changes for tracked tokens
                continue;
            }
            
            // Create transaction entry
            const entry: TransactionEntry = {
                block: txBlock.blockHeight,
                transactionBlock: txInfo.transactionBlock,
                timestamp: txInfo.blockTimestamp,
                transactionHashes: txInfo.transactionHashes,
                transactions: txInfo.transactions,
                transfers: txInfo.transfers,
                balanceBefore: balanceChange.startBalance,
                balanceAfter: balanceChange.endBalance,
                changes: {
                    nearChanged: balanceChange.nearChanged,
                    nearDiff: balanceChange.nearDiff,
                    tokensChanged: balanceChange.tokensChanged,
                    intentsChanged: balanceChange.intentsChanged
                }
            };

            // Enrich with staking pool balances if this is a staking deposit/withdrawal
            await enrichWithStakingPoolBalances(accountId, entry);

            // Add to history
            history.transactions.push(entry);
            transactionsFound++;
            
            const sourceLabel = txBlock.source !== 'nearblocks' ? ` (${txBlock.source})` : '';
            console.log(`    Added transaction at block ${txBlock.blockHeight}${sourceLabel}`);
            
            // Update metadata
            const allBlocks = history.transactions.map(t => t.block);
            history.metadata.firstBlock = Math.min(...allBlocks);
            history.metadata.lastBlock = Math.max(...allBlocks);
            history.metadata.totalTransactions = history.transactions.length;
            history.updatedAt = new Date().toISOString();
            
            // Save progress periodically
            if (transactionsFound % 5 === 0) {
                saveHistory(outputFile, history);
            }
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`Error during processing: ${error.message}`);
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
                break;
            }
            console.warn(`Error processing block ${txBlock.blockHeight}: ${error.message}`);
        }
    }
    
    return transactionsFound;
}

/**
 * Reconcile a gap where no transactions were found.
 * This happens when the gap is caused by incomplete token tracking in stored data.
 * Re-fetches balances for the transactions at gap boundaries with a complete token list.
 * Returns true if the gap was resolved by reconciliation.
 */
async function reconcileGap(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    gap: Gap
): Promise<boolean> {
    console.log(`  Reconciling gap: checking if balance data is incomplete...`);
    
    // Get all tokens tracked across the entire history
    const allFungibleTokens = new Set<string>();
    const allIntentsTokens = new Set<string>();
    
    for (const tx of history.transactions) {
        if (tx.balanceBefore?.fungibleTokens) {
            Object.keys(tx.balanceBefore.fungibleTokens).forEach(t => allFungibleTokens.add(t));
        }
        if (tx.balanceAfter?.fungibleTokens) {
            Object.keys(tx.balanceAfter.fungibleTokens).forEach(t => allFungibleTokens.add(t));
        }
        if (tx.balanceBefore?.intentsTokens) {
            Object.keys(tx.balanceBefore.intentsTokens).forEach(t => allIntentsTokens.add(t));
        }
        if (tx.balanceAfter?.intentsTokens) {
            Object.keys(tx.balanceAfter.intentsTokens).forEach(t => allIntentsTokens.add(t));
        }
    }
    
    const ftTokens = [...allFungibleTokens];
    const intentTokens = [...allIntentsTokens];
    
    // Find the transactions at the gap boundaries
    const prevTx = history.transactions.find(tx => tx.block === gap.startBlock);
    const nextTx = history.transactions.find(tx => tx.block === gap.endBlock);
    
    if (!prevTx || !nextTx) {
        console.log(`    Could not find boundary transactions`);
        return false;
    }
    
    try {
        // Re-fetch balance at the end of prevTx (balanceAfter)
        console.log(`    Re-fetching balance at block ${gap.startBlock}...`);
        const newBalanceAfterPrev = await getAllBalances(accountId, gap.startBlock, ftTokens, intentTokens);
        
        // Re-fetch balance at the start of nextTx (balanceBefore)
        // Note: balanceBefore is the state just before the transaction, so we use block - 1
        console.log(`    Re-fetching balance at block ${gap.endBlock - 1}...`);
        const newBalanceBeforeNext = await getAllBalances(accountId, gap.endBlock - 1, ftTokens, intentTokens);
        
        // Check if the re-fetched balances match (no actual gap)
        const nearMatches = newBalanceAfterPrev.near === newBalanceBeforeNext.near;
        
        let ftMatches = true;
        for (const token of ftTokens) {
            const prevVal = newBalanceAfterPrev.fungibleTokens?.[token] || '0';
            const nextVal = newBalanceBeforeNext.fungibleTokens?.[token] || '0';
            if (prevVal !== nextVal) {
                ftMatches = false;
                break;
            }
        }
        
        let intentsMatches = true;
        for (const token of intentTokens) {
            const prevVal = newBalanceAfterPrev.intentsTokens?.[token] || '0';
            const nextVal = newBalanceBeforeNext.intentsTokens?.[token] || '0';
            if (prevVal !== nextVal) {
                intentsMatches = false;
                break;
            }
        }
        
        if (nearMatches && ftMatches && intentsMatches) {
            // The balances actually match - update the stored data
            console.log(`    Gap resolved: balances match after re-fetch with complete token list`);
            
            // Update prevTx.balanceAfter
            prevTx.balanceAfter = newBalanceAfterPrev;
            
            // Update nextTx.balanceBefore  
            nextTx.balanceBefore = newBalanceBeforeNext;
            
            // Save the updated history
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
            
            return true;
        } else {
            console.log(`    Gap is real: balances differ even with complete token list`);
            if (!nearMatches) console.log(`      NEAR: ${newBalanceAfterPrev.near} vs ${newBalanceBeforeNext.near}`);
            return false;
        }
    } catch (error: any) {
        console.log(`    Error reconciling gap: ${error.message}`);
        return false;
    }
}

/**
 * Fill a single gap using binary search.
 * Returns the number of transactions found and added.
 */
async function fillGapWithBinarySearch(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    gap: Gap,
    maxTransactions: number
): Promise<number> {
    const searchStart = gap.startBlock;  // Start from the last known good block to detect changes at gap boundary
    const searchEnd = gap.endBlock - 1;
    
    if (searchStart > searchEnd) {
        return 0;
    }
    
    // Extract which assets changed in this gap
    const changedAssets = gap.verification.errors.reduce((acc, err) => {
        if (err.type === 'near_balance_mismatch') acc.near = true;
        if (err.type === 'token_balance_mismatch' && err.token) acc.tokens.push(err.token);
        if (err.type === 'intents_balance_mismatch' && err.token) acc.intents.push(err.token);
        return acc;
    }, { near: false, tokens: [] as string[], intents: [] as string[] });
    
    console.log(`  Binary search: blocks ${searchStart} - ${searchEnd}`);
    console.log(`    Assets changed: NEAR=${changedAssets.near}, FT=${changedAssets.tokens.length}, Intents=${changedAssets.intents.length}`);
    
    let currentStart = searchStart;
    let currentEnd = searchEnd;
    let totalFound = 0;
    
    while (currentStart <= currentEnd && totalFound < maxTransactions) {
        if (getStopSignal()) break;
        
        // Clear cache periodically
        if (totalFound % 10 === 0) {
            clearBalanceCache();
        }
        
        let balanceChange: BalanceChanges;
        try {
            balanceChange = await findLatestBalanceChangingBlock(
                accountId,
                currentStart,
                currentEnd,
                changedAssets.tokens.length > 0 ? changedAssets.tokens : null,
                changedAssets.intents.length > 0 ? changedAssets.intents : null,
                changedAssets.near
            );
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`    Error during binary search: ${error.message}`);
                break;
            }
            throw error;
        }
        
        if (!balanceChange.hasChanges || !balanceChange.block) {
            break;
        }
        
        // Check for duplicate
        const existingEntry = history.transactions.find(t => t.block === balanceChange.block);
        if (existingEntry) {
            currentEnd = balanceChange.block! - 1;
            continue;
        }
        
        // Find transaction details
        const txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block);
        
        // Extract FT and intents tokens from discovered transfers and enrich balance snapshots
        const discoveredTokens = extractTokensFromTransfers(txInfo.transfers);
        await enrichBalancesWithDiscoveredTokens(accountId, balanceChange.block, balanceChange, discoveredTokens);
        
        // Create transaction entry
        const entry: TransactionEntry = {
            block: balanceChange.block,
            transactionBlock: txInfo.transactionBlock,
            timestamp: txInfo.blockTimestamp,
            transactionHashes: txInfo.transactionHashes,
            transactions: txInfo.transactions,
            transfers: txInfo.transfers,
            balanceBefore: balanceChange.startBalance,
            balanceAfter: balanceChange.endBalance,
            changes: {
                nearChanged: balanceChange.nearChanged,
                nearDiff: balanceChange.nearDiff,
                tokensChanged: balanceChange.tokensChanged,
                intentsChanged: balanceChange.intentsChanged
            }
        };

        // Enrich with staking pool balances if this is a staking deposit/withdrawal
        await enrichWithStakingPoolBalances(accountId, entry);

        history.transactions.push(entry);
        totalFound++;
        
        console.log(`    Found transaction at block ${balanceChange.block}`);
        
        // Update metadata
        const allBlocks = history.transactions.map(t => t.block);
        history.metadata.firstBlock = Math.min(...allBlocks);
        history.metadata.lastBlock = Math.max(...allBlocks);
        history.metadata.totalTransactions = history.transactions.length;
        
        // Save periodically
        if (totalFound % 5 === 0) {
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
        }
        
        // Continue searching in remaining range
        currentEnd = balanceChange.block - 1;
    }
    
    return totalFound;
}

/**
 * Fill a single gap - first try APIs, then binary search.
 * Returns the number of transactions found and added.
 */
async function fillGap(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    gap: Gap,
    maxTransactions: number
): Promise<number> {
    console.log(`\nFilling gap: blocks ${gap.startBlock} - ${gap.endBlock}`);
    
    let totalFound = 0;
    
    // 1. First try fetching from APIs with block range constraint
    const apiBlocks = await fetchTransactionBlocksFromAPIs(accountId, {
        afterBlock: gap.startBlock,
        beforeBlock: gap.endBlock,
        maxBlocks: maxTransactions
    });
    
    if (apiBlocks.length > 0) {
        console.log(`  Found ${apiBlocks.length} potential blocks from APIs`);
        const apiFound = await processDiscoveredBlocks(
            accountId,
            history,
            outputFile,
            apiBlocks,
            maxTransactions - totalFound
        );
        totalFound += apiFound;
        
        if (totalFound >= maxTransactions) {
            return totalFound;
        }
    }
    
    // 2. Re-detect if gap still exists after API processing
    //    (The gap may have been partially or fully filled)
    history.transactions.sort((a, b) => a.block - b.block);
    const gapAnalysis = detectGaps(history.transactions);
    
    // Find the remaining gap in this range
    const remainingGap = gapAnalysis.internalGaps.find(g => 
        g.startBlock >= gap.startBlock && g.endBlock <= gap.endBlock
    );
    
    if (!remainingGap) {
        // Gap is fully filled
        return totalFound;
    }
    
    // 3. Binary search for remaining transactions
    if (!getStopSignal() && totalFound < maxTransactions) {
        console.log(`  Gap partially filled, continuing with binary search...`);
        const binaryFound = await fillGapWithBinarySearch(
            accountId,
            history,
            outputFile,
            remainingGap,
            maxTransactions - totalFound
        );
        totalFound += binaryFound;
        
        // 4. If binary search found nothing, try to reconcile the gap
        //    This handles cases where the gap is due to incomplete token tracking
        if (binaryFound === 0 && !getStopSignal()) {
            const reconciled = await reconcileGap(accountId, history, outputFile, remainingGap);
            if (reconciled) {
                // Gap was resolved by reconciliation (data was incomplete, not missing transactions)
                // Return 0 found but the gap is now closed
                return totalFound;
            }
        }
    }
    
    return totalFound;
}

/**
 * Fill gaps in transaction history.
 * Uses the gap-detection module to identify gaps, then fills them.
 */
async function fillGaps(
    history: AccountHistory,
    outputFile: string,
    maxTransactionsToFill: number = 50
): Promise<number> {
    // Sort transactions before analysis
    history.transactions.sort((a, b) => a.block - b.block);
    
    // Use the module's detectGaps function
    const gapAnalysis = detectGaps(history.transactions);
    
    if (gapAnalysis.isComplete) {
        console.log('No gaps detected in transaction history');
        return 0;
    }
    
    const totalGaps = gapAnalysis.internalGaps.length + 
        (gapAnalysis.gapToCreation ? 1 : 0) + 
        (gapAnalysis.gapToPresent ? 1 : 0);
    
    console.log(`\n=== Detected ${totalGaps} gap(s) in transaction history ===`);
    console.log(`  Internal gaps: ${gapAnalysis.internalGaps.length}`);
    if (gapAnalysis.gapToCreation) console.log(`  Gap to creation: yes (before block ${gapAnalysis.gapToCreation.endBlock})`);
    if (gapAnalysis.gapToPresent) console.log(`  Gap to present: yes (after block ${gapAnalysis.gapToPresent.startBlock})`);
    
    let totalFilled = 0;
    
    // 1. Fill internal gaps first (highest priority)
    for (const gap of gapAnalysis.internalGaps) {
        if (getStopSignal() || totalFilled >= maxTransactionsToFill) break;
        
        const filled = await fillGap(
            history.accountId,
            history,
            outputFile,
            gap,
            maxTransactionsToFill - totalFilled
        );
        totalFilled += filled;
    }
    
    // Save and return - gap to creation/present are handled by main search
    if (totalFilled > 0) {
        history.transactions.sort((a, b) => a.block - b.block);
        saveHistory(outputFile, history);
    }
    
    return totalFilled;
}

/**
 * Enrich existing transactions with transfer details if missing
 * This fetches transfer counterparty information for transactions that don't have it
 */
async function enrichTransactionsWithTransfers(
    history: AccountHistory,
    outputFile: string,
    maxToEnrich: number = 50
): Promise<number> {
    // Helper to check if transfers are missing for a balance change type
    const hasMissingTransfers = (tx: TransactionEntry): boolean => {
        if (!tx.changes || !tx.transfers) return false;
        
        // Check if FT balance changed but no FT transfer was captured
        const ftChanges = Object.keys(tx.changes.tokensChanged || {});
        if (ftChanges.length > 0) {
            const hasFtTransfer = tx.transfers.some(t => t.type === 'ft');
            if (!hasFtTransfer) return true;
        }
        
        // Check if MT balance changed but no MT transfer was captured  
        const mtChanges = Object.keys(tx.changes.intentsChanged || {});
        if (mtChanges.length > 0) {
            const hasMtTransfer = tx.transfers.some(t => t.type === 'mt');
            if (!hasMtTransfer) return true;
        }
        
        return false;
    };
    
    // Find transactions that haven't been attempted for enrichment yet
    // tx.transfers === undefined means never attempted
    // tx.transfers === [] means attempted but found nothing (don't retry unless balance changes suggest missing transfers)
    // Also re-enrich if FT/MT balance changed but no corresponding transfer was captured
    const transactionsToEnrich = history.transactions.filter(tx => {
        const neverAttempted = tx.transfers === undefined;
        const hasBalanceChanges = tx.changes && (
            tx.changes.nearChanged ||
            Object.keys(tx.changes.tokensChanged || {}).length > 0 ||
            Object.keys(tx.changes.intentsChanged || {}).length > 0
        );
        const missingTransfers = hasMissingTransfers(tx);
        return (neverAttempted && hasBalanceChanges) || missingTransfers;
    });
    
    if (transactionsToEnrich.length === 0) {
        console.log('All transactions with balance changes already have transfer details (or attempted)');
        return 0;
    }
    
    console.log(`\nFound ${transactionsToEnrich.length} transaction(s) without transfer details`);
    
    let enriched = 0;
    for (const tx of transactionsToEnrich) {
        if (enriched >= maxToEnrich) {
            console.log(`Reached max enrichment limit (${maxToEnrich})`);
            break;
        }
        
        if (getStopSignal()) {
            break;
        }
        
        try {
            console.log(`Enriching transaction at block ${tx.block}...`);
            // Pass the NEAR balance before this block for gas reward calculation
            const nearBalanceBefore = tx.balanceBefore?.near ? BigInt(tx.balanceBefore.near) : undefined;
            const txInfo = await findBalanceChangingTransaction(history.accountId, tx.block, nearBalanceBefore);
            
            if (txInfo && txInfo.transfers && txInfo.transfers.length > 0) {
                tx.transfers = txInfo.transfers;
                enriched++;
                
                // Save progress every 5 enrichments
                if (enriched % 5 === 0) {
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                }
            } else {
                // Mark as attempted even if no transfers found to avoid retrying
                // Set to empty array to indicate we tried but found nothing
                if (!tx.transfers) {
                    tx.transfers = [];
                }
            }
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`Error during enrichment: ${error.message}`);
                break;
            }
            console.log(`Warning: Could not enrich transaction at block ${tx.block}: ${error.message}`);
        }
    }
    
    if (enriched > 0) {
        history.updatedAt = new Date().toISOString();
        saveHistory(outputFile, history);
    }
    
    return enriched;
}

/**
 * Enrich existing transactions with transaction block if missing
 * This fetches the transaction block for transactions that have transactionBlock as null
 */
async function enrichTransactionsWithTransactionBlock(
    history: AccountHistory,
    outputFile: string,
    maxToEnrich: number = 100
): Promise<number> {
    // Find transactions that need transaction block enrichment
    // Only enrich transactions that have actual transaction hashes (not synthetic staking entries)
    const transactionsToEnrich = history.transactions.filter(tx => {
        const needsEnrichment = tx.transactionBlock === null || tx.transactionBlock === undefined;
        const hasTransactionHashes = tx.transactionHashes && tx.transactionHashes.length > 0;
        return needsEnrichment && hasTransactionHashes;
    });
    
    if (transactionsToEnrich.length === 0) {
        console.log('All transactions already have transaction block information');
        return 0;
    }
    
    console.log(`\nFound ${transactionsToEnrich.length} transaction(s) without transaction block information`);
    
    let enriched = 0;
    for (const tx of transactionsToEnrich) {
        if (enriched >= maxToEnrich) {
            console.log(`Reached max enrichment limit (${maxToEnrich})`);
            break;
        }
        
        if (getStopSignal()) {
            break;
        }
        
        try {
            console.log(`Enriching transaction block for block ${tx.block}...`);
            const txInfo = await findBalanceChangingTransaction(history.accountId, tx.block);
            
            if (txInfo && txInfo.transactionBlock !== null && txInfo.transactionBlock !== undefined) {
                tx.transactionBlock = txInfo.transactionBlock;
                enriched++;
                
                // Save progress every 5 enrichments
                if (enriched % 5 === 0) {
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                    console.log(`  Saved progress: ${enriched} transactions enriched...`);
                }
            }
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`Error during enrichment: ${error.message}`);
                break;
            }
            console.log(`Warning: Could not enrich transaction at block ${tx.block}: ${error.message}`);
        }
    }
    
    if (enriched > 0) {
        history.updatedAt = new Date().toISOString();
        saveHistory(outputFile, history);
        console.log(`\nEnriched ${enriched} transaction(s) with transaction block information`);
    }
    
    return enriched;
}

/**
 * Get accounting history for an account
 * 
 * Flow:
 * 1. Load existing history
 * 2. If history exists:
 *    a. Detect gaps (internal gaps, gap to creation, gap to present)
 *    b. Fill internal gaps first (API + binary search for each gap)
 *    c. Look for new data (after lastBlock) - gap to present
 *    d. Look for old data (before firstBlock) - gap to creation  
 * 3. If no history: fetch from APIs first, then binary search
 * 4. Enrichment phase (transfer details, transaction blocks)
 * 5. Staking rewards collection
 */
export async function getAccountHistory(options: GetAccountHistoryOptions): Promise<AccountHistory> {
    const {
        accountId,
        outputFile,
        direction = 'backward',
        startBlock,
        endBlock,
        stakingOnly = false
    } = options;
    
    // maxTransactions: 0 means "unlimited" (fetch all available)
    let maxTransactions = options.maxTransactions === 0 ? Infinity : (options.maxTransactions ?? 100);

    console.log(`\n=== Getting accounting history for ${accountId} ===`);
    console.log(`Direction: ${direction}`);
    console.log(`Output file: ${outputFile}`);
    if (maxTransactions === Infinity) {
        console.log(`Max transactions: unlimited`);
    }
    if (stakingOnly) {
        console.log(`Mode: staking rewards collection only`);
    }

    // Load existing history
    let history = loadExistingHistory(outputFile);
    
    if (!history) {
        history = {
            accountId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            transactions: [],
            metadata: {
                firstBlock: null,
                lastBlock: null,
                totalTransactions: 0
            }
        };
    }

    // Get current block height
    const currentBlock = await getCurrentBlockHeight();
    console.log(`Current block height: ${currentBlock}`);

    let transactionsFound = 0;

    // ===================================================================================
    // CASE 1: Existing history - detect and fill gaps
    // ===================================================================================
    if (history.transactions.length > 0) {
        console.log(`\nLoaded ${history.transactions.length} existing transaction(s)`);
        console.log(`Block range: ${history.metadata.firstBlock} - ${history.metadata.lastBlock}`);
        
        // Early return if stakingOnly mode (only wanted staking rewards)
        if (stakingOnly) {
            const stakingRewards = await collectStakingRewards(accountId, history, outputFile, options.maxEpochsToCheck, endBlock);
            if (stakingRewards > 0) {
                console.log(`\nAdded ${stakingRewards} staking reward entries`);
            }
            return history;
        }

        // Sort transactions before analysis
        history.transactions.sort((a, b) => a.block - b.block);
        
        // Detect gaps using the gap-detection module
        const gapAnalysis = detectGaps(history.transactions);
        
        console.log(`\n=== Gap Analysis ===`);
        console.log(`  Internal gaps: ${gapAnalysis.internalGaps.length}`);
        console.log(`  Gap to creation: ${gapAnalysis.gapToCreation ? 'yes' : 'no'}`);
        console.log(`  Gap to present: ${gapAnalysis.gapToPresent ? 'yes' : 'no'}`);
        console.log(`  History complete: ${gapAnalysis.isComplete}`);

        // -----------------------------------------------------------------------------
        // PHASE 1: Fill internal gaps (highest priority)
        // -----------------------------------------------------------------------------
        if (gapAnalysis.internalGaps.length > 0 && !getStopSignal() && transactionsFound < maxTransactions) {
            console.log(`\n=== Phase 1: Filling ${gapAnalysis.internalGaps.length} internal gap(s) ===`);
            
            for (const gap of gapAnalysis.internalGaps) {
                if (getStopSignal() || transactionsFound >= maxTransactions) break;
                
                const filled = await fillGap(
                    accountId,
                    history,
                    outputFile,
                    gap,
                    Math.min(50, maxTransactions - transactionsFound)
                );
                transactionsFound += filled;
            }
        }

        // -----------------------------------------------------------------------------
        // PHASE 2: Look for new data (after lastBlock) - "gap to present"
        // -----------------------------------------------------------------------------
        if (!getStopSignal() && transactionsFound < maxTransactions) {
            const lastBlock = history.metadata.lastBlock || 0;
            if (lastBlock < currentBlock) {
                console.log(`\n=== Phase 2: Looking for new data (blocks ${lastBlock + 1} - ${currentBlock}) ===`);
                
                // Fetch from APIs with block range constraint
                const newBlocks = await fetchTransactionBlocksFromAPIs(accountId, {
                    afterBlock: lastBlock,
                    beforeBlock: currentBlock + 1,
                    direction: 'forward'
                });
                
                if (newBlocks.length > 0) {
                    console.log(`  Found ${newBlocks.length} potential blocks from APIs`);
                    const apiFound = await processDiscoveredBlocks(
                        accountId,
                        history,
                        outputFile,
                        newBlocks,
                        maxTransactions - transactionsFound
                    );
                    transactionsFound += apiFound;
                }
                
                // Binary search for remaining new data
                if (!getStopSignal() && transactionsFound < maxTransactions) {
                    // Re-analyze to see if there's still a gap
                    history.transactions.sort((a, b) => a.block - b.block);
                    const newLastBlock = history.metadata.lastBlock || 0;
                    
                    if (newLastBlock < currentBlock - 1) {
                        const found = await searchForTransactions(
                            accountId,
                            history,
                            outputFile,
                            newLastBlock + 1,
                            currentBlock,
                            'forward',
                            Math.min(50, maxTransactions - transactionsFound),
                            currentBlock  // pass current block height to cap forward search
                        );
                        transactionsFound += found;
                    }
                }
            }
        }

        // -----------------------------------------------------------------------------
        // PHASE 3: Look for old data (before firstBlock) - "gap to creation"
        // -----------------------------------------------------------------------------
        if (!getStopSignal() && transactionsFound < maxTransactions && direction === 'backward') {
            const firstBlock = history.metadata.firstBlock || currentBlock;
            
            // Check if the earliest transaction has non-zero balance before
            // (indicating there's history before it)
            const sortedTxs = [...history.transactions].sort((a, b) => a.block - b.block);
            const earliestTx = sortedTxs.find(tx => !isStakingOnlyEntry(tx));
            
            // Use gapToCreation or user-specified range
            const hasGapToCreation = gapAnalysis.gapToCreation !== null;
            const searchEndBlock = startBlock || firstBlock - 1;
            const searchStartBlock = endBlock || Math.max(0, searchEndBlock - 1000000);
            
            if (hasGapToCreation || (searchEndBlock > 0 && searchEndBlock > searchStartBlock)) {
                console.log(`\n=== Phase 3: Looking for old data (blocks ${searchStartBlock} - ${searchEndBlock}) ===`);
                
                // Fetch from APIs with block range constraint
                const oldBlocks = await fetchTransactionBlocksFromAPIs(accountId, {
                    afterBlock: searchStartBlock > 0 ? searchStartBlock - 1 : undefined,
                    beforeBlock: searchEndBlock + 1,
                    direction: 'backward'
                });
                
                if (oldBlocks.length > 0) {
                    console.log(`  Found ${oldBlocks.length} potential blocks from APIs`);
                    const apiFound = await processDiscoveredBlocks(
                        accountId,
                        history,
                        outputFile,
                        oldBlocks,
                        maxTransactions - transactionsFound
                    );
                    transactionsFound += apiFound;
                }
                
                // Binary search for remaining old data
                if (!getStopSignal() && transactionsFound < maxTransactions) {
                    // Re-check first block after API processing
                    history.transactions.sort((a, b) => a.block - b.block);
                    const newFirstBlock = history.metadata.firstBlock || currentBlock;
                    
                    if (newFirstBlock > searchStartBlock) {
                        const found = await searchForTransactions(
                            accountId,
                            history,
                            outputFile,
                            searchStartBlock,
                            newFirstBlock - 1,
                            'backward',
                            Math.min(50, maxTransactions - transactionsFound)
                        );
                        transactionsFound += found;
                    }
                }
            }
        }
    }
    // ===================================================================================
    // CASE 2: No existing history - full discovery
    // ===================================================================================
    else {
        console.log(`\nNo existing history found. Starting full discovery...`);
        
        if (stakingOnly) {
            // For staking-only mode, we need at least one transaction to anchor staking collection
            console.log(`Staking-only mode requires existing history. Fetching initial data...`);
        }
        
        // Determine search range
        const searchEndBlock = startBlock || currentBlock;
        const searchStartBlock = endBlock || Math.max(0, searchEndBlock - 1000000);
        
        console.log(`Search range: ${searchStartBlock} - ${searchEndBlock}`);
        
        // Fetch from all APIs (no range constraint for initial discovery)
        console.log(`\n=== Fetching transaction data from APIs ===`);
        const allBlocks = await fetchTransactionBlocksFromAPIs(accountId, {
            afterBlock: searchStartBlock > 0 ? searchStartBlock - 1 : undefined,
            beforeBlock: searchEndBlock + 1,
            maxBlocks: maxTransactions === Infinity ? undefined : maxTransactions * 2,
            direction
        });
        
        if (allBlocks.length > 0) {
            console.log(`\nTotal: ${allBlocks.length} blocks from APIs`);
            const apiFound = await processDiscoveredBlocks(
                accountId,
                history,
                outputFile,
                allBlocks,
                maxTransactions
            );
            transactionsFound += apiFound;
        }
        
        // Binary search for additional transactions
        if (!getStopSignal() && transactionsFound < maxTransactions) {
            // Determine remaining search range based on what we found
            let binarySearchStart: number, binarySearchEnd: number;
            
            if (history.transactions.length > 0) {
                if (direction === 'backward') {
                    binarySearchEnd = history.metadata.firstBlock! - 1;
                    binarySearchStart = searchStartBlock;
                } else {
                    binarySearchStart = history.metadata.lastBlock! + 1;
                    binarySearchEnd = searchEndBlock;
                }
            } else {
                binarySearchStart = searchStartBlock;
                binarySearchEnd = searchEndBlock;
            }
            
            if (binarySearchStart <= binarySearchEnd) {
                console.log(`\n=== Binary search: blocks ${binarySearchStart} - ${binarySearchEnd} ===`);
                const found = await searchForTransactions(
                    accountId,
                    history,
                    outputFile,
                    binarySearchStart,
                    binarySearchEnd,
                    direction,
                    maxTransactions - transactionsFound,
                    currentBlock  // pass current block height to cap forward search
                );
                transactionsFound += found;
            }
        }
    }

    // ===================================================================================
    // PHASE 4: Enrichment (transfer details, transaction blocks)
    // ===================================================================================
    if (!stakingOnly && !getStopSignal() && history.transactions.length > 0) {
        // Enrich with transaction blocks if missing
        const missingTxBlocks = history.transactions.filter(tx => 
            (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
            tx.transactionHashes && tx.transactionHashes.length > 0
        ).length;
        
        if (missingTxBlocks > 0) {
            console.log(`\nFound ${missingTxBlocks} transaction(s) without transaction block info`);
            const enriched = await enrichTransactionsWithTransactionBlock(history, outputFile, 10);
            if (enriched > 0) {
                console.log(`Enriched ${enriched} transaction blocks`);
            }
        }
        
        // Enrich with transfer details if missing
        const enriched = await enrichTransactionsWithTransfers(history, outputFile, 50);
        if (enriched > 0) {
            console.log(`\nEnriched ${enriched} transaction(s) with transfer details`);
        }
    }

    // ===================================================================================
    // PHASE 5: Staking rewards collection
    // ===================================================================================
    if (!getStopSignal() && history.transactions.length > 0) {
        const stakingRewards = await collectStakingRewards(accountId, history, outputFile, options.maxEpochsToCheck, endBlock);
        if (stakingRewards > 0) {
            console.log(`\nAdded ${stakingRewards} staking reward entries`);
        }
    }

    // Final sort and save
    history.transactions.sort((a, b) => a.block - b.block);
    saveHistory(outputFile, history);
    
    console.log(`\n=== Export complete ===`);
    console.log(`Total transactions: ${history.metadata.totalTransactions}`);
    console.log(`Block range: ${history.metadata.firstBlock} - ${history.metadata.lastBlock}`);
    console.log(`Output saved to: ${outputFile}`);

    return history;
}

/**
 * Binary search for transactions in a block range.
 * Returns the number of transactions found and added.
 */
async function searchForTransactions(
    accountId: string,
    history: AccountHistory,
    outputFile: string,
    searchStart: number,
    searchEnd: number,
    direction: 'forward' | 'backward',
    maxTransactions: number,
    currentBlockHeight?: number
): Promise<number> {
    let transactionsFound = 0;
    let currentStart = searchStart;
    let currentEnd = searchEnd;
    const initialRangeSize = searchEnd - searchStart;
    let currentRangeSize = initialRangeSize;
    const maxRangeSize = Math.max(initialRangeSize * 32, 32000000);
    
    // For forward search, use provided currentBlockHeight or get it once
    const blockHeightLimit = direction === 'forward' 
        ? (currentBlockHeight || await getCurrentBlockHeight())
        : undefined;
    
    while (transactionsFound < maxTransactions && !getStopSignal()) {
        // Validate range
        if (direction === 'backward' && currentEnd < 0) break;
        if (direction === 'forward' && currentStart > currentEnd) break;
        // For forward search, stop if we've reached the current block
        if (direction === 'forward' && blockHeightLimit && currentStart >= blockHeightLimit) break;
        
        console.log(`  Searching blocks ${currentStart} - ${currentEnd}...`);
        
        // Clear cache periodically
        if (transactionsFound % 10 === 0) {
            clearBalanceCache();
        }
        
        // Check account existence when searching backward
        if (direction === 'backward') {
            try {
                const exists = await accountExistsAtBlock(accountId, currentStart);
                if (!exists) {
                    console.log(`  Account doesn't exist at block ${currentStart} - reached beginning`);
                    history.metadata.historyComplete = true;
                    saveHistory(outputFile, history);
                    break;
                }
            } catch (error: any) {
                if (error.message.includes('rate limit') || error.message.includes('cancelled')) {
                    saveHistory(outputFile, history);
                    break;
                }
            }
        }
        
        let balanceChange: BalanceChanges;
        try {
            balanceChange = await findLatestBalanceChangingBlock(accountId, currentStart, currentEnd);
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('cancelled')) {
                saveHistory(outputFile, history);
                break;
            }
            if (error.message.includes('does not exist')) {
                if (direction === 'backward') {
                    history.metadata.historyComplete = true;
                }
                saveHistory(outputFile, history);
                break;
            }
            throw error;
        }
        
        if (!balanceChange.hasChanges || !balanceChange.block) {
            // No changes found - expand range
            if (currentRangeSize < maxRangeSize) {
                currentRangeSize = Math.min(currentRangeSize * 2, maxRangeSize);
            }
            
            if (direction === 'backward') {
                currentEnd = currentStart - 1;
                currentStart = Math.max(0, currentEnd - currentRangeSize);
            } else {
                currentStart = currentEnd + 1;
                // Cap at current block height to avoid searching future blocks
                if (blockHeightLimit) {
                    currentEnd = Math.min(currentStart + currentRangeSize, blockHeightLimit);
                } else {
                    currentEnd = currentStart + currentRangeSize;
                }
                // If we've already searched up to the current block, stop
                if (currentStart >= currentEnd) {
                    console.log(`  Reached current block height (${blockHeightLimit}) - stopping forward search`);
                    break;
                }
            }
            
            saveHistory(outputFile, history);
            continue;
        }
        
        // Reset range size when we find something
        currentRangeSize = initialRangeSize;
        
        // Check for duplicate
        const existingEntry = history.transactions.find(t => t.block === balanceChange.block);
        if (existingEntry) {
            if (direction === 'backward') {
                currentEnd = balanceChange.block! - 1;
            } else {
                currentStart = balanceChange.block! + 1;
            }
            continue;
        }
        
        // Find transaction details
        const txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block);
        
        // Extract FT and intents tokens from discovered transfers and enrich balance snapshots
        const discoveredTokens = extractTokensFromTransfers(txInfo.transfers);
        await enrichBalancesWithDiscoveredTokens(accountId, balanceChange.block, balanceChange, discoveredTokens);
        
        // Create and add entry
        const entry: TransactionEntry = {
            block: balanceChange.block,
            transactionBlock: txInfo.transactionBlock,
            timestamp: txInfo.blockTimestamp,
            transactionHashes: txInfo.transactionHashes,
            transactions: txInfo.transactions,
            transfers: txInfo.transfers,
            balanceBefore: balanceChange.startBalance,
            balanceAfter: balanceChange.endBalance,
            changes: {
                nearChanged: balanceChange.nearChanged,
                nearDiff: balanceChange.nearDiff,
                tokensChanged: balanceChange.tokensChanged,
                intentsChanged: balanceChange.intentsChanged
            }
        };

        // Enrich with staking pool balances if this is a staking deposit/withdrawal
        await enrichWithStakingPoolBalances(accountId, entry);

        history.transactions.push(entry);
        transactionsFound++;
        
        console.log(`    Found transaction at block ${balanceChange.block}`);
        
        // Update metadata
        const allBlocks = history.transactions.map(t => t.block);
        history.metadata.firstBlock = Math.min(...allBlocks);
        history.metadata.lastBlock = Math.max(...allBlocks);
        history.metadata.totalTransactions = history.transactions.length;
        
        // Update search range
        if (direction === 'backward') {
            currentEnd = balanceChange.block - 1;
        } else {
            currentStart = balanceChange.block + 1;
        }
        
        // Save periodically
        if (transactionsFound % 5 === 0) {
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
        }
    }
    
    return transactionsFound;
}

/**
 * Verify an existing history file
 */
export function verifyHistoryFile(filePath: string): VerificationResults {
    const history = loadExistingHistory(filePath);
    
    if (!history) {
        return { valid: false, error: 'Could not load history file', totalTransactions: 0, verifiedCount: 0, errorCount: 0, errors: [] };
    }

    const results: VerificationResults = {
        valid: true,
        totalTransactions: history.transactions.length,
        verifiedCount: 0,
        errorCount: 0,
        errors: []
    };

    // Sort transactions by block and filter out staking-only entries
    // Staking-only entries don't track NEAR/FT/intents balances, so they shouldn't affect connectivity verification
    const sortedTransactions = [...history.transactions]
        .filter(tx => !isStakingOnlyEntry(tx))
        .sort((a, b) => a.block - b.block);

    for (let i = 1; i < sortedTransactions.length; i++) {
        const prevTx = sortedTransactions[i - 1];
        const currTx = sortedTransactions[i];

        if (prevTx && currTx) {
            const verification = verifyTransactionConnectivity(currTx, prevTx);
            results.verifiedCount++;

            if (!verification.valid) {
                results.valid = false;
                results.errorCount++;
                results.errors.push({
                    previousBlock: prevTx.block,
                    currentBlock: currTx.block,
                    errors: verification.errors
                });
            }
        }
    }

    return results;
}

/**
 * Fetch block timestamp from the blockchain
 * Tries neardata.xyz first, then falls back to standard RPC
 */
async function fetchBlockTimestamp(blockHeight: number): Promise<number | null> {
    try {
        // Try neardata.xyz first (faster and provides more data)
        const neardataBlock = await fetchNeardataBlock(blockHeight);
        if (neardataBlock?.block?.header?.timestamp) {
            return neardataBlock.block.header.timestamp;
        }

        // Fallback to standard RPC
        const blockData = await fetchBlockData(blockHeight);
        if (blockData?.header?.timestamp) {
            return blockData.header.timestamp;
        }
    } catch (error: any) {
        console.warn(`Could not fetch timestamp for block ${blockHeight}: ${error.message}`);
    }
    return null;
}

/**
 * Enrich existing history with missing timestamps
 * Fetches timestamps from the blockchain for transactions that don't have them
 */
async function enrichTimestamps(
    history: AccountHistory,
    outputFile: string
): Promise<number> {
    // Find transactions with missing timestamps
    const transactionsNeedingTimestamps = history.transactions.filter(t => t.timestamp === null);
    
    if (transactionsNeedingTimestamps.length === 0) {
        console.log('All transactions already have timestamps');
        return 0;
    }

    console.log(`Found ${transactionsNeedingTimestamps.length} transactions with missing timestamps`);
    
    let enrichedCount = 0;
    
    for (let i = 0; i < transactionsNeedingTimestamps.length; i++) {
        if (getStopSignal()) {
            console.log('Stop signal received, saving progress...');
            break;
        }

        const transaction = transactionsNeedingTimestamps[i];
        if (!transaction) continue;

        console.log(`Fetching timestamp for block ${transaction.block} (${i + 1}/${transactionsNeedingTimestamps.length})...`);
        
        const timestamp = await fetchBlockTimestamp(transaction.block);
        
        if (timestamp !== null) {
            transaction.timestamp = timestamp;
            enrichedCount++;
            
            // Save progress periodically
            if (enrichedCount % 10 === 0) {
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
                console.log(`Progress saved (${enrichedCount} timestamps fetched)`);
            }
        } else {
            console.warn(`Could not fetch timestamp for block ${transaction.block}`);
        }
    }

    // Final save
    if (enrichedCount > 0) {
        history.updatedAt = new Date().toISOString();
        saveHistory(outputFile, history);
    }

    return enrichedCount;
}

/**
 * Parse command line arguments
 */
function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    const options: ParsedArgs = {
        accountId: null,
        outputFile: null,
        direction: 'backward',
        maxTransactions: 100,
        startBlock: null,
        endBlock: null,
        verify: false,
        fillGapsOnly: false,
        enrich: false,
        stakingOnly: false,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        let arg = args[i];
        let value: string | undefined;
        
        // Handle --option=value style arguments
        if (arg && arg.includes('=')) {
            const [key, val] = arg.split('=', 2);
            arg = key;
            value = val;
        }
        
        switch (arg) {
            case '--account':
            case '-a':
                if (value !== undefined) {
                    options.accountId = value;
                } else if (args[i + 1]) {
                    options.accountId = args[++i] ?? null;
                }
                break;
            case '--output':
            case '-o':
                if (value !== undefined) {
                    options.outputFile = value;
                } else if (args[i + 1]) {
                    options.outputFile = args[++i] ?? null;
                }
                break;
            case '--direction':
            case '-d':
                if (value !== undefined) {
                    options.direction = value as 'forward' | 'backward';
                } else if (args[i + 1]) {
                    options.direction = args[++i] as 'forward' | 'backward';
                }
                break;
            case '--max':
            case '-m':
                if (value !== undefined) {
                    options.maxTransactions = parseInt(value, 10);
                } else if (args[i + 1]) {
                    options.maxTransactions = parseInt(args[++i]!, 10);
                }
                break;
            case '--start-block':
                if (value !== undefined) {
                    options.startBlock = parseInt(value, 10);
                } else if (args[i + 1]) {
                    options.startBlock = parseInt(args[++i]!, 10);
                }
                break;
            case '--end-block':
                if (value !== undefined) {
                    options.endBlock = parseInt(value, 10);
                } else if (args[i + 1]) {
                    options.endBlock = parseInt(args[++i]!, 10);
                }
                break;
            case '--verify':
            case '-v':
                options.verify = true;
                break;
            case '--fill-gaps':
            case '--fill-gaps-only':
                options.fillGapsOnly = true;
                break;
            case '--enrich':
                options.enrich = true;
                break;
            case '--staking':
                options.stakingOnly = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                // If not a flag, treat as account ID
                if (arg && !arg.startsWith('-') && !options.accountId) {
                    options.accountId = arg ?? null;
                }
        }
    }

    return options;
}

/**
 * Print help message
 */
function printHelp(): void {
    console.log(`
NEAR Accounting Export - Get account transaction history

Usage:
  node get-account-history.js [options] <account-id>

Options:
  -a, --account <id>      NEAR account ID to fetch history for
  -o, --output <file>     Output file path (default: <account-id>.json)
  -d, --direction <dir>   Search direction: 'forward' or 'backward' (default: backward)
  -m, --max <number>      Maximum transactions to fetch (default: 100)
  --start-block <number>  Starting block height
  --end-block <number>    Ending block height
  -v, --verify            Verify an existing history file
  --fill-gaps-only        Only fill gaps in existing history, don't search for new transactions
  --enrich                Enrich existing history with missing timestamps and transfer details
  --staking               Only collect staking reward entries (no enrichment or new transactions)
  -h, --help              Show this help message

Environment Variables:
  NEAR_RPC_ENDPOINT       RPC endpoint URL (default: https://archival-rpc.mainnet.fastnear.com)
  RPC_DELAY_MS            Delay between RPC calls in ms (default: 50)

Behavior:
  The script automatically detects and fills gaps in existing transaction history where
  balance connectivity is broken. After filling gaps, it continues searching for new
  balance changes in adjacent ranges. When no changes are found, it moves to the next
  adjacent range of equal size. It continues until interrupted (Ctrl+C), rate limited,
  max transactions reached, or endpoint becomes unresponsive. Progress is saved continuously.

Examples:
  # Fetch last 50 transactions for an account
  node get-account-history.js --account myaccount.near --max 50

  # Continue fetching backward from existing file (fills gaps automatically)
  node get-account-history.js --account myaccount.near --output ./history.json

  # Only fill gaps in existing history without searching for new transactions
  node get-account-history.js --fill-gaps-only --output ./history.json

  # Fetch forward from a specific block
  node get-account-history.js -a myaccount.near --direction forward --start-block 100000000

  # Verify an existing history file
  node get-account-history.js --verify --output ./history.json
`);
}

// Main execution
async function main(): Promise<void> {
    const options = parseArgs();

    if (options.help) {
        printHelp();
        process.exit(0);
    }

    if (options.verify && options.outputFile) {
        console.log(`Verifying history file: ${options.outputFile}`);
        const results = verifyHistoryFile(options.outputFile);
        console.log('\nVerification Results:');
        console.log(`  Total transactions: ${results.totalTransactions}`);
        console.log(`  Verified: ${results.verifiedCount}`);
        console.log(`  Errors: ${results.errorCount}`);
        
        if (!results.valid) {
            console.log('\nErrors found:');
            results.errors.forEach(err => {
                console.log(`  Block ${err.previousBlock} -> ${err.currentBlock}:`);
                err.errors.forEach(e => console.log(`    - ${e.message}`));
            });
            process.exit(1);
        } else {
            console.log('\nAll transactions verified successfully!');
            process.exit(0);
        }
    }

    if (options.fillGapsOnly && options.outputFile) {
        console.log(`Filling gaps in history file: ${options.outputFile}`);
        
        const history = loadExistingHistory(options.outputFile);
        if (!history) {
            console.error('Error: No existing history file found');
            process.exit(1);
        }
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nReceived SIGINT, stopping gracefully...');
            setStopSignal(true);
        });

        process.on('SIGTERM', () => {
            console.log('\nReceived SIGTERM, stopping gracefully...');
            setStopSignal(true);
        });
        
        try {
            const filled = await fillGaps(history, options.outputFile, options.maxTransactions);
            console.log(`\n=== Gap filling complete ===`);
            console.log(`Total gaps filled: ${filled}`);
            process.exit(0);
        } catch (error: any) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }

    if (options.enrich && options.outputFile) {
        console.log(`Enriching history file with timestamps: ${options.outputFile}`);
        
        const history = loadExistingHistory(options.outputFile);
        if (!history) {
            console.error('Error: No existing history file found');
            process.exit(1);
        }
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            console.log('\nReceived SIGINT, stopping gracefully...');
            setStopSignal(true);
        });

        process.on('SIGTERM', () => {
            console.log('\nReceived SIGTERM, stopping gracefully...');
            setStopSignal(true);
        });
        
        try {
            const timestampsAdded = await enrichTimestamps(history, options.outputFile);
            console.log(`Total timestamps added: ${timestampsAdded}`);
            
            // Enrich transaction blocks
            console.log(`\nEnriching transaction blocks...`);
            const transactionBlocksEnriched = await enrichTransactionsWithTransactionBlock(history, options.outputFile, options.maxTransactions);
            console.log(`Total transaction blocks enriched: ${transactionBlocksEnriched}`);
            
            // Also enrich transfer details
            console.log(`\nEnriching transfer details...`);
            const transfersEnriched = await enrichTransactionsWithTransfers(history, options.outputFile, options.maxTransactions);
            console.log(`Total transfers enriched: ${transfersEnriched}`);
            
            console.log(`\n=== Enrichment complete ===`);
            process.exit(0);
        } catch (error: any) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    }

    if (!options.accountId) {
        console.error('Error: Account ID is required');
        printHelp();
        process.exit(1);
    }

    // Set default output file
    if (!options.outputFile) {
        options.outputFile = `${options.accountId}.json`;
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\nReceived SIGINT, stopping gracefully...');
        setStopSignal(true);
    });

    process.on('SIGTERM', () => {
        console.log('\nReceived SIGTERM, stopping gracefully...');
        setStopSignal(true);
    });

    try {
        await getAccountHistory(options as GetAccountHistoryOptions);
    } catch (error: any) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
