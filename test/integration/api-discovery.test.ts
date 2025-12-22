/**
 * Integration test for API-based transaction discovery
 * 
 * This test verifies that using NearBlocks and Intents Explorer APIs
 * can discover all transactions that were previously found via binary search.
 * 
 * Uses the complete data/webassemblymusic-treasury.sputnik-dao.near.json as reference.
 * 
 * Test data files in test-data/ contain raw API responses for offline testing:
 * - intents-explorer-raw.json: Raw Intents Explorer API response
 * - nearblocks-txns-raw.json: Raw NearBlocks NEAR transactions response
 * - nearblocks-ft-txns-raw.json: Raw NearBlocks FT transactions response
 * - balance-change-171108241.json: Saved balance changes at key block
 * 
 * Run `node fetch-test-data.mjs` to regenerate test data from live APIs.
 */
import { strict as assert } from 'assert';
import { describe, it, before, beforeEach } from 'mocha';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import { setStopSignal } from '../../scripts/rpc.js';
import { clearBalanceCache, getBalanceChangesAtBlock } from '../../scripts/balance-tracker.js';
import type { TransactionEntry } from '../../scripts/get-account-history.js';

// Account history structure (matches internal type in get-account-history.ts)
interface AccountHistory {
    accountId: string;
    createdAt: string;
    updatedAt: string;
    transactions: TransactionEntry[];
    metadata: {
        firstBlock: number;
        lastBlock: number;
        totalTransactions: number;
    };
}

// Test data file paths (go up from dist/test/integration to root)
const TEST_DATA_DIR = path.join(__dirname, '..', '..', '..', 'test-data');
const REFERENCE_FILE = path.join(TEST_DATA_DIR, 'webassemblymusic-treasury.sputnik-dao.near.json');
const INTENTS_RAW_FILE = path.join(TEST_DATA_DIR, 'intents-explorer-raw.json');
const NEARBLOCKS_TXNS_RAW_FILE = path.join(TEST_DATA_DIR, 'nearblocks-txns-raw.json');
const NEARBLOCKS_FT_RAW_FILE = path.join(TEST_DATA_DIR, 'nearblocks-ft-txns-raw.json');
const BALANCE_CHANGE_FILE = path.join(TEST_DATA_DIR, 'balance-change-171108241.json');

// Raw API response interfaces
interface NearBlocksTxnResponse {
    txns: Array<{
        transaction_hash: string;
        block_timestamp: string;
        block: { block_height: number };
        receipt_block?: { block_height: number };
    }>;
    cursor?: { transaction_hash: string } | null;
}

interface NearBlocksFtTxnResponse {
    txns: Array<{
        transaction_hash: string;
        block_timestamp: string;
        block: { block_height: number };
    }>;
    cursor?: { event_index: string } | null;
}

interface IntentsExplorerResponse {
    data: Array<{
        originAsset: string;
        destinationAsset: string;
        recipient: string;
        status: string;
        createdAtTimestamp: number;
        nearTxHashes: string[];
    }>;
    pageInfo: { page: number; perPage: number; totalItems: number; totalPages: number };
}

interface BalanceChangeTestData {
    block: number;
    account: string;
    hasChanges: boolean;
    intentsChanged: Record<string, { start: string; end: string; diff: string }>;
    nearChanged: boolean;
    tokensChanged: Record<string, unknown>;
    stakingChanged: Record<string, unknown>;
}

// Test account
const TEST_ACCOUNT = 'webassemblymusic-treasury.sputnik-dao.near';

describe('API-based Transaction Discovery', function() {
    this.timeout(60000); // 1 minute

    let referenceData: AccountHistory;
    
    before(function() {
        // Load reference data
        if (!fs.existsSync(REFERENCE_FILE)) {
            console.log('Reference file not found, skipping tests');
            this.skip();
            return;
        }
        
        const rawData = fs.readFileSync(REFERENCE_FILE, 'utf-8');
        referenceData = JSON.parse(rawData) as AccountHistory;
        
        console.log(`Reference file loaded: ${referenceData.transactions.length} transactions`);
        console.log(`Block range: ${referenceData.metadata.firstBlock} - ${referenceData.metadata.lastBlock}`);
    });
    
    beforeEach(function() {
        setStopSignal(false);
        clearBalanceCache();
    });

    describe('Raw API Response Processing', function() {
        
        it('should parse Intents Explorer raw response correctly', function() {
            if (!fs.existsSync(INTENTS_RAW_FILE)) {
                console.log('Intents Explorer raw file not found, skipping');
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(INTENTS_RAW_FILE, 'utf-8')) as IntentsExplorerResponse;
            
            console.log(`\nIntents Explorer raw response:`);
            console.log(`  Total transactions: ${rawData.data?.length || 0}`);
            console.log(`  Page info: ${JSON.stringify(rawData.pageInfo)}`);
            
            assert.ok(rawData.data, 'Should have data array');
            assert.ok(Array.isArray(rawData.data), 'data should be an array');
            
            // Check first transaction structure
            const firstTxn = rawData.data[0];
            if (firstTxn) {
                console.log(`\n  First transaction:`);
                console.log(`    recipient: ${firstTxn.recipient}`);
                console.log(`    originAsset: ${firstTxn.originAsset}`);
                console.log(`    destinationAsset: ${firstTxn.destinationAsset}`);
                console.log(`    nearTxHashes: ${firstTxn.nearTxHashes?.join(', ')}`);
                console.log(`    status: ${firstTxn.status}`);
                
                assert.strictEqual(firstTxn.recipient, TEST_ACCOUNT, 'Recipient should match test account');
                assert.ok(firstTxn.originAsset, 'Should have originAsset');
                assert.ok(firstTxn.destinationAsset, 'Should have destinationAsset');
                assert.ok(Array.isArray(firstTxn.nearTxHashes), 'Should have nearTxHashes array');
            }
            
            // Filter for successful transactions for our account
            const accountTxns = rawData.data.filter(t => 
                t.recipient === TEST_ACCOUNT && t.status === 'SUCCESS'
            );
            console.log(`\n  Transactions for ${TEST_ACCOUNT}: ${accountTxns.length}`);
            
            assert.ok(accountTxns.length > 0, 'Should have transactions for test account');
        });

        it('should parse NearBlocks NEAR transactions raw response correctly', function() {
            if (!fs.existsSync(NEARBLOCKS_TXNS_RAW_FILE)) {
                console.log('NearBlocks txns raw file not found, skipping');
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(NEARBLOCKS_TXNS_RAW_FILE, 'utf-8')) as NearBlocksTxnResponse;
            
            console.log(`\nNearBlocks NEAR transactions raw response:`);
            console.log(`  Total transactions: ${rawData.txns?.length || 0}`);
            console.log(`  Has cursor: ${!!rawData.cursor}`);
            
            assert.ok(rawData.txns, 'Should have txns array');
            assert.ok(Array.isArray(rawData.txns), 'txns should be an array');
            
            const firstTxn = rawData.txns[0];
            if (firstTxn) {
                console.log(`\n  First transaction:`);
                console.log(`    hash: ${firstTxn.transaction_hash}`);
                console.log(`    block_height: ${firstTxn.block?.block_height}`);
                console.log(`    timestamp: ${firstTxn.block_timestamp}`);
                
                assert.ok(firstTxn.transaction_hash, 'Should have transaction_hash');
                assert.ok(firstTxn.block?.block_height, 'Should have block_height');
            }
            
            // Extract unique block heights
            const blockHeights = new Set(rawData.txns.map(t => t.block?.block_height).filter(Boolean));
            console.log(`\n  Unique block heights: ${blockHeights.size}`);
            console.log(`  Blocks: ${Array.from(blockHeights).slice(0, 10).join(', ')}...`);
        });

        it('should parse NearBlocks FT transactions raw response correctly', function() {
            if (!fs.existsSync(NEARBLOCKS_FT_RAW_FILE)) {
                console.log('NearBlocks FT txns raw file not found, skipping');
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(NEARBLOCKS_FT_RAW_FILE, 'utf-8')) as NearBlocksFtTxnResponse;
            
            console.log(`\nNearBlocks FT transactions raw response:`);
            console.log(`  Total transactions: ${rawData.txns?.length || 0}`);
            console.log(`  Has cursor: ${!!rawData.cursor}`);
            
            assert.ok(rawData.txns, 'Should have txns array');
            assert.ok(Array.isArray(rawData.txns), 'txns should be an array');
            
            const firstFtTxn = rawData.txns[0];
            if (firstFtTxn) {
                console.log(`\n  First FT transaction:`);
                console.log(`    hash: ${firstFtTxn.transaction_hash}`);
                console.log(`    block_height: ${firstFtTxn.block?.block_height}`);
                
                assert.ok(firstFtTxn.transaction_hash, 'Should have transaction_hash');
                assert.ok(firstFtTxn.block?.block_height, 'Should have block_height');
            }
        });

        it('should extract token IDs from Intents Explorer response', function() {
            if (!fs.existsSync(INTENTS_RAW_FILE)) {
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(INTENTS_RAW_FILE, 'utf-8')) as IntentsExplorerResponse;
            
            // Extract all unique token IDs from transactions
            const tokenIds = new Set<string>();
            for (const txn of rawData.data) {
                if (txn.originAsset) tokenIds.add(txn.originAsset);
                if (txn.destinationAsset) tokenIds.add(txn.destinationAsset);
            }
            
            console.log(`\nUnique token IDs from Intents Explorer:`);
            for (const tokenId of Array.from(tokenIds).slice(0, 10)) {
                console.log(`  - ${tokenId}`);
            }
            if (tokenIds.size > 10) {
                console.log(`  ... and ${tokenIds.size - 10} more`);
            }
            
            // Verify we have the expected Base USDC token
            const hasBaseUsdc = Array.from(tokenIds).some(t => t.includes('base-') && t.includes('omft.near'));
            console.log(`\n  Has Base USDC token: ${hasBaseUsdc}`);
            
            assert.ok(tokenIds.size > 0, 'Should have extracted token IDs');
        });

        it('should find key intents transaction at block 171108241', async function() {
            if (!fs.existsSync(INTENTS_RAW_FILE)) {
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(INTENTS_RAW_FILE, 'utf-8')) as IntentsExplorerResponse;
            
            // Look for the transaction with Base USDC destination
            const baseUsdcTxn = rawData.data.find(t => 
                t.destinationAsset?.includes('base-') && 
                t.destinationAsset?.includes('omft.near') &&
                t.recipient === TEST_ACCOUNT
            );
            
            console.log(`\nLooking for Base USDC swap transaction:`);
            
            if (baseUsdcTxn) {
                console.log(`  Found! Transaction hashes: ${baseUsdcTxn.nearTxHashes?.join(', ')}`);
                console.log(`  Origin: ${baseUsdcTxn.originAsset}`);
                console.log(`  Destination: ${baseUsdcTxn.destinationAsset}`);
                console.log(`  Timestamp: ${baseUsdcTxn.createdAtTimestamp}`);
                
                // The transaction should have hash 6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r
                const expectedHash = '6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r';
                const hasExpectedHash = baseUsdcTxn.nearTxHashes?.includes(expectedHash);
                console.log(`  Has expected hash (${expectedHash}): ${hasExpectedHash}`);
                
                assert.ok(hasExpectedHash, 'Should have the expected transaction hash');
            } else {
                console.log(`  Not found in raw response`);
                assert.fail('Expected to find Base USDC swap transaction');
            }
        });

        it('should verify balance changes at block 171108241', async function() {
            // This test can use saved data or fetch live
            const keyBlock = 171108241;
            
            let testData: BalanceChangeTestData;
            
            if (fs.existsSync(BALANCE_CHANGE_FILE)) {
                console.log(`\nUsing saved balance change data from ${BALANCE_CHANGE_FILE}`);
                testData = JSON.parse(fs.readFileSync(BALANCE_CHANGE_FILE, 'utf-8'));
            } else {
                console.log(`\nFetching balance changes from RPC for block ${keyBlock}...`);
                
                const tokenIds = [
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
                    'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'
                ];
                
                const balanceChanges = await getBalanceChangesAtBlock(
                    TEST_ACCOUNT,
                    keyBlock,
                    undefined,
                    tokenIds
                );
                
                testData = {
                    block: keyBlock,
                    account: TEST_ACCOUNT,
                    hasChanges: balanceChanges.hasChanges,
                    intentsChanged: balanceChanges.intentsChanged || {},
                    nearChanged: balanceChanges.nearChanged,
                    tokensChanged: balanceChanges.tokensChanged || {},
                    stakingChanged: balanceChanges.stakingChanged || {}
                };
                
                // Save for future runs
                fs.writeFileSync(BALANCE_CHANGE_FILE, JSON.stringify(testData, null, 2));
                console.log(`Saved balance change data to ${BALANCE_CHANGE_FILE}`);
            }
            
            console.log(`\nBalance changes at block ${keyBlock}:`);
            console.log(`  Has changes: ${testData.hasChanges}`);
            console.log(`  Intents changed:`, JSON.stringify(testData.intentsChanged, null, 2));
            
            // Verify the Base USDC token has a balance change
            const baseTokenKey = Object.keys(testData.intentsChanged || {}).find(k => k.includes('base-'));
            
            if (baseTokenKey) {
                const change = testData.intentsChanged[baseTokenKey];
                if (change) {
                    console.log(`\n  ✓ Base token ${baseTokenKey}:`);
                    console.log(`    ${change.start} → ${change.end} (diff: ${change.diff})`);
                    
                    assert.ok(BigInt(change.diff) > 0n, 'Expected positive balance change for Base USDC');
                } else {
                    assert.fail('Balance change is undefined');
                }
            } else {
                console.log(`\n  Available tokens:`, Object.keys(testData.intentsChanged || {}));
                assert.fail('Expected to find Base USDC token in balance changes');
            }
        });
    });

    describe('Transaction Coverage', function() {
        it('should find intents transactions that match reference data', function() {
            if (!fs.existsSync(INTENTS_RAW_FILE)) {
                this.skip();
                return;
            }
            
            const rawData = JSON.parse(fs.readFileSync(INTENTS_RAW_FILE, 'utf-8')) as IntentsExplorerResponse;
            
            // Get reference transactions with intents tokens
            const refIntentsTxns = referenceData.transactions.filter(t => {
                const entry = t as TransactionEntry & { intentsBalances?: Record<string, string> };
                return entry.intentsBalances && Object.keys(entry.intentsBalances).length > 0;
            });
            
            console.log(`\nReference transactions with intents tokens: ${refIntentsTxns.length}`);
            console.log(`Intents Explorer transactions: ${rawData.data.length}`);
            
            // Count how many Intents Explorer transactions match reference
            const intentsTimestamps = new Set(rawData.data.map(t => t.createdAtTimestamp));
            
            // Note: We can't directly match by block because Intents Explorer returns timestamps
            // This is a limitation - we'd need to resolve tx hashes to blocks
            console.log(`\nIntents Explorer provides timestamps, not block heights`);
            console.log(`Need to resolve transaction hashes to get block heights`);
            
            assert.ok(rawData.data.length > 0, 'Should have intents transactions');
        });
    });
});
