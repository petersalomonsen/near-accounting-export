import { describe, it } from 'mocha';
import assert from 'assert';
import { getAllBalances, findLatestBalanceChangingBlock } from '../../scripts/balance-tracker.js';
import { detectGaps } from '../../scripts/gap-detection.js';
import type { TransactionEntry } from '../../scripts/get-account-history.js';

/**
 * Integration test to reproduce and fix the gap-filling failure
 * 
 * This test case demonstrates why the script cannot fill certain gaps:
 * - Binary search does not detect balance changes that occur at the receipt level
 * - The balance actually drops by ~0.1 NEAR at block 158500929
 * - But binary search reports hasChanges=false for the entire range
 * 
 * The gap is caused by transaction 3jCkU6aumU3Hqcnu2ymPLdYDDoGvh8x37KaPW3Z5xrcU
 * which creates a multi-block receipt chain spanning blocks 158500927-158500929
 */
describe('Gap Filling Failure - Block 158500928-158500955', function() {
    // Extend timeout for RPC calls
    this.timeout(120000);

    const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
    
    // Known token contracts
    const tokenContracts = [
        '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
        'wrap.near',
        'usdt.tether-token.near'
    ];
    
    // Known intents tokens
    const intentsTokens = [
        'nep141:eth.omft.near',
        'nep141:wrap.near',
        'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
        'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
    ];

    it('should reproduce the gap-filling failure using actual gap detection logic', async function() {
        // Create mock transaction entries matching the real data at gap boundaries
        const mockTransactions: TransactionEntry[] = [
            {
        block: 158500927,
        transactionBlock: 158500927,
        timestamp: 1754503934354162200,
        transactionHashes: ['3jCkU6aumU3Hqcnu2ymPLdYDDoGvh8x37KaPW3Z5xrcU'],
        transactions: [],
        transfers: [],
        balanceBefore: {
                near: '11302874475491463699999993',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '12286263',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '119000000'
                },
                stakingPools: {}
            },
            balanceAfter: {
                near: '11302958848502375799999992',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '12286263',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '119000000'
                },
                stakingPools: {}
            },
            changes: {
                nearChanged: true,
                nearDiff: '84373010912099999999',
                tokensChanged: {},
                intentsChanged: {}
            }
        },
        {
            block: 158500928,
            transactionBlock: 158500928,
            timestamp: 1754503934969112000,
            transactionHashes: ['3jCkU6aumU3Hqcnu2ymPLdYDDoGvh8x37KaPW3Z5xrcU'],
            transactions: [],
            transfers: [],
            balanceBefore: {
                near: '11302958848502375799999992',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '12286263',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '119000000'
                },
                stakingPools: {}
            },
            balanceAfter: {
                near: '11302958848502375799999992',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '12286263',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '89000000'
                },
                stakingPools: {}
            },
            changes: {
                nearChanged: false,
                tokensChanged: {},
                intentsChanged: {
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': {
                        start: '119000000',
                        end: '89000000',
                        diff: '-30000000'
                    }
                }
            }
        },
        {
            block: 158500955,
            transactionBlock: 158500955,
            timestamp: 1754503952092673800,
            transactionHashes: ['5ANx9uvRqt6cZV5tEAHqaYNSfMYksFRHSQt1PafF7HCw'],
            transactions: [],
            transfers: [],
            balanceBefore: {
                near: '11203022624413270199999992',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '12286263',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '89000000'
                },
                stakingPools: {}
            },
            balanceAfter: {
                near: '11203022624413270199999992',
                fungibleTokens: {
                    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '0',
                    'wrap.near': '0',
                    'usdt.tether-token.near': '0'
                },
                intentsTokens: {
                    'nep141:eth.omft.near': '5000000000000000',
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': '42286203',
                    'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1': '89000000'
                },
                stakingPools: {}
            },
            changes: {
                nearChanged: false,
                tokensChanged: {},
                intentsChanged: {
                    'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near': {
                        start: '12286263',
                        end: '42286203',
                        diff: '29999940'
                    }
                }
            }
        }
        ];

        console.log('\n=== Running Gap Detection ===');
        const gapAnalysis = detectGaps(mockTransactions);
        
        assert.strictEqual(gapAnalysis.internalGaps.length, 1, 'Should detect 1 internal gap');
        const gap = gapAnalysis.internalGaps[0];
        
        if (!gap) {
            throw new Error('Expected to find a gap but none was detected');
        }
        
        assert.strictEqual(gap.startBlock, 158500928, 'Gap should start at block 158500928');
        assert.strictEqual(gap.endBlock, 158500955, 'Gap should end at block 158500955');
        
        console.log(`Detected gap: blocks ${gap.startBlock} - ${gap.endBlock}`);
        
        // Try binary search to find the balance-changing block
        console.log('\n=== Running Binary Search ===');
        const result = await findLatestBalanceChangingBlock(
            accountId,
            gap.startBlock,      // Search from 158500928 (the last known good block)
            gap.endBlock - 1,    // to 158500954 (the block before the next transaction)
            tokenContracts,
            intentsTokens
        );
        
        console.log(`Binary search result: hasChanges=${result.hasChanges}, block=${result.block}`);
        if (result.hasChanges) {
            console.log(`  Found change at block ${result.block}:`);
            console.log(`    NEAR changed: ${result.nearChanged}`);
            console.log(`    Tokens changed: ${JSON.stringify(result.tokensChanged)}`);
            console.log(`    Intents changed: ${JSON.stringify(result.intentsChanged)}`);
        } else {
            console.log('  No balance changes detected in the range');
        }
        
        // Simulate reconciliation: check if balances match when re-fetched
        console.log('\n=== Attempting Reconciliation ===');
        const balanceAfter928 = await getAllBalances(accountId, 158500928, tokenContracts, intentsTokens);
        const balanceBefore955 = await getAllBalances(accountId, 158500954, tokenContracts, intentsTokens); // block before 955
        
        const nearMatches = balanceAfter928.near === balanceBefore955.near;
        console.log(`NEAR balances match: ${nearMatches}`);
        if (!nearMatches) {
            console.log(`  Block 158500928: ${balanceAfter928.near}`);
            console.log(`  Block 158500954: ${balanceBefore955.near}`);
            console.log(`  Difference: ${BigInt(balanceAfter928.near) - BigInt(balanceBefore955.near)}`);
        }
        
        // The test should show that reconciliation fails (gap is real)
        assert.strictEqual(nearMatches, false, 'Gap should be real - balances should not match');
        
        console.log('\n=== Conclusion ===');
        console.log('This gap cannot be filled by the current logic because:');
        console.log('1. APIs do not return a transaction at block 158500929 (where the change occurs)');
        console.log('2. Binary search does not find the block (likely because it checks at the transaction level, not receipt level)');
        console.log('3. Reconciliation confirms the gap is real - balances actually differ');
        console.log('4. The ~0.1 NEAR drop at block 158500929 is likely from a receipt in a multi-block transaction chain');
        
        // TEST ASSERTION: After fixing the binary search, the gap SHOULD be fillable
        // This will fail until we implement receipt-level balance change detection
        console.log('\n=== Final Assertion ===');
        if (result.hasChanges && result.block !== undefined) {
            console.log('SUCCESS: Binary search detected the balance change');
            // Re-run gap detection with the new transaction
            const newTransaction: TransactionEntry = {
                block: result.block,
                transactionBlock: result.block,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                transfers: [],
                balanceBefore: await getAllBalances(accountId, result.block - 1, tokenContracts, intentsTokens),
                balanceAfter: await getAllBalances(accountId, result.block, tokenContracts, intentsTokens),
                changes: {
                    nearChanged: result.nearChanged,
                    tokensChanged: result.tokensChanged,
                    intentsChanged: result.intentsChanged
                }
            };
            
            const updatedTransactions = [...mockTransactions, newTransaction].sort((a, b) => a.block - b.block);
            
            const finalGapAnalysis = detectGaps(updatedTransactions);
            assert.strictEqual(finalGapAnalysis.internalGaps.length, 0, 'After filling, there should be no gaps');
        } else {
            console.log('FAILURE: Binary search did not detect the balance change (expected to fail until fixed)');
            assert.strictEqual(result.hasChanges, true, 'Binary search should detect balance changes at receipt level - THIS WILL FAIL UNTIL FIXED');
        }
    });
});
