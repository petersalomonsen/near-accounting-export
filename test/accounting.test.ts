// Test case for the balance tracker and account history functionality
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Go up two levels: dist/test -> dist -> root
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import {
    getCurrentBlockHeight,
    viewAccount,
    callViewFunction,
    setStopSignal
} from '../scripts/rpc.js';
import {
    getAllBalances,
    findLatestBalanceChangingBlock,
    findBalanceChangingTransaction,
    clearBalanceCache
} from '../scripts/balance-tracker.js';
import type { BalanceSnapshot } from '../scripts/balance-tracker.js';
import {
    getAccountHistory,
    verifyHistoryFile
} from '../scripts/get-account-history.js';

// Helper to check if RPC is available
async function isRpcAvailable(): Promise<boolean> {
    try {
        await getCurrentBlockHeight();
        return true;
    } catch (e) {
        return false;
    }
}

describe('NEAR Accounting Export', function() {
    // These tests make real RPC calls and may take time
    this.timeout(120000);
    
    let rpcAvailable = false;

    before(async function() {
        setStopSignal(false);
        rpcAvailable = await isRpcAvailable();
        if (!rpcAvailable) {
            console.log('Note: RPC endpoint not available, network-dependent tests will be skipped');
        }
    });

    beforeEach(function() {
        setStopSignal(false);
        clearBalanceCache();
    });

    describe('RPC Module', function() {
        it('should get current block height', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            const blockHeight = await getCurrentBlockHeight();
            assert.ok(typeof blockHeight === 'number', 'Block height should be a number');
            assert.ok(blockHeight > 100000000, 'Block height should be greater than 100M (mainnet)');
            console.log(`Current block height: ${blockHeight}`);
        });

        it('should view account details', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            const accountId = 'near';
            const account = await viewAccount(accountId, 'final');
            
            assert.ok(account, 'Account should exist');
            assert.ok(account.amount, 'Account should have amount');
            console.log(`Account ${accountId} balance: ${account.amount}`);
        });

        it('should view account at historical block', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            const accountId = 'near';
            const currentBlock = await getCurrentBlockHeight();
            const historicalBlock = currentBlock - 1000;
            
            const account = await viewAccount(accountId, historicalBlock);
            assert.ok(account, 'Account should exist at historical block');
            assert.ok(account.amount, 'Account should have amount at historical block');
        });

        it('should handle non-existent account gracefully', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            const accountId = 'this-account-definitely-does-not-exist-12345.near';
            
            try {
                const account = await viewAccount(accountId, 'final');
                // If we get here without error, check if amount is 0
                assert.equal(account.amount, '0', 'Non-existent account should have 0 balance');
            } catch (error: any) {
                // It's also valid for this to throw an error about account not existing
                assert.ok(error.message.includes('does not exist'), 'Should indicate account does not exist');
            }
        });
    });

    describe('Balance Tracker', function() {
        it('should get all balances for an account', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            const accountId = 'near';
            const balances = await getAllBalances(accountId, 'final');
            
            assert.ok(balances, 'Balances should be returned');
            assert.ok(balances.near, 'Should have NEAR balance');
            assert.ok(balances.fungibleTokens !== undefined, 'Should have fungible tokens object');
            assert.ok(balances.intentsTokens !== undefined, 'Should have intents tokens object');
            
            console.log('Balances:', JSON.stringify(balances, null, 2));
        });

        it('should detect balance changes between blocks', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // Use a well-known active account for testing
            const accountId = 'relay.tg';
            const currentBlock = await getCurrentBlockHeight();
            
            // Search in a small range to find any change
            const result = await findLatestBalanceChangingBlock(
                accountId,
                currentBlock - 10000,
                currentBlock
            );
            
            assert.ok(result, 'Should return result');
            // Note: It's possible there are no changes in this range, which is valid
            console.log('Balance change result:', JSON.stringify(result, null, 2));
        });
    });

    describe('Account History', function() {
        const testOutputFile = path.join(__dirname, 'test-output.json');

        afterEach(function() {
            // Clean up test output file
            if (fs.existsSync(testOutputFile)) {
                fs.unlinkSync(testOutputFile);
            }
        });

        it('should fetch account history and save to file', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // Use an account known to have some activity
            const accountId = 'relay.tg';
            
            const history = await getAccountHistory({
                accountId,
                outputFile: testOutputFile,
                direction: 'backward',
                maxTransactions: 2 // Just fetch 2 for testing
            });

            assert.ok(history, 'History should be returned');
            assert.equal(history.accountId, accountId, 'Account ID should match');
            assert.ok(Array.isArray(history.transactions), 'Should have transactions array');
            assert.ok(history.metadata, 'Should have metadata');
            
            // Verify file was saved
            assert.ok(fs.existsSync(testOutputFile), 'Output file should exist');
            
            const savedHistory = JSON.parse(fs.readFileSync(testOutputFile, 'utf-8'));
            assert.equal(savedHistory.accountId, accountId, 'Saved account ID should match');
            
            console.log(`Fetched ${history.transactions.length} transactions`);
        });

        it('should verify history file connectivity', async function() {
            // Create a mock history file with valid connectivity
            const mockHistory = {
                accountId: 'test.near',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transactions: [
                    {
                        block: 100,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        balanceBefore: { near: '1000', fungibleTokens: {}, intentsTokens: {} },
                        balanceAfter: { near: '900', fungibleTokens: {}, intentsTokens: {} },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-100',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    },
                    {
                        block: 200,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        balanceBefore: { near: '900', fungibleTokens: {}, intentsTokens: {} },
                        balanceAfter: { near: '800', fungibleTokens: {}, intentsTokens: {} },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-100',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 100,
                    lastBlock: 200,
                    totalTransactions: 2
                }
            };

            fs.writeFileSync(testOutputFile, JSON.stringify(mockHistory, null, 2));
            
            const results = verifyHistoryFile(testOutputFile);
            assert.ok(results.valid, 'Mock history should be valid');
            assert.equal(results.errorCount, 0, 'Should have no errors');
        });

        it('should detect connectivity issues in history file', async function() {
            // Create a mock history file with invalid connectivity
            const mockHistory = {
                accountId: 'test.near',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transactions: [
                    {
                        block: 100,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        balanceBefore: { near: '1000', fungibleTokens: {}, intentsTokens: {} },
                        balanceAfter: { near: '900', fungibleTokens: {}, intentsTokens: {} },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-100',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    },
                    {
                        block: 200,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        // Note: balanceBefore should be 900 to match previous balanceAfter
                        balanceBefore: { near: '850', fungibleTokens: {}, intentsTokens: {} },
                        balanceAfter: { near: '800', fungibleTokens: {}, intentsTokens: {} },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-50',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 100,
                    lastBlock: 200,
                    totalTransactions: 2
                }
            };

            fs.writeFileSync(testOutputFile, JSON.stringify(mockHistory, null, 2));
            
            const results = verifyHistoryFile(testOutputFile);
            assert.ok(!results.valid, 'Mock history should be invalid');
            assert.ok(results.errorCount > 0, 'Should have errors');
            assert.ok(results.errors.some(e => e.errors.some(err => err.type === 'near_balance_mismatch')), 
                'Should detect NEAR balance mismatch');
        });
    });

    describe('Transaction Discovery', function() {
        it('should find transaction that caused balance change', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // This test requires finding a real block with a balance change
            // We'll use a recent block range and see if we can find any transactions
            const accountId = 'relay.tg';
            const currentBlock = await getCurrentBlockHeight();
            
            // First find a block with a balance change
            const balanceChange = await findLatestBalanceChangingBlock(
                accountId,
                currentBlock - 5000,
                currentBlock
            );

            if (balanceChange.hasChanges && balanceChange.block) {
                console.log(`Found balance change at block ${balanceChange.block}`);
                
                const txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block);
                
                assert.ok(txInfo, 'Should return transaction info');
                assert.ok(Array.isArray(txInfo.transactionHashes), 'Should have transaction hashes array');
                console.log('Transaction info:', JSON.stringify(txInfo, null, 2));
            } else {
                console.log('No balance changes found in range - this is valid');
            }
        });

        it('should handle missing blocks gracefully during search', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // Block 163181131 is a known missing/skipped block in the archival RPC
            // Search a small range around it to ensure missing block handling works
            const accountId = 'near';
            const missingBlock = 163181131;
            
            // Search a small range that includes the missing block
            // This should not throw an error - the retry logic should handle it
            const balanceChange = await findLatestBalanceChangingBlock(
                accountId,
                missingBlock - 5,
                missingBlock + 5
            );

            // The search should complete without throwing
            assert.ok(balanceChange !== undefined, 'Should return a result even with missing blocks');
            console.log(`Missing block search result: hasChanges=${balanceChange.hasChanges}, block=${balanceChange.block}`);
        });

        it('should find intents balance change at block 151391583', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // This is a known case where an intents ft_withdraw receipt was executed at block 151391583
            // The intents balance for nep141:eth.omft.near changed from 10000000000000000 to 5000000000000000
            // Starting search from 151391584 should find this change at 151391583
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            
            // Search backward from 151391584 to find the change at 151391583
            const balanceChange = await findLatestBalanceChangingBlock(
                accountId,
                151391582,  // Start block (before the change)
                151391584   // End block (after the change)
            );

            console.log(`Intents balance change search result: hasChanges=${balanceChange.hasChanges}, block=${balanceChange.block}`);
            console.log('Start balance intents:', JSON.stringify(balanceChange.startBalance?.intentsTokens, null, 2));
            console.log('End balance intents:', JSON.stringify(balanceChange.endBalance?.intentsTokens, null, 2));
            
            // The search should find a change
            assert.ok(balanceChange.hasChanges, 'Should detect balance change in this range');
            // The change should be detected at block 151391583 or 151391584
            assert.ok(balanceChange.block === 151391583 || balanceChange.block === 151391584, 
                `Should find change at block 151391583 or 151391584, got ${balanceChange.block}`);
            
            // Verify intents token changed
            assert.ok(balanceChange.intentsChanged && Object.keys(balanceChange.intentsChanged).length > 0,
                'Should detect intents token change');
            console.log('Intents changes:', JSON.stringify(balanceChange.intentsChanged, null, 2));
        });

        it('should find transfer counterparties for NEAR, FT, and Intents transfers', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // Test that findBalanceChangingTransaction extracts transfer details including counterparties
            // Using known blocks where specific types of transfers occurred
            
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            
            // Block 151391583: MT (intents) burn event - withdrawing ETH from intents.near
            // This should show: type=mt, direction=out, counterparty=intents.near
            console.log('\n=== Testing MT (Intents) transfer at block 151391583 ===');
            const mtTxInfo = await findBalanceChangingTransaction(accountId, 151391583);
            
            assert.ok(mtTxInfo.transactionHashes.length > 0, 'Should find transaction hash');
            console.log('Transaction hashes:', mtTxInfo.transactionHashes);
            console.log('Transfers found:', mtTxInfo.transfers.length);
            
            // Should find the mt_burn event
            const mtTransfer = mtTxInfo.transfers.find(t => t.type === 'mt');
            assert.ok(mtTransfer, 'Should find MT (intents) transfer');
            assert.equal(mtTransfer.direction, 'out', 'MT transfer should be outgoing (burn)');
            assert.equal(mtTransfer.counterparty, 'intents.near', 'MT transfer counterparty should be intents.near');
            assert.ok(mtTransfer.tokenId?.includes('eth.omft.near'), 'Should be ETH token');
            assert.equal(mtTransfer.amount, '5000000000000000', 'Amount should match the burn amount');
            console.log('MT Transfer:', JSON.stringify(mtTransfer, null, 2));
            
            // Block 151391587: NEAR transfer out to petersalomonsen.near
            // This should show: type=near, direction=out, counterparty=petersalomonsen.near
            console.log('\n=== Testing NEAR transfer at block 151391587 ===');
            const nearTxInfo = await findBalanceChangingTransaction(accountId, 151391587);
            
            console.log('Transfers found:', nearTxInfo.transfers.length);
            
            // Should find the NEAR transfer
            const nearTransfer = nearTxInfo.transfers.find(t => t.type === 'near');
            assert.ok(nearTransfer, 'Should find NEAR transfer');
            assert.equal(nearTransfer.direction, 'out', 'NEAR transfer should be outgoing');
            assert.equal(nearTransfer.counterparty, 'petersalomonsen.near', 'NEAR transfer should be to petersalomonsen.near');
            assert.equal(nearTransfer.amount, '100000000000000000000000', 'Amount should be 100 NEAR in yoctoNEAR');
            console.log('NEAR Transfer:', JSON.stringify(nearTransfer, null, 2));
            
            // Summary
            console.log('\n=== Transfer Counterparty Test Summary ===');
            console.log('MT transfer: direction=%s, counterparty=%s, token=%s', 
                mtTransfer.direction, mtTransfer.counterparty, mtTransfer.tokenId);
            console.log('NEAR transfer: direction=%s, counterparty=%s, amount=%s', 
                nearTransfer.direction, nearTransfer.counterparty, nearTransfer.amount);
        });

        it('should fill gaps in existing history file with intents balance mismatch', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // BUG REPRODUCTION TEST: Gap-filling doesn't find the missing transaction
            // 
            // Real data from webassemblymusic-treasury.sputnik-dao.near where:
            // - Block 151391582: balanceAfter.intentsTokens["nep141:eth.omft.near"] = "10000000000000000"
            // - Block 151391586: balanceBefore.intentsTokens["nep141:eth.omft.near"] = "5000000000000000"
            // 
            // There's a missing transaction at block 151391583 where the eth balance changed
            // from 10000000000000000 to 5000000000000000 (an ft_withdraw on intents.near)
            
            const gappedHistory = {
                accountId: 'webassemblymusic-treasury.sputnik-dao.near',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                transactions: [
                    {
                        block: 151391582,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        balanceBefore: {
                            near: '11200437557049643499999999',
                            fungibleTokens: {
                                '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                                'wrap.near': '0',
                                'usdt.tether-token.near': '0'
                            },
                            intentsTokens: {
                                'nep141:eth.omft.near': '10000000000000000'
                            }
                        },
                        balanceAfter: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {
                                '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                                'wrap.near': '0',
                                'usdt.tether-token.near': '0'
                            },
                            intentsTokens: {
                                'nep141:eth.omft.near': '10000000000000000'
                            }
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '76155685441399999999',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    },
                    {
                        block: 151391586,
                        timestamp: null,
                        transactionHashes: [],
                        transactions: [],
                        balanceBefore: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {
                                '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                                'wrap.near': '0',
                                'usdt.tether-token.near': '0'
                            },
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        },
                        balanceAfter: {
                            near: '11100569862488061499999998',
                            fungibleTokens: {
                                '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                                'wrap.near': '0',
                                'usdt.tether-token.near': '0'
                            },
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-99943850247023400000000',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 151391582,
                    lastBlock: 151391586,
                    totalTransactions: 2
                }
            };
            
            // Write the gapped history to a temp file
            const gapTestFile = path.join(__dirname, 'gap-test-output.json');
            fs.writeFileSync(gapTestFile, JSON.stringify(gappedHistory, null, 2));
            
            try {
                // First verify that the gap is detected
                const beforeResults = verifyHistoryFile(gapTestFile);
                assert.ok(!beforeResults.valid, 'History should have gaps before filling');
                assert.ok(beforeResults.errors.some(e => 
                    e.errors.some(err => err.type === 'intents_balance_mismatch' && 
                        err.token === 'nep141:eth.omft.near')),
                    'Should detect intents eth balance mismatch');
                
                console.log('Gap detected between blocks 151391582 and 151391586');
                console.log('Expected missing transaction at block 151391583 with intents change');
                
                // Now run getAccountHistory which should fill the gap
                // Setting maxTransactions to 1 so we only fill the gap and don't search for more
                const history = await getAccountHistory({
                    accountId: 'webassemblymusic-treasury.sputnik-dao.near',
                    outputFile: gapTestFile,
                    direction: 'backward',
                    maxTransactions: 1 // Only fill gaps, don't search for more
                });
                
                // Check that the gap was filled
                const block151391583 = history.transactions.find(t => t.block === 151391583);
                assert.ok(block151391583, 'Block 151391583 should have been found and added');
                
                // Verify the intents change was recorded
                assert.ok(block151391583.changes.intentsChanged['nep141:eth.omft.near'],
                    'Should have intents eth change recorded at block 151391583');
                
                // Verify connectivity is now valid
                const afterResults = verifyHistoryFile(gapTestFile);
                assert.ok(afterResults.valid, 'History should be valid after gap filling');
                
                // Verify that verificationWithNext fields were updated
                // Block 151391582 should now have valid verificationWithNext pointing to 151391583
                const block151391582 = history.transactions.find(t => t.block === 151391582);
                assert.ok(block151391582, 'Block 151391582 should exist');
                assert.ok(block151391582.verificationWithNext, 'Block 151391582 should have verificationWithNext');
                assert.ok(block151391582.verificationWithNext.valid, 
                    'Block 151391582 verificationWithNext should be valid after gap fill');
                
                // Block 151391583 should have valid verificationWithNext pointing to 151391586
                assert.ok(block151391583.verificationWithNext, 'Block 151391583 should have verificationWithNext');
                assert.ok(block151391583.verificationWithNext.valid,
                    'Block 151391583 verificationWithNext should be valid');
                
                console.log('Gap successfully filled with transaction at block 151391583');
                console.log('Intents change:', block151391583.changes.intentsChanged);
                console.log('Block 151391582 verificationWithNext:', block151391582.verificationWithNext);
            } finally {
                // Cleanup
                if (fs.existsSync(gapTestFile)) {
                    fs.unlinkSync(gapTestFile);
                }
            }
        });

        it('should automatically enrich existing transactions with transfer details', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            
            // This test verifies that when we load an existing history file with transactions
            // that don't have transfer details, the system automatically enriches them
            
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const enrichTestFile = path.join(__dirname, 'test-enrich-history.json');
            
            try {
                // Create a history file with a transaction that has NO transfers field
                // Use block 151391587 which we know has a NEAR transfer to petersalomonsen.near
                const historyWithoutTransfers = {
                    accountId,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    transactions: [
                        {
                            block: 151391587,
                            timestamp: 1732783100000000000,
                            transactionHashes: ['someHash'],
                            transactions: [],
                            // NO transfers field - this should trigger enrichment
                            balanceBefore: {
                                near: '1000000000000000000000000',
                                fungibleTokens: {},
                                intentsTokens: {}
                            },
                            balanceAfter: {
                                near: '900000000000000000000000',
                                fungibleTokens: {},
                                intentsTokens: {}
                            },
                            changes: {
                                nearChanged: true,
                                nearDiff: '-100000000000000000000000',
                                tokensChanged: {},
                                intentsChanged: {}
                            }
                        }
                    ],
                    metadata: {
                        firstBlock: 151391587,
                        lastBlock: 151391587,
                        totalTransactions: 1
                    }
                };
                
                // Write the history file without transfers
                fs.writeFileSync(enrichTestFile, JSON.stringify(historyWithoutTransfers, null, 2));
                
                // Run getAccountHistory - it should automatically enrich the transaction
                const history = await getAccountHistory({
                    accountId,
                    outputFile: enrichTestFile,
                    direction: 'backward',
                    maxTransactions: 0,  // Don't search for new transactions
                    startBlock: 151391587,
                    endBlock: 151391587
                });
                
                // Find the transaction at block 151391587
                const tx = history.transactions.find(t => t.block === 151391587);
                assert.ok(tx, 'Transaction at block 151391587 should exist');
                
                // Verify that transfers were added
                assert.ok(tx.transfers, 'Transaction should now have transfers field');
                assert.ok(tx.transfers.length > 0, 'Transaction should have at least one transfer');
                
                // Verify the NEAR transfer details
                const nearTransfer = tx.transfers.find(t => t.type === 'near' && t.direction === 'out');
                assert.ok(nearTransfer, 'Should have an outgoing NEAR transfer');
                assert.equal(nearTransfer.counterparty, 'petersalomonsen.near', 
                    'NEAR transfer should be to petersalomonsen.near');
                assert.equal(nearTransfer.amount, '100000000000000000000000', 
                    'NEAR transfer should be 0.1 NEAR');
                
                console.log('Transaction successfully enriched with transfer details:');
                console.log('Transfers:', JSON.stringify(tx.transfers, null, 2));
            } finally {
                // Cleanup
                if (fs.existsSync(enrichTestFile)) {
                    fs.unlinkSync(enrichTestFile);
                }
            }
        });

        it('should find ALL balance changes when multiple occur in adjacent blocks', async function() {
            if (!rpcAvailable) {
                this.skip();
                return;
            }
            // BUG REPRODUCTION TEST:
            // There are balance changes at blocks 151391582, 151391583, and 151391586 for this account.
            // When searching backward from 151391586, findLatestBalanceChangingBlock returns the 
            // "latest" change, which means:
            // 1. First search finds 151391586
            // 2. Then we search 151391580-151391585, which finds 151391582 (the latest in that range)
            // 3. We miss 151391583 because after finding 151391582, we move to earlier ranges
            //
            // This test demonstrates that searching the range 151391580-151391586 will return
            // block 151391586 (the latest), then 151391582 (the latest before that), 
            // but MISS 151391583 which is in between.
            
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const foundBlocks: number[] = [];
            
            // Simulate the backward search algorithm
            let searchEnd = 151391586;
            const searchStart = 151391580;
            
            // First search: find the latest change in the range
            let result = await findLatestBalanceChangingBlock(accountId, searchStart, searchEnd);
            if (result.hasChanges && result.block) {
                foundBlocks.push(result.block);
                console.log(`First search found block: ${result.block}`);
                
                // Second search: find the next change before the one we just found
                searchEnd = result.block - 1;
                result = await findLatestBalanceChangingBlock(accountId, searchStart, searchEnd);
                if (result.hasChanges && result.block) {
                    foundBlocks.push(result.block);
                    console.log(`Second search found block: ${result.block}`);
                    
                    // Third search: continue backward
                    searchEnd = result.block - 1;
                    result = await findLatestBalanceChangingBlock(accountId, searchStart, searchEnd);
                    if (result.hasChanges && result.block) {
                        foundBlocks.push(result.block);
                        console.log(`Third search found block: ${result.block}`);
                    }
                }
            }
            
            console.log('All blocks found by backward search:', foundBlocks);
            
            // The bug: block 151391583 should be found, but it's missed because
            // the search jumps from 151391586 to 151391582, skipping 151391583
            const expectedBlocks = [151391586, 151391583, 151391582];
            const foundExpected = expectedBlocks.filter(b => foundBlocks.includes(b));
            const missed = expectedBlocks.filter(b => !foundBlocks.includes(b));
            
            console.log('Expected blocks:', expectedBlocks);
            console.log('Found expected:', foundExpected);
            console.log('Missed blocks:', missed);
            
            // This assertion will FAIL until we fix the bug
            // Currently the search finds [151391586, 151391582] but misses 151391583
            assert.deepEqual(foundBlocks.sort((a,b) => b-a), expectedBlocks.sort((a,b) => b-a),
                `Should find all balance-changing blocks. Missed: ${missed.join(', ')}`);
        });
    });
});
