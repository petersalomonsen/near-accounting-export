import { describe, it } from 'mocha';
import assert from 'assert';
import { compareBalances, type BalanceSnapshot } from '../../scripts/gap-detection.js';

/**
 * Unit tests for sparse balance representation.
 * 
 * When balance snapshots are sparse (only contain tokens that changed),
 * gap detection should only compare tokens that appear in BOTH snapshots.
 */
describe('Sparse Balance Representation', function() {
    describe('compareBalances with sparse balances', function() {
        it('should not report gap when token is missing from one snapshot', function() {
            // This simulates a NEAR-only transaction where intents tokens weren't queried
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},  // Empty - not queried
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '800000000000000000000000',
                    'nep141:eth.omft.near': '35015088429776132'
                },  // Has intents tokens from previous transaction
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            // Should be valid - missing tokens in sparse snapshot are not mismatches
            assert.strictEqual(result.valid, true, 'Should be valid when tokens are missing from one snapshot');
            assert.strictEqual(result.errors.length, 0, 'Should have no errors');
        });

        it('should detect gap when same token has different values', function() {
            // Both snapshots have the same token but with different values
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '800000000000000000000000'
                },
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '700000000000000000000000'  // Different value
                },
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            // Should be invalid - same token with different values is a mismatch
            assert.strictEqual(result.valid, false, 'Should be invalid when token values differ');
            assert.strictEqual(result.errors.length, 1, 'Should have one error');
            assert.strictEqual(result.errors[0]?.type, 'intents_balance_mismatch');
            assert.strictEqual(result.errors[0]?.token, 'nep141:wrap.near');
        });

        it('should not compare NEAR when one balance is zero (sparse mode)', function() {
            // NEAR of '0' might mean "not queried" in sparse mode
            const balanceAfter: BalanceSnapshot = {
                near: '0',  // Not queried
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '800000000000000000000000'
                },
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '800000000000000000000000'
                },
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            // With sparse representation, NEAR of '0' means not queried, so we don't compare
            // This is the expected behavior for sparse balances
            assert.strictEqual(result.valid, true, 'Should be valid when NEAR is zero (not queried)');
        });

        it('should detect NEAR mismatch when both are non-zero', function() {
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '2000000000000000000000000',  // Different non-zero value
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            assert.strictEqual(result.valid, false, 'Should be invalid when NEAR values differ');
            assert.strictEqual(result.errors.length, 1, 'Should have one error');
            assert.strictEqual(result.errors[0]?.type, 'near_balance_mismatch');
        });

        it('should handle fungible tokens correctly in sparse mode', function() {
            // FT token in previous but not in current (sparse - not queried)
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},  // Empty - not queried
                intentsTokens: {},
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {
                    'wrap.near': '500000000000000000000000'
                },
                intentsTokens: {},
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            assert.strictEqual(result.valid, true, 'Should be valid when FT is missing from one snapshot');
        });

        it('should detect FT mismatch when present in both', function() {
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {
                    'wrap.near': '500000000000000000000000'
                },
                intentsTokens: {},
                stakingPools: {}
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {
                    'wrap.near': '600000000000000000000000'  // Different value
                },
                intentsTokens: {},
                stakingPools: {}
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            assert.strictEqual(result.valid, false, 'Should be invalid when FT values differ');
            assert.strictEqual(result.errors[0]?.type, 'token_balance_mismatch');
        });

        it('should handle staking pools correctly in sparse mode', function() {
            const balanceAfter: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}  // Empty - not queried
            };

            const balanceBefore: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {
                    'pool1.poolv1.near': '5000000000000000000000000'
                }
            };

            const result = compareBalances(balanceAfter, balanceBefore);
            
            assert.strictEqual(result.valid, true, 'Should be valid when staking pool is missing from one snapshot');
        });
    });

    describe('Real-world scenario from issue', function() {
        it('should not lose intents tokens on NEAR-only transaction (issue example)', function() {
            // This is the bug from the issue - NEAR-only transaction at block 178148637
            const balanceBefore: BalanceSnapshot = {
                near: '26669369671395456899999975',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:eth.omft.near': '35015088429776132',
                    'nep141:wrap.near': '800000000000000000000000'
                },
                stakingPools: {}
            };

            // After the fix: balanceAfter only includes NEAR (what changed)
            // Intents tokens are not included because they weren't queried (sparse)
            const balanceAfter: BalanceSnapshot = {
                near: '26569424128999608199999975',  // Changed
                fungibleTokens: {},
                intentsTokens: {},  // Empty (sparse - not queried, not changed)
                stakingPools: {}
            };

            // Now check connectivity with next transaction that has intents change
            const nextBalanceBefore: BalanceSnapshot = {
                near: '26569424128999608199999975',
                fungibleTokens: {},
                intentsTokens: {
                    'nep141:wrap.near': '800000000000000000000000'  // Same as original
                },
                stakingPools: {}
            };

            // With sparse representation, balanceAfter (empty) vs nextBalanceBefore (has tokens)
            // should NOT be a mismatch, because empty means "not queried" not "zero"
            const result = compareBalances(balanceAfter, nextBalanceBefore);
            
            assert.strictEqual(result.valid, true, 
                'Should be valid - empty intentsTokens in sparse mode means not queried, not zero');
            assert.strictEqual(result.errors.length, 0, 'Should have no errors');
        });
    });
});
