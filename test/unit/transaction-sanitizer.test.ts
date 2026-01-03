import assert from 'assert';
import {
    sanitizeTransaction,
    sanitizeTransactions,
    hasBinaryDataMarker,
    getSanitizationStats,
    BINARY_DATA_MARKER,
    MAX_ARGS_SIZE
} from '../../scripts/transaction-sanitizer.js';

describe('Transaction Sanitizer', () => {
    describe('sanitizeTransaction', () => {
        it('should replace large binary args with BINARY_DATA marker', () => {
            const tx = {
                hash: 'test123',
                actions: [{
                    FunctionCall: {
                        method_name: 'fs_store',
                        args: 'A'.repeat(MAX_ARGS_SIZE + 100), // Larger than limit
                        gas: '30000000000000',
                        deposit: '0'
                    }
                }]
            };

            const sanitized = sanitizeTransaction(tx);
            assert.strictEqual(
                sanitized.actions[0].FunctionCall.args,
                BINARY_DATA_MARKER,
                'Large binary args should be replaced with marker'
            );
        });

        it('should preserve small args', () => {
            const smallArgs = 'eyJhbW91bnQiOiIxMDAwIn0='; // Small base64
            const tx = {
                hash: 'test456',
                actions: [{
                    FunctionCall: {
                        method_name: 'transfer',
                        args: smallArgs,
                        gas: '30000000000000',
                        deposit: '0'
                    }
                }]
            };

            const sanitized = sanitizeTransaction(tx);
            assert.strictEqual(
                sanitized.actions[0].FunctionCall.args,
                smallArgs,
                'Small args should be preserved'
            );
        });

        it('should preserve large JSON args', () => {
            // Create a large but valid JSON args (base64 encoded)
            const jsonObject = { data: 'x'.repeat(800) };
            const jsonString = JSON.stringify(jsonObject);
            const base64Args = Buffer.from(jsonString).toString('base64');

            const tx = {
                hash: 'test789',
                actions: [{
                    FunctionCall: {
                        method_name: 'complex_call',
                        args: base64Args,
                        gas: '30000000000000',
                        deposit: '0'
                    }
                }]
            };

            const sanitized = sanitizeTransaction(tx);
            assert.strictEqual(
                sanitized.actions[0].FunctionCall.args,
                base64Args,
                'Large JSON args should be preserved'
            );
        });

        it('should handle transactions without FunctionCall actions', () => {
            const tx = {
                hash: 'test999',
                actions: [{
                    Transfer: {
                        deposit: '1000000000000000000000000'
                    }
                }]
            };

            const sanitized = sanitizeTransaction(tx);
            assert.deepStrictEqual(
                sanitized.actions[0],
                tx.actions[0],
                'Non-FunctionCall actions should be unchanged'
            );
        });

        it('should handle transactions with multiple actions', () => {
            const tx = {
                hash: 'test_multi',
                actions: [
                    {
                        FunctionCall: {
                            method_name: 'small',
                            args: 'small',
                            gas: '10000000000000',
                            deposit: '0'
                        }
                    },
                    {
                        FunctionCall: {
                            method_name: 'large',
                            args: 'B'.repeat(MAX_ARGS_SIZE + 100),
                            gas: '20000000000000',
                            deposit: '0'
                        }
                    },
                    {
                        Transfer: {
                            deposit: '5000000000000000000000000'
                        }
                    }
                ]
            };

            const sanitized = sanitizeTransaction(tx);
            assert.strictEqual(sanitized.actions[0].FunctionCall.args, 'small');
            assert.strictEqual(sanitized.actions[1].FunctionCall.args, BINARY_DATA_MARKER);
            assert.deepStrictEqual(sanitized.actions[2], tx.actions[2]);
        });

        it('should not mutate original transaction', () => {
            const tx = {
                hash: 'test_immutable',
                actions: [{
                    FunctionCall: {
                        method_name: 'test',
                        args: 'C'.repeat(MAX_ARGS_SIZE + 100),
                        gas: '30000000000000',
                        deposit: '0'
                    }
                }]
            };

            const originalArgs = tx.actions[0]!.FunctionCall.args;
            sanitizeTransaction(tx);

            assert.strictEqual(
                tx.actions[0]!.FunctionCall.args,
                originalArgs,
                'Original transaction should not be mutated'
            );
        });

        it('should handle empty or null transactions', () => {
            assert.strictEqual(sanitizeTransaction(null), null);
            assert.strictEqual(sanitizeTransaction(undefined), undefined);
            assert.deepStrictEqual(sanitizeTransaction({}), {});
        });
    });

    describe('sanitizeTransactions', () => {
        it('should sanitize an array of transactions', () => {
            const txs = [
                {
                    hash: 'tx1',
                    actions: [{
                        FunctionCall: {
                            method_name: 'test',
                            args: 'D'.repeat(MAX_ARGS_SIZE + 100),
                            gas: '30000000000000',
                            deposit: '0'
                        }
                    }]
                },
                {
                    hash: 'tx2',
                    actions: [{
                        FunctionCall: {
                            method_name: 'test2',
                            args: 'small',
                            gas: '30000000000000',
                            deposit: '0'
                        }
                    }]
                }
            ];

            const sanitized = sanitizeTransactions(txs);
            assert.strictEqual(sanitized[0].actions[0].FunctionCall.args, BINARY_DATA_MARKER);
            assert.strictEqual(sanitized[1].actions[0].FunctionCall.args, 'small');
        });
    });

    describe('hasBinaryDataMarker', () => {
        it('should detect BINARY_DATA marker in transaction', () => {
            const tx = {
                actions: [{
                    FunctionCall: {
                        args: BINARY_DATA_MARKER
                    }
                }]
            };

            assert.strictEqual(hasBinaryDataMarker(tx), true);
        });

        it('should return false for transactions without marker', () => {
            const tx = {
                actions: [{
                    FunctionCall: {
                        args: 'regular_args'
                    }
                }]
            };

            assert.strictEqual(hasBinaryDataMarker(tx), false);
        });
    });

    describe('getSanitizationStats', () => {
        it('should calculate correct stats for sanitized transaction', () => {
            const tx = {
                actions: [
                    {
                        FunctionCall: {
                            method_name: 'test1',
                            args: BINARY_DATA_MARKER,
                            gas: '30000000000000',
                            deposit: '0'
                        }
                    },
                    {
                        FunctionCall: {
                            method_name: 'test2',
                            args: 'small_args',
                            gas: '30000000000000',
                            deposit: '0'
                        }
                    }
                ]
            };

            const stats = getSanitizationStats(tx);
            assert.strictEqual(stats.totalActions, 2);
            assert.strictEqual(stats.sanitizedActions, 1);
        });

        it('should handle transactions without actions', () => {
            const stats = getSanitizationStats({ hash: 'test' });
            assert.strictEqual(stats.totalActions, 0);
            assert.strictEqual(stats.sanitizedActions, 0);
        });
    });
});
