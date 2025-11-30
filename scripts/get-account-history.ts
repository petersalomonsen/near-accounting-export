#!/usr/bin/env node
// Main script for getting NEAR account accounting history
// Saves history to a JSON file and supports continuing from existing data

import fs from 'fs';
import path from 'path';
import {
    getCurrentBlockHeight,
    setStopSignal,
    getStopSignal
} from './rpc.js';
import {
    findLatestBalanceChangingBlock,
    findBalanceChangingTransaction,
    clearBalanceCache,
    getBalanceChangesAtBlock
} from './balance-tracker.js';
import {
    getAllTransactionBlocks,
    isNearBlocksAvailable
} from './nearblocks-api.js';
import type { BalanceSnapshot, BalanceChanges, TransactionInfo } from './balance-tracker.js';
import type { TransactionBlock } from './nearblocks-api.js';

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

interface TransactionEntry {
    block: number;
    timestamp: number | null;
    transactionHashes: string[];
    transactions: any[];
    balanceBefore?: BalanceSnapshot;
    balanceAfter?: BalanceSnapshot;
    changes: {
        nearChanged: boolean;
        nearDiff?: string;
        tokensChanged: Record<string, { start: string; end: string; diff: string }>;
        intentsChanged: Record<string, { start: string; end: string; diff: string }>;
    };
    verificationWithNext?: VerificationResult;
    verificationWithPrevious?: VerificationResult;
}

interface AccountHistory {
    accountId: string;
    createdAt: string;
    updatedAt: string;
    transactions: TransactionEntry[];
    metadata: {
        firstBlock: number | null;
        lastBlock: number | null;
        totalTransactions: number;
    };
}

interface GetAccountHistoryOptions {
    accountId: string;
    outputFile: string;
    direction?: 'forward' | 'backward';
    maxTransactions?: number;
    startBlock?: number;
    endBlock?: number;
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
 * Detect gaps in transaction history where balance connectivity is broken
 */
function detectGaps(history: AccountHistory): Array<{ prevBlock: number; nextBlock: number; prevTx: TransactionEntry; nextTx: TransactionEntry }> {
    const gaps: Array<{ prevBlock: number; nextBlock: number; prevTx: TransactionEntry; nextTx: TransactionEntry }> = [];
    
    if (history.transactions.length < 2) {
        return gaps;
    }
    
    // Sort transactions by block
    const sortedTransactions = [...history.transactions].sort((a, b) => a.block - b.block);
    
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
        
        const searchStart = gap.prevBlock + 1;
        const searchEnd = gap.nextBlock - 1;
        
        if (searchStart > searchEnd) {
            console.log('Gap is adjacent blocks, no intermediate transactions');
            continue;
        }
        
        let currentStart = searchStart;
        let currentEnd = searchEnd;
        let foundInGap = 0;
        
        while (currentStart <= currentEnd && foundInGap < maxTransactionsToFill - totalFilled) {
            if (getStopSignal()) {
                break;
            }
            
            console.log(`Searching in range ${currentStart} - ${currentEnd}...`);
            
            let balanceChange: BalanceChanges;
            try {
                balanceChange = await findLatestBalanceChangingBlock(
                    history.accountId,
                    currentStart,
                    currentEnd
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
            
            // Create transaction entry
            const entry: TransactionEntry = {
                block: balanceChange.block,
                timestamp: txInfo.blockTimestamp,
                transactionHashes: txInfo.transactionHashes,
                transactions: txInfo.transactions,
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
            
            // Search for more in the remaining range
            currentEnd = balanceChange.block - 1;
        }
        
        // Save after filling each gap
        history.updatedAt = new Date().toISOString();
        saveHistory(outputFile, history);
        console.log(`Filled ${foundInGap} transaction(s) in this gap`);
    }
    
    return totalFilled;
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
        endBlock
    } = options;
    
    let maxTransactions = options.maxTransactions || 100;

    console.log(`\n=== Getting accounting history for ${accountId} ===`);
    console.log(`Direction: ${direction}`);
    console.log(`Output file: ${outputFile}`);

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
                        timestamp: txInfo.blockTimestamp,
                        transactionHashes: txInfo.transactionHashes,
                        transactions: txInfo.transactions,
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
            console.log('Falling back to binary search...');
        }
    }
    
    // Fall back to binary search for remaining transactions or if NearBlocks is not available
    const remainingTransactions = maxTransactions - transactionsFound;
    if (remainingTransactions > 0 && !getStopSignal()) {
        console.log(`\nUsing binary search to find ${remainingTransactions} more transactions...`);
        
        let currentSearchEnd = searchEnd;
        let currentSearchStart = searchStart;
        const rangeSize = searchEnd - searchStart;

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
            throw error;
        }

        if (!balanceChange.hasChanges) {
            console.log('No balance changes found in current range');
            
            // Move to adjacent range of equal size
            if (direction === 'backward') {
                currentSearchEnd = currentSearchStart - 1;
                currentSearchStart = Math.max(0, currentSearchEnd - rangeSize);
                console.log(`Moving to previous range: ${currentSearchStart} - ${currentSearchEnd}`);
            } else {
                currentSearchStart = currentSearchEnd + 1;
                currentSearchEnd = Math.min(currentBlock, currentSearchStart + rangeSize);
                console.log(`Moving to next range: ${currentSearchStart} - ${currentSearchEnd}`);
            }
            
            // Save progress even when no transactions found
            history.updatedAt = new Date().toISOString();
            saveHistory(outputFile, history);
            console.log(`Progress saved to ${outputFile}`);
            
            continue;
        }

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
            timestamp: txInfo.blockTimestamp,
            transactionHashes: txInfo.transactionHashes,
            transactions: txInfo.transactions,
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

    // Sort transactions by block
    const sortedTransactions = [...history.transactions].sort((a, b) => a.block - b.block);

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
