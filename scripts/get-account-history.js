#!/usr/bin/env node
// Main script for getting NEAR account accounting history
// Saves history to a JSON file and supports continuing from existing data

import fs from 'fs';
import path from 'path';
import {
    getCurrentBlockHeight,
    setStopSignal,
    getStopSignal,
    setProvider
} from './rpc.js';
import {
    findLatestBalanceChangingBlock,
    findBalanceChangingTransaction,
    getAllBalances,
    getBlockHeightAtDate,
    clearBalanceCache
} from './balance-tracker.js';

/**
 * Load existing accounting history from file
 * @param {string} filePath - Path to the history file
 * @returns {Object|null} Existing history or null
 */
function loadExistingHistory(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error(`Error loading existing history from ${filePath}:`, error.message);
    }
    return null;
}

/**
 * Save accounting history to file
 * @param {string} filePath - Path to save to
 * @param {Object} history - History data to save
 */
function saveHistory(filePath, history) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(history, null, 2));
}

/**
 * Verify that a transaction's balance changes match the expected changes
 * @param {Object} transaction - Transaction entry
 * @param {Object} previousTransaction - Previous transaction entry (can be null)
 * @returns {Object} Verification result
 */
function verifyTransactionConnectivity(transaction, previousTransaction) {
    const result = {
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
 * Get accounting history for an account
 * @param {Object} options - Options for the export
 * @param {string} options.accountId - NEAR account ID
 * @param {string} options.outputFile - Output file path
 * @param {string} options.direction - 'forward' or 'backward'
 * @param {number} options.maxTransactions - Maximum transactions to fetch
 * @param {number} options.startBlock - Starting block (optional)
 * @param {number} options.endBlock - Ending block (optional)
 * @returns {Promise<Object>} History data
 */
export async function getAccountHistory(options) {
    const {
        accountId,
        outputFile,
        direction = 'backward',
        maxTransactions = 100,
        startBlock,
        endBlock
    } = options;

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

    // Get current block height
    const currentBlock = await getCurrentBlockHeight();
    console.log(`Current block height: ${currentBlock}`);

    // Determine search range based on direction and existing data
    let searchStart, searchEnd;
    
    if (direction === 'backward') {
        searchEnd = startBlock || (history.metadata.firstBlock ? history.metadata.firstBlock - 1 : currentBlock);
        searchStart = endBlock || Math.max(0, searchEnd - 1000000); // Default 1M blocks back
    } else {
        searchStart = startBlock || (history.metadata.lastBlock ? history.metadata.lastBlock + 1 : 0);
        searchEnd = endBlock || currentBlock;
    }

    console.log(`Search range: ${searchStart} - ${searchEnd}`);

    let transactionsFound = 0;
    let currentSearchEnd = searchEnd;
    let currentSearchStart = searchStart;

    while (transactionsFound < maxTransactions && currentSearchEnd > currentSearchStart) {
        if (getStopSignal()) {
            console.log('Stop signal received, saving progress...');
            break;
        }

        console.log(`\nSearching for balance changes in blocks ${currentSearchStart} - ${currentSearchEnd}...`);
        
        // Clear cache periodically to avoid memory issues
        if (transactionsFound % 10 === 0) {
            clearBalanceCache();
        }

        // Find the block where balance changed
        const balanceChange = await findLatestBalanceChangingBlock(
            accountId,
            currentSearchStart,
            currentSearchEnd
        );

        if (!balanceChange.hasChanges) {
            console.log('No more balance changes found in range');
            break;
        }

        console.log(`Found balance change at block ${balanceChange.block}`);

        // Find the transaction that caused the change
        const txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block);

        // Create transaction entry
        const entry = {
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

        // Verify connectivity with adjacent transactions
        if (direction === 'backward' && history.transactions.length > 0) {
            const nextTransaction = history.transactions[0]; // Most recent in list
            const verification = verifyTransactionConnectivity(nextTransaction, entry);
            entry.verificationWithNext = verification;
            
            if (!verification.valid) {
                console.warn(`Warning: Connectivity issue detected at block ${balanceChange.block}`);
                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
            }
        } else if (direction === 'forward' && history.transactions.length > 0) {
            const prevTransaction = history.transactions[history.transactions.length - 1];
            const verification = verifyTransactionConnectivity(entry, prevTransaction);
            entry.verificationWithPrevious = verification;
            
            if (!verification.valid) {
                console.warn(`Warning: Connectivity issue detected at block ${balanceChange.block}`);
                verification.errors.forEach(err => console.warn(`  - ${err.message}`));
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
            currentSearchEnd = balanceChange.block - 1;
        } else {
            currentSearchStart = balanceChange.block + 1;
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
 * @param {string} filePath - Path to the history file
 * @returns {Object} Verification results
 */
export function verifyHistoryFile(filePath) {
    const history = loadExistingHistory(filePath);
    
    if (!history) {
        return { valid: false, error: 'Could not load history file' };
    }

    const results = {
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

    return results;
}

/**
 * Parse command line arguments
 * @returns {Object} Parsed arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        accountId: null,
        outputFile: null,
        direction: 'backward',
        maxTransactions: 100,
        startBlock: null,
        endBlock: null,
        verify: false,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        
        switch (arg) {
            case '--account':
            case '-a':
                options.accountId = args[++i];
                break;
            case '--output':
            case '-o':
                options.outputFile = args[++i];
                break;
            case '--direction':
            case '-d':
                options.direction = args[++i];
                break;
            case '--max':
            case '-m':
                options.maxTransactions = parseInt(args[++i], 10);
                break;
            case '--start-block':
                options.startBlock = parseInt(args[++i], 10);
                break;
            case '--end-block':
                options.endBlock = parseInt(args[++i], 10);
                break;
            case '--verify':
            case '-v':
                options.verify = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                // If not a flag, treat as account ID
                if (!arg.startsWith('-') && !options.accountId) {
                    options.accountId = arg;
                }
        }
    }

    return options;
}

/**
 * Print help message
 */
function printHelp() {
    console.log(`
NEAR Accounting Export - Get account transaction history

Usage:
  node get-account-history.js [options] <account-id>

Options:
  -a, --account <id>      NEAR account ID to fetch history for
  -o, --output <file>     Output file path (default: <account-id>.json)
  -d, --direction <dir>   Search direction: 'backward' or 'forward' (default: backward)
  -m, --max <number>      Maximum transactions to fetch (default: 100)
  --start-block <number>  Starting block height
  --end-block <number>    Ending block height
  -v, --verify            Verify an existing history file
  -h, --help              Show this help message

Environment Variables:
  NEAR_RPC_ENDPOINT       RPC endpoint URL (default: https://archival-rpc.mainnet.fastnear.com)
  RPC_DELAY_MS            Delay between RPC calls in ms (default: 50)

Examples:
  # Fetch last 50 transactions for an account
  node get-account-history.js --account myaccount.near --max 50

  # Continue fetching backward from existing file
  node get-account-history.js --account myaccount.near --output ./history.json

  # Fetch forward from a specific block
  node get-account-history.js -a myaccount.near --direction forward --start-block 100000000

  # Verify an existing history file
  node get-account-history.js --verify --output ./history.json
`);
}

// Main execution
async function main() {
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
        await getAccountHistory(options);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
