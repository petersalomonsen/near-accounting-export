import { describe, it } from 'mocha';
import assert from 'assert';
import { getAllBalances, getBalanceChangesAtBlock } from '../../scripts/balance-tracker.js';
import { detectGaps } from '../../scripts/gap-detection.js';
import type { TransactionEntry } from '../../scripts/get-account-history.js';

/**
 * Integration test for sparse balance representation fix.
 * 
 * This test validates the fix for the issue where NEAR-only transactions
 * incorrectly showed empty intentsTokens in balanceAfter.
 */
describe('Sparse Balance Integration - Real Account Data', function() {
    // Extend timeout for RPC calls
    this.timeout(60000);

    const accountId = 'webassemblymusic-treasury.sputnik-dao.near';

    it('should handle NEAR-only transaction without losing intents tokens (mock data)', async function() {
        // This simulates the actual scenario from the issue report
        // Block 178148637: act_proposal sending 100 NEAR (NEAR-only, no token transfers)
        
        // Create mock transaction entries to test gap detection
        const mockTransactions: TransactionEntry[] = [
            {
                block: 178148636,
                transactionBlock: 178148636,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                balanceBefore: {
                    near: '26669369671395456899999975',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:eth.omft.near': '35015088429776132',
                        'nep141:wrap.near': '800000000000000000000000'
                    },
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '26669369671395456899999975',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:eth.omft.near': '35015088429776132',
                        'nep141:wrap.near': '800000000000000000000000'
                    },
                    stakingPools: {}
                },
                changes: {
                    nearChanged: false,
                    tokensChanged: {},
                    intentsChanged: {}
                }
            },
            {
                block: 178148637,
                transactionBlock: 178148637,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                balanceBefore: {
                    near: '26669369671395456899999975',
                    fungibleTokens: {},
                    intentsTokens: {},  // Empty (sparse - not queried because NEAR-only tx)
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '26569424128999608199999975',  // NEAR decreased by 100 NEAR
                    fungibleTokens: {},
                    intentsTokens: {},  // Empty (sparse - not queried)
                    stakingPools: {}
                },
                changes: {
                    nearChanged: true,
                    nearDiff: '-99945542395848700000000',
                    tokensChanged: {},
                    intentsChanged: {}
                }
            },
            {
                block: 178148638,
                transactionBlock: 178148638,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                balanceBefore: {
                    near: '26569424128999608199999975',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:eth.omft.near': '35015088429776132',
                        'nep141:wrap.near': '800000000000000000000000'
                    },
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '26569424128999608199999975',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:eth.omft.near': '35015088429776132',
                        'nep141:wrap.near': '800000000000000000000000'
                    },
                    stakingPools: {}
                },
                changes: {
                    nearChanged: false,
                    tokensChanged: {},
                    intentsChanged: {}
                }
            }
        ];

        // Gap detection should NOT report any gaps
        // Even though middle transaction has empty intentsTokens, sparse mode means "not queried"
        const gapAnalysis = detectGaps(mockTransactions);

        console.log('\nGap analysis for NEAR-only transaction:');
        console.log('  Internal gaps:', gapAnalysis.internalGaps.length);
        console.log('  Complete:', gapAnalysis.isComplete);

        // With sparse balance representation, there should be NO internal gaps
        assert.strictEqual(
            gapAnalysis.internalGaps.length,
            0,
            'Should have no internal gaps - empty intentsTokens in sparse mode means not queried, not zero'
        );
        
        // Note: isComplete will be false because first transaction has non-zero balances
        // (indicating gap to account creation), but that's expected
        // What matters is that there are NO INTERNAL gaps between consecutive transactions
    });

    it('should detect gap when intents tokens actually change', async function() {
        // Test that we still detect gaps when tokens ACTUALLY change
        const mockTransactions: TransactionEntry[] = [
            {
                block: 1000,
                transactionBlock: 1000,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                balanceBefore: {
                    near: '1000000000000000000000000',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:wrap.near': '800000000000000000000000'
                    },
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '1000000000000000000000000',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:wrap.near': '700000000000000000000000'  // Changed
                    },
                    stakingPools: {}
                },
                changes: {
                    nearChanged: false,
                    tokensChanged: {},
                    intentsChanged: {
                        'nep141:wrap.near': {
                            start: '800000000000000000000000',
                            end: '700000000000000000000000',
                            diff: '-100000000000000000000000'
                        }
                    }
                }
            },
            {
                block: 1001,
                transactionBlock: 1001,
                timestamp: 0,
                transactionHashes: [],
                transactions: [],
                balanceBefore: {
                    near: '1000000000000000000000000',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:wrap.near': '600000000000000000000000'  // Mismatch!
                    },
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '1000000000000000000000000',
                    fungibleTokens: {},
                    intentsTokens: {
                        'nep141:wrap.near': '600000000000000000000000'
                    },
                    stakingPools: {}
                },
                changes: {
                    nearChanged: false,
                    tokensChanged: {},
                    intentsChanged: {}
                }
            }
        ];

        const gapAnalysis = detectGaps(mockTransactions);

        // Should detect gap because same token has different values
        assert.strictEqual(
            gapAnalysis.internalGaps.length,
            1,
            'Should detect gap when token values differ'
        );
        assert.strictEqual(
            gapAnalysis.internalGaps[0]?.verification.errors[0]?.type,
            'intents_balance_mismatch'
        );
    });
});
