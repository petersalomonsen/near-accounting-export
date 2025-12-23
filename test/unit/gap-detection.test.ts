import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import {
    detectGaps,
    compareBalances,
    isZeroBalance,
    isStakingOnlyEntry,
    getGapChangedAssets,
    getAllTokensFromGaps,
    type TransactionEntry,
    type BalanceSnapshot,
    type Gap,
    type VerificationResult
} from '../../scripts/gap-detection.js';

/**
 * Helper to create a minimal transaction entry for testing
 */
function createTx(
    block: number,
    balanceBefore: Partial<BalanceSnapshot>,
    balanceAfter: Partial<BalanceSnapshot>,
    options?: {
        transactionHashes?: string[];
        changes?: TransactionEntry['changes'];
    }
): TransactionEntry {
    return {
        block,
        balanceBefore: {
            near: balanceBefore.near || '0',
            fungibleTokens: balanceBefore.fungibleTokens || {},
            intentsTokens: balanceBefore.intentsTokens || {},
            stakingPools: balanceBefore.stakingPools || {}
        },
        balanceAfter: {
            near: balanceAfter.near || '0',
            fungibleTokens: balanceAfter.fungibleTokens || {},
            intentsTokens: balanceAfter.intentsTokens || {},
            stakingPools: balanceAfter.stakingPools || {}
        },
        transactionHashes: options?.transactionHashes || ['tx_hash_' + block],
        changes: options?.changes || {
            nearChanged: balanceBefore.near !== balanceAfter.near,
            tokensChanged: {},
            intentsChanged: {}
        }
    } as TransactionEntry;
}

describe('Gap Detection', () => {
    describe('compareBalances', () => {
        it('should return valid when balances match exactly', () => {
            const balance: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: { 'wrap.near': '500' },
                intentsTokens: { 'nep141:eth.omft.near': '100' },
                stakingPools: {}
            };
            
            const result = compareBalances(balance, balance);
            assert.strictEqual(result.valid, true);
            assert.strictEqual(result.errors.length, 0);
        });

        it('should detect NEAR balance mismatch', () => {
            const expected: BalanceSnapshot = {
                near: '1000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '900000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]?.type, 'near_balance_mismatch');
        });

        it('should detect fungible token balance mismatch', () => {
            const expected: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '500' },
                intentsTokens: {},
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '400' },
                intentsTokens: {},
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]?.type, 'token_balance_mismatch');
            assert.strictEqual(result.errors[0]?.token, 'wrap.near');
        });

        it('should detect intents token balance mismatch', () => {
            const expected: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: { 'nep141:eth.omft.near': '100' },
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: { 'nep141:eth.omft.near': '50' },
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]?.type, 'intents_balance_mismatch');
            assert.strictEqual(result.errors[0]?.token, 'nep141:eth.omft.near');
        });

        it('should detect multiple mismatches at once', () => {
            const expected: BalanceSnapshot = {
                near: '1000',
                fungibleTokens: { 'wrap.near': '500' },
                intentsTokens: { 'nep141:eth.omft.near': '100' },
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '900',
                fungibleTokens: { 'wrap.near': '400' },
                intentsTokens: { 'nep141:eth.omft.near': '50' },
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 3);
        });

        it('should detect token appearing from zero', () => {
            const expected: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '500' },
                intentsTokens: {},
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]?.type, 'token_balance_mismatch');
        });

        it('should detect token disappearing to zero', () => {
            const expected: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '500' },
                intentsTokens: {},
                stakingPools: {}
            };
            const actual: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
        });

        it('should handle undefined balances as zero', () => {
            const result = compareBalances(undefined, undefined);
            assert.strictEqual(result.valid, true);
        });

        it('should detect staking pool balance mismatch', () => {
            const expected: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: { 'pool.near': '1000000000000000000000000' }
            };
            const actual: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: { 'pool.near': '1100000000000000000000000' }
            };
            
            const result = compareBalances(expected, actual);
            assert.strictEqual(result.valid, false);
            assert.strictEqual(result.errors.length, 1);
            assert.strictEqual(result.errors[0]?.type, 'staking_balance_mismatch');
            assert.strictEqual(result.errors[0]?.pool, 'pool.near');
        });
    });

    describe('isZeroBalance', () => {
        it('should return true for undefined', () => {
            assert.strictEqual(isZeroBalance(undefined), true);
        });

        it('should return true for all-zero balance', () => {
            const balance: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '0' },
                intentsTokens: {},
                stakingPools: {}
            };
            assert.strictEqual(isZeroBalance(balance), true);
        });

        it('should return false when NEAR is non-zero', () => {
            const balance: BalanceSnapshot = {
                near: '1000',
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            assert.strictEqual(isZeroBalance(balance), false);
        });

        it('should return false when a token is non-zero', () => {
            const balance: BalanceSnapshot = {
                near: '0',
                fungibleTokens: { 'wrap.near': '100' },
                intentsTokens: {},
                stakingPools: {}
            };
            assert.strictEqual(isZeroBalance(balance), false);
        });

        it('should return false when an intents token is non-zero', () => {
            const balance: BalanceSnapshot = {
                near: '0',
                fungibleTokens: {},
                intentsTokens: { 'nep141:eth.omft.near': '50' },
                stakingPools: {}
            };
            assert.strictEqual(isZeroBalance(balance), false);
        });
    });

    describe('isStakingOnlyEntry', () => {
        it('should return true for synthetic staking entry', () => {
            const tx: TransactionEntry = {
                block: 100,
                transactionHashes: [], // No tx hashes
                changes: {
                    nearChanged: false,
                    tokensChanged: {},
                    intentsChanged: {},
                    stakingChanged: { 'pool.near': { start: '1000', end: '1100', diff: '100' } }
                }
            } as TransactionEntry;
            
            assert.strictEqual(isStakingOnlyEntry(tx), true);
        });

        it('should return false for regular transaction', () => {
            const tx: TransactionEntry = {
                block: 100,
                transactionHashes: ['some_hash'],
                changes: {
                    nearChanged: true,
                    nearDiff: '1000',
                    tokensChanged: {},
                    intentsChanged: {}
                }
            } as TransactionEntry;
            
            assert.strictEqual(isStakingOnlyEntry(tx), false);
        });

        it('should return false for transaction with staking AND other changes', () => {
            const tx: TransactionEntry = {
                block: 100,
                transactionHashes: ['some_hash'],
                changes: {
                    nearChanged: true,
                    nearDiff: '-1000',
                    tokensChanged: {},
                    intentsChanged: {},
                    stakingChanged: { 'pool.near': { start: '0', end: '1000', diff: '1000' } }
                }
            } as TransactionEntry;
            
            assert.strictEqual(isStakingOnlyEntry(tx), false);
        });
    });

    describe('detectGaps', () => {
        it('should return empty analysis for empty transactions', () => {
            const analysis = detectGaps([]);
            assert.strictEqual(analysis.totalGaps, 0);
            assert.strictEqual(analysis.internalGaps.length, 0);
            assert.strictEqual(analysis.gapToCreation, null);
            assert.strictEqual(analysis.isComplete, true);
        });

        it('should detect no gaps when balances connect properly', () => {
            const transactions = [
                createTx(100, { near: '0' }, { near: '1000' }),
                createTx(200, { near: '1000' }, { near: '2000' }),
                createTx(300, { near: '2000' }, { near: '3000' })
            ];
            
            const analysis = detectGaps(transactions);
            assert.strictEqual(analysis.internalGaps.length, 0);
            assert.strictEqual(analysis.gapToCreation, null); // Started at zero
            assert.strictEqual(analysis.isComplete, true);
        });

        it('should detect internal gap between records', () => {
            const transactions = [
                createTx(100, { near: '0' }, { near: '1000' }),
                createTx(200, { near: '1500' }, { near: '2000' }), // Gap: 1000 -> 1500
                createTx(300, { near: '2000' }, { near: '3000' })
            ];
            
            const analysis = detectGaps(transactions);
            assert.strictEqual(analysis.internalGaps.length, 1);
            assert.strictEqual(analysis.internalGaps[0]?.startBlock, 100);
            assert.strictEqual(analysis.internalGaps[0]?.endBlock, 200);
            assert.strictEqual(analysis.isComplete, false);
        });

        it('should detect gap to account creation', () => {
            const transactions = [
                createTx(100, { near: '5000' }, { near: '6000' }), // Started with balance!
                createTx(200, { near: '6000' }, { near: '7000' })
            ];
            
            const analysis = detectGaps(transactions);
            assert.notStrictEqual(analysis.gapToCreation, null);
            assert.strictEqual(analysis.gapToCreation?.endBlock, 100);
            assert.strictEqual(analysis.isComplete, false);
        });

        it('should detect gap to present when current balance differs', () => {
            const transactions = [
                createTx(100, { near: '0' }, { near: '1000' }),
                createTx(200, { near: '1000' }, { near: '2000' })
            ];
            
            const currentBalance: BalanceSnapshot = {
                near: '3000', // Different from 2000
                fungibleTokens: {},
                intentsTokens: {},
                stakingPools: {}
            };
            
            const analysis = detectGaps(transactions, currentBalance);
            assert.notStrictEqual(analysis.gapToPresent, null);
            assert.strictEqual(analysis.gapToPresent?.startBlock, 200);
            assert.strictEqual(analysis.isComplete, false);
        });

        it('should sort transactions by block before analysis', () => {
            // Transactions out of order
            const transactions = [
                createTx(300, { near: '2000' }, { near: '3000' }),
                createTx(100, { near: '0' }, { near: '1000' }),
                createTx(200, { near: '1000' }, { near: '2000' })
            ];
            
            const analysis = detectGaps(transactions);
            assert.strictEqual(analysis.internalGaps.length, 0);
            assert.strictEqual(analysis.isComplete, true);
        });

        it('should exclude staking-only entries from gap detection', () => {
            const transactions = [
                createTx(100, { near: '0' }, { near: '1000' }),
                // Staking-only entry (should be skipped)
                {
                    block: 150,
                    balanceBefore: { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: { 'pool.near': '500' } },
                    balanceAfter: { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: { 'pool.near': '600' } },
                    transactionHashes: [],
                    changes: {
                        nearChanged: false,
                        tokensChanged: {},
                        intentsChanged: {},
                        stakingChanged: { 'pool.near': { start: '500', end: '600', diff: '100' } }
                    }
                } as TransactionEntry,
                createTx(200, { near: '1000' }, { near: '2000' })
            ];
            
            const analysis = detectGaps(transactions);
            // Should NOT detect a gap because staking-only entry is excluded
            assert.strictEqual(analysis.internalGaps.length, 0);
        });

        it('should detect intents token gaps', () => {
            const transactions = [
                createTx(100, 
                    { near: '1000', intentsTokens: {} }, 
                    { near: '1000', intentsTokens: { 'nep141:eth.omft.near': '100' } }
                ),
                createTx(200, 
                    // Gap: intents token changed from 100 to 200
                    { near: '1000', intentsTokens: { 'nep141:eth.omft.near': '200' } }, 
                    { near: '1000', intentsTokens: { 'nep141:eth.omft.near': '300' } }
                )
            ];
            
            const analysis = detectGaps(transactions);
            assert.strictEqual(analysis.internalGaps.length, 1);
            
            const gap = analysis.internalGaps[0]!;
            const intentsError = gap.verification.errors.find(e => e.type === 'intents_balance_mismatch');
            assert.notStrictEqual(intentsError, undefined);
            assert.strictEqual(intentsError?.token, 'nep141:eth.omft.near');
        });

        it('should handle single transaction', () => {
            const transactions = [
                createTx(100, { near: '0' }, { near: '1000' })
            ];
            
            const analysis = detectGaps(transactions);
            assert.strictEqual(analysis.internalGaps.length, 0);
            assert.strictEqual(analysis.gapToCreation, null);
            assert.strictEqual(analysis.isComplete, true);
        });
    });

    describe('getGapChangedAssets', () => {
        it('should extract changed assets from gap', () => {
            const gap: Gap = {
                startBlock: 100,
                endBlock: 200,
                prevTransaction: createTx(100, { near: '0' }, { near: '1000' }),
                nextTransaction: createTx(200, { near: '1500' }, { near: '2000' }),
                verification: {
                    valid: false,
                    errors: [
                        { type: 'near_balance_mismatch', expected: '1000', actual: '1500', message: '' },
                        { type: 'token_balance_mismatch', token: 'wrap.near', expected: '0', actual: '100', message: '' },
                        { type: 'intents_balance_mismatch', token: 'nep141:eth.omft.near', expected: '0', actual: '50', message: '' }
                    ]
                }
            };
            
            const assets = getGapChangedAssets(gap);
            assert.strictEqual(assets.nearChanged, true);
            assert.deepStrictEqual(assets.fungibleTokensChanged, ['wrap.near']);
            assert.deepStrictEqual(assets.intentsTokensChanged, ['nep141:eth.omft.near']);
        });
    });

    describe('getAllTokensFromGaps', () => {
        it('should collect unique tokens from multiple gaps', () => {
            const gaps: Gap[] = [
                {
                    startBlock: 100,
                    endBlock: 200,
                    verification: {
                        valid: false,
                        errors: [
                            { type: 'token_balance_mismatch', token: 'wrap.near', expected: '0', actual: '100', message: '' }
                        ]
                    }
                } as Gap,
                {
                    startBlock: 200,
                    endBlock: 300,
                    verification: {
                        valid: false,
                        errors: [
                            { type: 'token_balance_mismatch', token: 'wrap.near', expected: '100', actual: '200', message: '' },
                            { type: 'intents_balance_mismatch', token: 'nep141:eth.omft.near', expected: '0', actual: '50', message: '' }
                        ]
                    }
                } as Gap
            ];
            
            const tokens = getAllTokensFromGaps(gaps);
            assert.deepStrictEqual(tokens.fungibleTokens, ['wrap.near']); // Deduplicated
            assert.deepStrictEqual(tokens.intentsTokens, ['nep141:eth.omft.near']);
        });
    });
});
