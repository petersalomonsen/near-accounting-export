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
    findStakingBalanceChanges
} from './balance-tracker.js';
import {
    getAllTransactionBlocks,
    isNearBlocksAvailable
} from './nearblocks-api.js';
import {
    getAllIntentsTransactionBlocks,
    isIntentsExplorerAvailable
} from './intents-explorer-api.js';
import type { BalanceSnapshot, BalanceChanges, TransactionInfo, TransferDetail, StakingBalanceChange } from './balance-tracker.js';
import type { TransactionBlock } from './nearblocks-api.js';
import type { IntentsTransactionBlock } from './intents-explorer-api.js';

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
    verificationWithNext?: VerificationResult;
    verificationWithPrevious?: VerificationResult;
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

interface GetAccountHistoryOptions {
    accountId: string;
    outputFile: string;
    direction?: 'forward' | 'backward';
    maxTransactions?: number;
    startBlock?: number;
    endBlock?: number;
    stakingOnly?: boolean;
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
 * Collect staking reward entries between transactions
 * Creates synthetic transaction entries for staking balance changes at epoch boundaries
 * Only checks epochs where staking was active (between first deposit and full withdrawal)
 */
async function collectStakingRewards(
    accountId: string,
    history: AccountHistory,
    outputFile: string
): Promise<number> {
    const poolRanges = discoverStakingPoolsWithRanges(history);
    
    if (poolRanges.length === 0) {
        console.log('No staking pools discovered from transaction history');
        return 0;
    }
    
    const stakingPools = poolRanges.map(r => r.pool);
    console.log(`\nDiscovered staking pools: ${stakingPools.join(', ')}`);
    history.stakingPools = stakingPools;
    
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
                // Partial withdrawal - still active, check to current latest transaction
                const sortedTxs = [...history.transactions].sort((a, b) => b.block - a.block);
                endBlock = sortedTxs[0]?.block || range.lastWithdrawalBlock;
                console.log(`  ${range.pool}: active from block ${range.firstDepositBlock} to ${endBlock} (still staking)`);
            }
        } else {
            // No withdrawals yet - check to current latest transaction
            const sortedTxs = [...history.transactions].sort((a, b) => b.block - a.block);
            endBlock = sortedTxs[0]?.block || range.firstDepositBlock;
            console.log(`  ${range.pool}: active from block ${range.firstDepositBlock} to ${endBlock} (no withdrawals)`);
        }
        
        activeRanges.push({
            pool: range.pool,
            startBlock: range.firstDepositBlock,
            endBlock
        });
    }
    
    // Find all staking balance changes at epoch boundaries for each pool's active range
    let allChanges: StakingBalanceChange[] = [];
    
    for (const range of activeRanges) {
        console.log(`\nChecking staking balance changes for ${range.pool}...`);
        console.log(`  Block range: ${range.startBlock} - ${range.endBlock}`);
        
        const poolChanges = await findStakingBalanceChanges(
            accountId,
            range.startBlock,
            range.endBlock,
            [range.pool]
        );
        
        allChanges = allChanges.concat(poolChanges);
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
        return 0;
    }
    
    console.log(`Creating ${rewardChanges.length} staking reward entries...`);
    
    // Create synthetic transaction entries for staking rewards
    let addedCount = 0;
    for (const change of rewardChanges) {
        if (getStopSignal()) {
            break;
        }
        
        // Get all staking pool balances at this block and the previous
        const balancesBefore = await getStakingPoolBalances(accountId, change.block - 1, stakingPools);
        const balancesAfter = await getStakingPoolBalances(accountId, change.block, stakingPools);
        
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

/**
 * Detect gaps in transaction history where balance connectivity is broken
 */
function detectGaps(history: AccountHistory): Array<{ prevBlock: number; nextBlock: number; prevTx: TransactionEntry; nextTx: TransactionEntry }> {
    const gaps: Array<{ prevBlock: number; nextBlock: number; prevTx: TransactionEntry; nextTx: TransactionEntry }> = [];
    
    if (history.transactions.length < 2) {
        return gaps;
    }
    
    // Sort transactions by block and filter out staking-only entries
    // Staking-only entries are synthetic (no actual on-chain tx) and don't track NEAR/FT/intents balances
    const sortedTransactions = [...history.transactions]
        .filter(tx => !isStakingOnlyEntry(tx))
        .sort((a, b) => a.block - b.block);
    
    for (let i = 1; i < sortedTransactions.length; i++) {
        const prevTx = sortedTransactions[i - 1];
        const currTx = sortedTransactions[i];
        
        if (prevTx && currTx) {
            const verification = verifyTransactionConnectivity(currTx, prevTx);
            
            if (!verification.valid) {
                gaps.push({
                    prevBlock: prevTx.block,
                    nextBlock: currTx.block,
                    prevTx,
                    nextTx: currTx
                });
            }
        }
    }
    
    return gaps;
}

/**
 * Fill gaps in transaction history
 */
async function fillGaps(
    history: AccountHistory,
    outputFile: string,
    maxTransactionsToFill: number = 50
): Promise<number> {
    const gaps = detectGaps(history);
    
    if (gaps.length === 0) {
        console.log('No gaps detected in transaction history');
        return 0;
    }
    
    console.log(`\n=== Detected ${gaps.length} gap(s) in transaction history ===`);
    let totalFilled = 0;
    
    for (const gap of gaps) {
        if (getStopSignal() || totalFilled >= maxTransactionsToFill) {
            break;
        }
        
        console.log(`\nFilling gap between blocks ${gap.prevBlock} and ${gap.nextBlock}...`);
        
        // Note: We start from gap.prevBlock (not +1) because the change we're looking for
        // could have happened at the block right after prevBlock. The balance at prevBlock
        // is known (from prevTx.balanceAfter), so we need to compare from that point.
        const searchStart = gap.prevBlock;
        const searchEnd = gap.nextBlock - 1;
        
        if (searchStart > searchEnd) {
            console.log('Gap is adjacent blocks, no intermediate transactions');
            continue;
        }
        
        // Extract tokens that changed in this gap to pass to the search
        // This ensures we look for the right tokens, especially intents tokens
        const prevBalanceAfter = gap.prevTx.balanceAfter;
        const nextBalanceBefore = gap.nextTx.balanceBefore;
        
        // Check if NEAR balance changed
        const checkNear = prevBalanceAfter?.near !== nextBalanceBefore?.near;
        
        // Find fungible tokens that changed
        const changedFungibleTokens: string[] = [];
        const prevFT = prevBalanceAfter?.fungibleTokens || {};
        const nextFT = nextBalanceBefore?.fungibleTokens || {};
        const allFT = new Set([...Object.keys(prevFT), ...Object.keys(nextFT)]);
        for (const token of allFT) {
            if ((prevFT[token] || '0') !== (nextFT[token] || '0')) {
                changedFungibleTokens.push(token);
            }
        }
        
        // Find intents tokens that changed
        const changedIntentsTokens: string[] = [];
        const prevIntents = prevBalanceAfter?.intentsTokens || {};
        const nextIntents = nextBalanceBefore?.intentsTokens || {};
        const allIntents = new Set([...Object.keys(prevIntents), ...Object.keys(nextIntents)]);
        for (const token of allIntents) {
            if ((prevIntents[token] || '0') !== (nextIntents[token] || '0')) {
                changedIntentsTokens.push(token);
            }
        }
        
        console.log(`Gap analysis: NEAR changed=${checkNear}, FT changed=${changedFungibleTokens.length > 0 ? changedFungibleTokens.join(',') : 'none'}, Intents changed=${changedIntentsTokens.length > 0 ? changedIntentsTokens.join(',') : 'none'}`);
        
        let currentStart = searchStart;
        let currentEnd = searchEnd;
        let foundInGap = 0;
        
        // Keep track of the current "previous" balance for recalculating changes
        let currentPrevBalanceAfter = prevBalanceAfter;
        
        while (currentStart <= currentEnd && foundInGap < maxTransactionsToFill - totalFilled) {
            if (getStopSignal()) {
                break;
            }
            
            // Recalculate what changed between currentPrevBalanceAfter and nextBalanceBefore
            // This is important because after finding a transaction, the remaining gap may have different changes
            const recalcCheckNear = currentPrevBalanceAfter?.near !== nextBalanceBefore?.near;
            
            const recalcChangedFungibleTokens: string[] = [];
            const recalcPrevFT = currentPrevBalanceAfter?.fungibleTokens || {};
            const recalcAllFT = new Set([...Object.keys(recalcPrevFT), ...Object.keys(nextFT)]);
            for (const token of recalcAllFT) {
                if ((recalcPrevFT[token] || '0') !== (nextFT[token] || '0')) {
                    recalcChangedFungibleTokens.push(token);
                }
            }
            
            const recalcChangedIntentsTokens: string[] = [];
            const recalcPrevIntents = currentPrevBalanceAfter?.intentsTokens || {};
            const recalcAllIntents = new Set([...Object.keys(recalcPrevIntents), ...Object.keys(nextIntents)]);
            for (const token of recalcAllIntents) {
                if ((recalcPrevIntents[token] || '0') !== (nextIntents[token] || '0')) {
                    recalcChangedIntentsTokens.push(token);
                }
            }
            
            // If nothing changed anymore, we've filled all gaps
            if (!recalcCheckNear && recalcChangedFungibleTokens.length === 0 && recalcChangedIntentsTokens.length === 0) {
                console.log('No more changes detected in remaining gap range');
                break;
            }
            
            console.log(`Searching in range ${currentStart} - ${currentEnd}... (NEAR=${recalcCheckNear}, FT=${recalcChangedFungibleTokens.length}, Intents=${recalcChangedIntentsTokens.length})`);
            
            let balanceChange: BalanceChanges;
            try {
                balanceChange = await findLatestBalanceChangingBlock(
                    history.accountId,
                    currentStart,
                    currentEnd,
                    recalcChangedFungibleTokens.length > 0 ? recalcChangedFungibleTokens : null,
                    recalcChangedIntentsTokens.length > 0 ? recalcChangedIntentsTokens : null,
                    recalcCheckNear
                );
            } catch (error: any) {
                if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                    console.log(`Error during gap fill: ${error.message}`);
                    break;
                }
                throw error;
            }
            
            if (!balanceChange.hasChanges) {
                console.log('No balance changes found in gap range');
                break;
            }
            
            if (!balanceChange.block) {
                console.log('Balance change has no block number');
                break;
            }
            
            // Find the transaction that caused the change
            const txInfo = await findBalanceChangingTransaction(history.accountId, balanceChange.block);
            
            if (!txInfo) {
                console.log(`Could not find transaction at block ${balanceChange.block}`);
                currentEnd = balanceChange.block - 1;
                continue;
            }
            
            // Check for duplicate before adding
            const existingEntry = history.transactions.find(t => t.block === balanceChange.block);
            if (existingEntry) {
                console.log(`Skipping duplicate entry at block ${balanceChange.block}`);
                currentEnd = balanceChange.block - 1;
                continue;
            }
            
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
            
            // Add to history
            history.transactions.push(entry);
            foundInGap++;
            totalFilled++;
            
            console.log(`Gap transaction ${foundInGap} added at block ${balanceChange.block}`);
            
            // Update metadata
            if (!history.metadata.firstBlock || balanceChange.block < history.metadata.firstBlock) {
                history.metadata.firstBlock = balanceChange.block;
            }
            if (!history.metadata.lastBlock || balanceChange.block > history.metadata.lastBlock) {
                history.metadata.lastBlock = balanceChange.block;
            }
            history.metadata.totalTransactions = history.transactions.length;
            
            // Save progress
            if (foundInGap % 5 === 0) {
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
            }
            
            // Update the "previous" balance for the next iteration
            // This is the balance AFTER the transaction we just found
            currentPrevBalanceAfter = balanceChange.endBalance;
            
            // Search for more in the remaining range
            currentEnd = balanceChange.block - 1;
        }
        
        // Save after filling each gap
        history.updatedAt = new Date().toISOString();
        saveHistory(outputFile, history);
        console.log(`Filled ${foundInGap} transaction(s) in this gap`);
    }
    
    // After filling gaps, re-verify all transactions and update verification fields
    if (totalFilled > 0) {
        updateVerificationFields(history);
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
 * Update verification fields on all transactions after sorting
 */
function updateVerificationFields(history: AccountHistory): void {
    // Sort transactions by block
    history.transactions.sort((a, b) => a.block - b.block);
    
    // Update verificationWithNext for each transaction
    for (let i = 0; i < history.transactions.length - 1; i++) {
        const currentTx = history.transactions[i];
        const nextTx = history.transactions[i + 1];
        
        if (currentTx && nextTx) {
            currentTx.verificationWithNext = verifyTransactionConnectivity(nextTx, currentTx);
        }
    }
    
    // Clear verificationWithNext on the last transaction
    const lastTx = history.transactions[history.transactions.length - 1];
    if (lastTx) {
        delete lastTx.verificationWithNext;
    }
}

/**
 * Get accounting history for an account
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
    
    let maxTransactions = options.maxTransactions ?? 100;  // Use ?? to allow 0

    console.log(`\n=== Getting accounting history for ${accountId} ===`);
    console.log(`Direction: ${direction}`);
    console.log(`Output file: ${outputFile}`);
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

    // Check for and fill any gaps in existing history
    if (history.transactions.length > 0) {
        console.log(`\nLoaded ${history.transactions.length} existing transaction(s)`);
        const gapsFilled = await fillGaps(history, outputFile, Math.min(50, maxTransactions));
        if (gapsFilled > 0) {
            console.log(`\nFilled ${gapsFilled} transaction(s) in gaps`);
            // Reduce max transactions by the number we just filled
            maxTransactions = Math.max(0, maxTransactions - gapsFilled);
            if (maxTransactions === 0) {
                console.log('Reached max transactions limit while filling gaps');
                return history;
            }
        } else {
            // Even if no gaps were filled, update verification fields to fix any stale data
            updateVerificationFields(history);
            saveHistory(outputFile, history);
        }
        
        // Skip enrichment if stakingOnly mode
        if (!stakingOnly) {
            // Enrich existing transactions with transaction blocks if missing
            const missingTransactionBlocks = history.transactions.filter(tx => 
                (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
                tx.transactionHashes && tx.transactionHashes.length > 0
            ).length;
            
            if (missingTransactionBlocks > 0) {
                console.log(`\nFound ${missingTransactionBlocks} transaction(s) without transaction block information`);
                const txBlocksEnriched = await enrichTransactionsWithTransactionBlock(history, outputFile, 10);
                if (txBlocksEnriched > 0) {
                    console.log(`Enriched ${txBlocksEnriched} transaction blocks. Run again to enrich more.`);
                }
            }
            
            // Enrich existing transactions with transfer details if missing
            // Note: Enrichment doesn't count against maxTransactions since it doesn't add new transactions
            const enriched = await enrichTransactionsWithTransfers(history, outputFile, 50);
            if (enriched > 0) {
                console.log(`\nEnriched ${enriched} transaction(s) with transfer details`);
            }
        }
        
        // Collect staking rewards at epoch boundaries
        const stakingRewards = await collectStakingRewards(accountId, history, outputFile);
        if (stakingRewards > 0) {
            console.log(`\nAdded ${stakingRewards} staking reward entries`);
        }
        
        // Early return if maxTransactions was 0 (user only wanted enrichment/gap fill) or stakingOnly
        if (maxTransactions === 0 || stakingOnly) {
            return history;
        }
    }

    // Get current block height
    const currentBlock = await getCurrentBlockHeight();
    console.log(`Current block height: ${currentBlock}`);

    // Determine search range based on direction and existing data
    let searchStart: number, searchEnd: number;
    
    if (direction === 'backward') {
        searchEnd = startBlock || (history.metadata.firstBlock ? history.metadata.firstBlock - 1 : currentBlock);
        searchStart = endBlock || Math.max(0, searchEnd - 1000000); // Default 1M blocks back
    } else {
        searchStart = startBlock || (history.metadata.lastBlock ? history.metadata.lastBlock + 1 : 0);
        searchEnd = endBlock || currentBlock;
    }

    console.log(`Search range: ${searchStart} - ${searchEnd}`);

    let transactionsFound = 0;
    
    // Try using NearBlocks API first for faster transaction discovery
    if (isNearBlocksAvailable()) {
        console.log(`\nUsing NearBlocks API for faster transaction discovery...`);
        
        try {
            // Get known transaction blocks from NearBlocks
            const knownBlocks = await getAllTransactionBlocks(accountId, {
                afterBlock: searchStart,
                beforeBlock: searchEnd,
                maxPages: Math.ceil(maxTransactions / 25) + 2
            });
            
            // Filter to blocks we haven't processed yet
            const existingBlocks = new Set(history.transactions.map(t => t.block));
            const newBlocks = knownBlocks.filter(b => !existingBlocks.has(b.blockHeight));
            
            // Sort by block height based on direction
            if (direction === 'backward') {
                newBlocks.sort((a, b) => b.blockHeight - a.blockHeight);
            } else {
                newBlocks.sort((a, b) => a.blockHeight - b.blockHeight);
            }
            
            console.log(`Found ${newBlocks.length} new transaction blocks to process`);
            
            // Process each known transaction block
            for (const txBlock of newBlocks) {
                if (getStopSignal()) {
                    console.log('Stop signal received, saving progress...');
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                    console.log(`Progress saved to ${outputFile}`);
                    break;
                }
                
                if (transactionsFound >= maxTransactions) {
                    break;
                }
                
                // Clear cache periodically to avoid memory issues
                if (transactionsFound % 10 === 0) {
                    clearBalanceCache();
                }
                
                try {
                    // Get balance changes at this specific block
                    const balanceChange = await getBalanceChangesAtBlock(accountId, txBlock.blockHeight);
                    
                    if (!balanceChange.hasChanges) {
                        // This can happen for FT transactions where we're not tracking that token
                        continue;
                    }
                    
                    // Find the transaction details
                    const txInfo = await findBalanceChangingTransaction(accountId, txBlock.blockHeight);
                    
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
                    
                    // Verify connectivity with adjacent transactions
                    if (direction === 'backward' && history.transactions.length > 0) {
                        const nextTransaction = history.transactions[0];
                        if (nextTransaction) {
                            const verification = verifyTransactionConnectivity(nextTransaction, entry);
                            entry.verificationWithNext = verification;
                            
                            if (!verification.valid) {
                                console.warn(`Warning: Connectivity issue detected at block ${txBlock.blockHeight}`);
                                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                            }
                        }
                    } else if (direction === 'forward' && history.transactions.length > 0) {
                        const prevTransaction = history.transactions[history.transactions.length - 1];
                        if (prevTransaction) {
                            const verification = verifyTransactionConnectivity(entry, prevTransaction);
                            entry.verificationWithPrevious = verification;
                            
                            if (!verification.valid) {
                                console.warn(`Warning: Connectivity issue detected at block ${txBlock.blockHeight}`);
                                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                            }
                        }
                    }
                    
                    // Add to history in correct order
                    if (direction === 'backward') {
                        history.transactions.unshift(entry);
                    } else {
                        history.transactions.push(entry);
                    }
                    
                    transactionsFound++;
                    console.log(`Transaction ${transactionsFound}/${maxTransactions} added at block ${txBlock.blockHeight}`);
                    
                    // Update metadata
                    const allBlocks = history.transactions.map(t => t.block);
                    history.metadata.firstBlock = Math.min(...allBlocks);
                    history.metadata.lastBlock = Math.max(...allBlocks);
                    history.metadata.totalTransactions = history.transactions.length;
                    history.updatedAt = new Date().toISOString();
                    
                    // Save progress periodically
                    if (transactionsFound % 5 === 0) {
                        saveHistory(outputFile, history);
                        console.log(`Progress saved to ${outputFile}`);
                    }
                } catch (error: any) {
                    if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                        console.log(`Error during NearBlocks processing: ${error.message}`);
                        console.log('Stopping and saving progress...');
                        history.updatedAt = new Date().toISOString();
                        saveHistory(outputFile, history);
                        console.log(`Progress saved to ${outputFile}`);
                        break;
                    }
                    console.warn(`Error processing block ${txBlock.blockHeight}: ${error.message}`);
                    // Continue with next block
                }
            }
            
            // Final save after NearBlocks processing
            if (transactionsFound > 0) {
                saveHistory(outputFile, history);
                console.log(`\nNearBlocks API processing complete. Found ${transactionsFound} transactions.`);
            }
            
            // If we found enough transactions, we're done
            if (transactionsFound >= maxTransactions) {
                saveHistory(outputFile, history);
                console.log(`\n=== Export complete ===`);
                console.log(`Total transactions: ${history.metadata.totalTransactions}`);
                console.log(`Block range: ${history.metadata.firstBlock} - ${history.metadata.lastBlock}`);
                console.log(`Output saved to: ${outputFile}`);
                return history;
            }
        } catch (error: any) {
            console.warn(`NearBlocks API error: ${error.message}`);
            console.log('Continuing to intents explorer or binary search...');
        }
    }
    
    // Try using Intents Explorer API for faster intents transaction discovery
    // This is especially useful for accounts with significant intents activity
    const remainingAfterNearBlocks = maxTransactions - transactionsFound;
    if (remainingAfterNearBlocks > 0 && !getStopSignal() && isIntentsExplorerAvailable()) {
        console.log(`\nUsing Intents Explorer API for intents transaction discovery...`);
        
        try {
            // Get known intents transaction blocks from Intents Explorer
            const intentsBlocks = await getAllIntentsTransactionBlocks(accountId, {
                afterBlock: searchStart,
                beforeBlock: searchEnd,
                maxPages: Math.ceil(remainingAfterNearBlocks / 25) + 2
            });
            
            // Filter to blocks we haven't processed yet
            const existingBlocks = new Set(history.transactions.map(t => t.block));
            const newIntentsBlocks = intentsBlocks.filter(b => !existingBlocks.has(b.blockHeight));
            
            // Sort by block height based on direction
            if (direction === 'backward') {
                newIntentsBlocks.sort((a, b) => b.blockHeight - a.blockHeight);
            } else {
                newIntentsBlocks.sort((a, b) => a.blockHeight - b.blockHeight);
            }
            
            console.log(`Found ${newIntentsBlocks.length} new intents transaction blocks to process`);
            
            // Process each known intents transaction block
            for (const txBlock of newIntentsBlocks) {
                if (getStopSignal()) {
                    console.log('Stop signal received, saving progress...');
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                    console.log(`Progress saved to ${outputFile}`);
                    break;
                }
                
                if (transactionsFound >= maxTransactions) {
                    break;
                }
                
                // Clear cache periodically to avoid memory issues
                if (transactionsFound % 10 === 0) {
                    clearBalanceCache();
                }
                
                try {
                    // Get balance changes at this specific block
                    // Optimization: Use token IDs from Intents Explorer API to check only those specific tokens
                    // This avoids unnecessary RPC calls for fungible tokens and unknown intents tokens
                    const balanceChange = await getBalanceChangesAtBlock(
                        accountId, 
                        txBlock.blockHeight,
                        null, // Skip fungible token balance checking (parameter: tokenContracts)
                        txBlock.tokenIds // Check only these specific intents tokens from API (parameter: intentsTokens)
                    );
                    
                    if (!balanceChange.hasChanges) {
                        // No balance changes detected - the tokens from the API may have zero balance
                        // or may not be in our complete token tracking list
                        const tokenDisplay = txBlock.tokenIds.length > 3 
                            ? `${txBlock.tokenIds.slice(0, 3).join(', ')} and ${txBlock.tokenIds.length - 3} more`
                            : txBlock.tokenIds.join(', ') || 'none';
                        console.log(`  Skipping block ${txBlock.blockHeight} - no tracked balance changes (intents tokens: ${tokenDisplay})`);
                        continue;
                    }
                    
                    // Find the transaction details
                    const txInfo = await findBalanceChangingTransaction(accountId, txBlock.blockHeight);
                    
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
                    
                    // Verify connectivity with adjacent transactions
                    if (direction === 'backward' && history.transactions.length > 0) {
                        const nextTransaction = history.transactions[0];
                        if (nextTransaction) {
                            const verification = verifyTransactionConnectivity(nextTransaction, entry);
                            entry.verificationWithNext = verification;
                            
                            if (!verification.valid) {
                                console.warn(`Warning: Connectivity issue detected at block ${txBlock.blockHeight}`);
                                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                            }
                        }
                    } else if (direction === 'forward' && history.transactions.length > 0) {
                        const prevTransaction = history.transactions[history.transactions.length - 1];
                        if (prevTransaction) {
                            const verification = verifyTransactionConnectivity(entry, prevTransaction);
                            entry.verificationWithPrevious = verification;
                            
                            if (!verification.valid) {
                                console.warn(`Warning: Connectivity issue detected at block ${txBlock.blockHeight}`);
                                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                            }
                        }
                    }
                    
                    // Add to history in correct order
                    if (direction === 'backward') {
                        history.transactions.unshift(entry);
                    } else {
                        history.transactions.push(entry);
                    }
                    
                    transactionsFound++;
                    console.log(`Transaction ${transactionsFound}/${maxTransactions} added at block ${txBlock.blockHeight} (Intents Explorer API)`);
                    
                    // Update metadata
                    const allBlocks = history.transactions.map(t => t.block);
                    history.metadata.firstBlock = Math.min(...allBlocks);
                    history.metadata.lastBlock = Math.max(...allBlocks);
                    history.metadata.totalTransactions = history.transactions.length;
                    history.updatedAt = new Date().toISOString();
                    
                    // Save progress periodically
                    if (transactionsFound % 5 === 0) {
                        saveHistory(outputFile, history);
                        console.log(`Progress saved to ${outputFile}`);
                    }
                } catch (error: any) {
                    if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                        console.log(`Error during Intents Explorer processing: ${error.message}`);
                        console.log('Stopping and saving progress...');
                        history.updatedAt = new Date().toISOString();
                        saveHistory(outputFile, history);
                        console.log(`Progress saved to ${outputFile}`);
                        break;
                    }
                    console.warn(`Error processing intents block ${txBlock.blockHeight}: ${error.message}`);
                    // Continue with next block
                }
            }
            
            // Final save after Intents Explorer processing
            if (transactionsFound > 0) {
                saveHistory(outputFile, history);
                console.log(`\nIntents Explorer API processing complete. Found ${transactionsFound} total transactions.`);
            }
            
            // If we found enough transactions, we're done
            if (transactionsFound >= maxTransactions) {
                saveHistory(outputFile, history);
                console.log(`\n=== Export complete ===`);
                console.log(`Total transactions: ${history.metadata.totalTransactions}`);
                console.log(`Block range: ${history.metadata.firstBlock} - ${history.metadata.lastBlock}`);
                console.log(`Output saved to: ${outputFile}`);
                return history;
            }
        } catch (error: any) {
            console.warn(`Intents Explorer API error: ${error.message}`);
            console.log('Falling back to binary search...');
        }
    }
    
    // Fall back to binary search for remaining transactions or if APIs are not available
    const remainingTransactions = maxTransactions - transactionsFound;
    if (remainingTransactions > 0 && !getStopSignal()) {
        console.log(`\nUsing binary search to find ${remainingTransactions} more transactions...`);
        
        let currentSearchEnd = searchEnd;
        let currentSearchStart = searchStart;
        const initialRangeSize = searchEnd - searchStart;
        let currentRangeSize = initialRangeSize;
        const maxRangeSize = initialRangeSize * 32; // Cap at 32x the initial range (~32M blocks max)
        let consecutiveEmptyRanges = 0;

    while (transactionsFound < maxTransactions) {
        if (getStopSignal()) {
            console.log('Stop signal received, saving progress...');
            // Save immediately before breaking
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
            console.log(`Progress saved to ${outputFile}`);
            break;
        }

        // Check if current range is valid
        if (direction === 'backward' && currentSearchEnd < 0) {
            console.log('Reached the beginning of the blockchain');
            break;
        } else if (direction === 'forward' && currentSearchStart > currentBlock) {
            console.log('Reached the current block height');
            break;
        }

        console.log(`\nSearching for balance changes in blocks ${currentSearchStart} - ${currentSearchEnd}...`);
        
        // Clear cache periodically to avoid memory issues
        if (transactionsFound % 10 === 0) {
            clearBalanceCache();
        }

        // When searching backward, check if the account exists at the start of the range
        // If it doesn't exist, we've reached the beginning of the account's history
        if (direction === 'backward') {
            try {
                const existsAtStart = await accountExistsAtBlock(accountId, currentSearchStart);
                if (!existsAtStart) {
                    console.log(`Account does not exist at block ${currentSearchStart} - reached the beginning of account history`);
                    // Mark history as complete and save progress
                    history.metadata.historyComplete = true;
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                    console.log(`Progress saved to ${outputFile} (history complete)`);
                    break;
                }
            } catch (error: any) {
                if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                    console.log(`Error checking account existence: ${error.message}`);
                    console.log('Stopping and saving progress...');
                    history.updatedAt = new Date().toISOString();
                    saveHistory(outputFile, history);
                    console.log(`Progress saved to ${outputFile}`);
                    break;
                }
                // For other errors (like missing blocks), continue with the search
                console.warn(`Warning: Could not check account existence at block ${currentSearchStart}: ${error.message}`);
            }
        }

        let balanceChange: BalanceChanges;
        try {
            // Find the block where balance changed
            balanceChange = await findLatestBalanceChangingBlock(
                accountId,
                currentSearchStart,
                currentSearchEnd
            );
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`Error during search: ${error.message}`);
                console.log('Stopping and saving progress...');
                // Save immediately before breaking
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
                console.log(`Progress saved to ${outputFile}`);
                break;
            }
            if (error.message.includes('does not exist')) {
                console.log(`Account does not exist at block ${currentSearchStart} - reached the beginning of account history`);
                // Mark history as complete and save progress
                if (direction === 'backward') {
                    history.metadata.historyComplete = true;
                }
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
                console.log(`Progress saved to ${outputFile} (history complete)`);
                break;
            }
            throw error;
        }

        if (!balanceChange.hasChanges) {
            consecutiveEmptyRanges++;
            
            // Expand range size when we find no changes (double it each time, up to max)
            if (currentRangeSize < maxRangeSize) {
                currentRangeSize = Math.min(currentRangeSize * 2, maxRangeSize);
                console.log(`No balance changes found. Expanding search range to ${currentRangeSize.toLocaleString()} blocks`);
            } else {
                console.log('No balance changes found in current range');
            }
            
            // Move to adjacent range with (potentially expanded) size
            if (direction === 'backward') {
                currentSearchEnd = currentSearchStart - 1;
                currentSearchStart = Math.max(0, currentSearchEnd - currentRangeSize);
                console.log(`Moving to previous range: ${currentSearchStart.toLocaleString()} - ${currentSearchEnd.toLocaleString()}`);
            } else {
                currentSearchStart = currentSearchEnd + 1;
                currentSearchEnd = Math.min(currentBlock, currentSearchStart + currentRangeSize);
                console.log(`Moving to next range: ${currentSearchStart.toLocaleString()} - ${currentSearchEnd.toLocaleString()}`);
            }
            
            // Save progress even when no transactions found
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
            console.log(`Progress saved to ${outputFile}`);
            
            continue;
        }

        // Found a balance change - reset range size to initial for more precise searching
        if (currentRangeSize !== initialRangeSize) {
            console.log(`Found balance change - resetting search range to ${initialRangeSize.toLocaleString()} blocks`);
            currentRangeSize = initialRangeSize;
        }
        consecutiveEmptyRanges = 0;

        console.log(`Found balance change at block ${balanceChange.block}`);

        let txInfo: TransactionInfo;
        try {
            // Find the transaction that caused the change
            txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block!);
        } catch (error: any) {
            if (error.message.includes('rate limit') || error.message.includes('Operation cancelled')) {
                console.log(`Error fetching transaction details: ${error.message}`);
                console.log('Stopping and saving progress...');
                // Save immediately before breaking
                history.updatedAt = new Date().toISOString();
                saveHistory(outputFile, history);
                console.log(`Progress saved to ${outputFile}`);
                break;
            }
            throw error;
        }

        // Create transaction entry
        const entry: TransactionEntry = {
            block: balanceChange.block!,
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

        // Verify connectivity with adjacent transactions
        if (direction === 'backward' && history.transactions.length > 0) {
            const nextTransaction = history.transactions[0]; // Most recent in list
            if (nextTransaction) {
                const verification = verifyTransactionConnectivity(nextTransaction, entry);
                entry.verificationWithNext = verification;
                
                if (!verification.valid) {
                    console.warn(`Warning: Connectivity issue detected at block ${balanceChange.block}`);
                    verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                    
                    // There might be missing transactions between this block and the next
                    // First check the block immediately after this one
                    const immediateNextBlock = balanceChange.block! + 1;
                    if (immediateNextBlock < nextTransaction.block && transactionsFound < maxTransactions) {
                        console.log(`Checking for immediate balance change at block ${immediateNextBlock}`);
                        try {
                            // Skip if we already have this block
                            const existingImmediate = history.transactions.find(t => t.block === immediateNextBlock);
                            if (existingImmediate) {
                                console.log(`Skipping duplicate immediate gap entry at block ${immediateNextBlock}`);
                            } else {
                                const immediateChange = await getBalanceChangesAtBlock(accountId, immediateNextBlock);
                                if (immediateChange.hasChanges) {
                                    // Found a missing transaction right after
                                    const immTxInfo = await findBalanceChangingTransaction(accountId, immediateNextBlock);
                                    const immEntry: TransactionEntry = {
                                        block: immediateNextBlock,
                                        timestamp: immTxInfo.blockTimestamp,
                                        transactionHashes: immTxInfo.transactionHashes,
                                        transactions: immTxInfo.transactions,
                                        transfers: immTxInfo.transfers,
                                        balanceBefore: immediateChange.startBalance,
                                        balanceAfter: immediateChange.endBalance,
                                        changes: {
                                            nearChanged: immediateChange.nearChanged,
                                            nearDiff: immediateChange.nearDiff,
                                            tokensChanged: immediateChange.tokensChanged,
                                            intentsChanged: immediateChange.intentsChanged
                                        }
                                    };
                                    // Insert after the current entry (before nextTransaction)
                                    history.transactions.splice(1, 0, immEntry);
                                    transactionsFound++;
                                    console.log(`Immediate gap transaction added at block ${immediateNextBlock}`);
                                    
                                    // Re-verify the chain
                                    const newVerification = verifyTransactionConnectivity(immEntry, entry);
                                    entry.verificationWithNext = newVerification;
                                }
                            }
                        } catch (gapError: any) {
                            console.warn(`Could not check immediate block: ${gapError.message}`);
                        }
                    }
                    
                    // If still not valid, search in the remaining gap
                    if (entry.verificationWithNext && !entry.verificationWithNext.valid) {
                        const gapStart = balanceChange.block! + 2; // Start after the immediate block we just checked
                        const gapEnd = nextTransaction.block - 1;
                        if (gapEnd >= gapStart && transactionsFound < maxTransactions) {
                            console.log(`Searching for missing transactions in gap: ${gapStart} - ${gapEnd}`);
                            try {
                                const gapChange = await findLatestBalanceChangingBlock(accountId, gapStart, gapEnd);
                                if (gapChange.hasChanges && gapChange.block) {
                                    // Found a missing transaction, add it
                                    const gapTxInfo = await findBalanceChangingTransaction(accountId, gapChange.block);
                                    const gapEntry: TransactionEntry = {
                                        block: gapChange.block,
                                        timestamp: gapTxInfo.blockTimestamp,
                                        transactionHashes: gapTxInfo.transactionHashes,
                                        transactions: gapTxInfo.transactions,
                                        transfers: gapTxInfo.transfers,
                                        balanceBefore: gapChange.startBalance,
                                        balanceAfter: gapChange.endBalance,
                                        changes: {
                                            nearChanged: gapChange.nearChanged,
                                            nearDiff: gapChange.nearDiff,
                                            tokensChanged: gapChange.tokensChanged,
                                            intentsChanged: gapChange.intentsChanged
                                        }
                                    };
                                    // Insert in the right position if not duplicate
                                    const gapBlock = gapChange.block!;
                                    const existingGapEntry = history.transactions.find(t => t.block === gapBlock);
                                    if (!existingGapEntry) {
                                        const insertPos = history.transactions.findIndex(t => t.block > gapBlock);
                                        if (insertPos >= 0) {
                                            history.transactions.splice(insertPos, 0, gapEntry);
                                        } else {
                                            history.transactions.push(gapEntry);
                                        }
                                        transactionsFound++;
                                        console.log(`Gap transaction added at block ${gapBlock}`);
                                    } else {
                                        console.log(`Skipping duplicate gap entry at block ${gapBlock}`);
                                    }
                                }
                            } catch (gapError: any) {
                                console.warn(`Could not search gap: ${gapError.message}`);
                            }
                        }
                    }
                }
            }
        } else if (direction === 'forward' && history.transactions.length > 0) {
            const prevTransaction = history.transactions[history.transactions.length - 1];
            if (prevTransaction) {
                const verification = verifyTransactionConnectivity(entry, prevTransaction);
                entry.verificationWithPrevious = verification;
                
                if (!verification.valid) {
                    console.warn(`Warning: Connectivity issue detected at block ${balanceChange.block}`);
                    verification.errors.forEach(err => console.warn(`  - ${err.message}`));
                }
            }
        }

        // Check for duplicate block before adding
        const existingAtBlock = history.transactions.find(t => t.block === entry.block);
        if (existingAtBlock) {
            console.log(`Skipping duplicate entry at block ${entry.block}`);
            // Still update search range to move past this block
            if (direction === 'backward') {
                currentSearchEnd = entry.block - 1;
            } else {
                currentSearchStart = entry.block + 1;
            }
            continue;
        }

        // Add to history in correct order
        if (direction === 'backward') {
            history.transactions.unshift(entry);
        } else {
            history.transactions.push(entry);
        }

        transactionsFound++;
        console.log(`Transaction ${transactionsFound}/${maxTransactions} added`);

        // Update search range for next iteration
        if (direction === 'backward') {
            currentSearchEnd = balanceChange.block! - 1;
        } else {
            currentSearchStart = balanceChange.block! + 1;
        }

        // Update metadata
        const allBlocks = history.transactions.map(t => t.block);
        history.metadata.firstBlock = Math.min(...allBlocks);
        history.metadata.lastBlock = Math.max(...allBlocks);
        history.metadata.totalTransactions = history.transactions.length;
        history.updatedAt = new Date().toISOString();

        // Save progress periodically
        if (transactionsFound % 5 === 0) {
            saveHistory(outputFile, history);
            console.log(`Progress saved to ${outputFile}`);
        }
    }
    } // End of binary search fallback block

    // Final save
    saveHistory(outputFile, history);
    console.log(`\n=== Export complete ===`);
    console.log(`Total transactions: ${history.metadata.totalTransactions}`);
    console.log(`Block range: ${history.metadata.firstBlock} - ${history.metadata.lastBlock}`);
    console.log(`Output saved to: ${outputFile}`);

    return history;
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
        const arg = args[i];
        
        switch (arg) {
            case '--account':
            case '-a':
                if (args[i + 1]) options.accountId = args[++i] ?? null;
                break;
            case '--output':
            case '-o':
                if (args[i + 1]) options.outputFile = args[++i] ?? null;
                break;
            case '--direction':
            case '-d':
                if (args[i + 1]) options.direction = args[++i] as 'forward' | 'backward';
                break;
            case '--max':
            case '-m':
                if (args[i + 1]) options.maxTransactions = parseInt(args[++i]!, 10);
                break;
            case '--start-block':
                if (args[i + 1]) options.startBlock = parseInt(args[++i]!, 10);
                break;
            case '--end-block':
                if (args[i + 1]) options.endBlock = parseInt(args[++i]!, 10);
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
