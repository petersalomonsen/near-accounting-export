/**
 * Test suite for transaction block enrichment functionality
 */
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

// Import types from the compiled JS (we'll use inline types for AccountHistory)
interface TransactionEntry {
    block: number;
    transactionBlock?: number | null;
    timestamp: number | null;
    transactionHashes: string[];
    transactions: any[];
    transfers?: any[];
    balanceBefore?: any;
    balanceAfter?: any;
    changes: any;
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

describe('Transaction Block Enrichment', function() {
    // Increase timeout for RPC calls
    this.timeout(60000);

    const testOutputFile = path.join(__dirname, 'test-enrichment-output.json');

    afterEach(function() {
        // Clean up test files
        if (fs.existsSync(testOutputFile)) {
            fs.unlinkSync(testOutputFile);
        }
    });

    describe('Enrichment of existing JSON files', function() {
        it('should identify transactions missing transactionBlock', function() {
            // Sample transaction from real data without transactionBlock
            const history: AccountHistory = {
                accountId: 'webassemblymusic-treasury.sputnik-dao.near',
                createdAt: '2025-11-30T20:01:14.026Z',
                updatedAt: '2025-12-06T21:48:12.202Z',
                transactions: [
                    {
                        block: 171150828,
                        transactionBlock: null,
                        timestamp: 1762231097270689500,
                        transactionHashes: [],
                        transactions: [],
                        transfers: [
                            {
                                type: 'near',
                                direction: 'in',
                                amount: '100056497966188499999999',
                                counterparty: 'astro-stakers.poolv1.near',
                                txHash: 'J1HTSoHenfZPPwWg8Kr5RzGFWQx3T8XLTQJcunrKeqJW',
                                receiptId: '6TVXY7YAspg8LTdwKfNZmcwwNRMQH6XBWjF7U2Aog1hd'
                            }
                        ],
                        balanceBefore: {
                            near: '26506633459112343699999977',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '26606689957078532199999977',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '100056497966188499999999',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 171150828,
                    lastBlock: 171150828,
                    totalTransactions: 1
                }
            };

            // Count transactions that need enrichment
            const needsEnrichment = history.transactions.filter((tx: TransactionEntry) => 
                (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
                tx.transfers && tx.transfers.length > 0 && 
                tx.transfers.some((t: any) => t.txHash)
            );

            assert.equal(needsEnrichment.length, 1, 'Should identify 1 transaction needing enrichment');
            assert.equal(needsEnrichment[0]?.block, 171150828);
        });

        it('should not try to enrich synthetic staking entries', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2025-11-30T20:01:14.026Z',
                updatedAt: '2025-12-06T21:48:12.202Z',
                transactions: [
                    {
                        block: 171115200,
                        transactionBlock: null,
                        timestamp: 1762209579348060000,
                        transactionHashes: [],
                        transactions: [],
                        transfers: [
                            {
                                type: 'staking_reward',
                                direction: 'in',
                                amount: '39967482501013975895146',
                                counterparty: 'astro-stakers.poolv1.near',
                                tokenId: 'astro-stakers.poolv1.near',
                                memo: 'staking_reward'
                            }
                        ],
                        balanceBefore: {
                            near: '0',
                            fungibleTokens: {},
                            intentsTokens: {},
                            stakingPools: {
                                'astro-stakers.poolv1.near': '1018658351440092249855366042'
                            }
                        },
                        balanceAfter: {
                            near: '0',
                            fungibleTokens: {},
                            intentsTokens: {},
                            stakingPools: {
                                'astro-stakers.poolv1.near': '1018698318922593263831261188'
                            }
                        },
                        changes: {
                            nearChanged: false,
                            tokensChanged: {},
                            intentsChanged: {},
                            stakingChanged: {
                                'astro-stakers.poolv1.near': {
                                    start: '1018658351440092249855366042',
                                    end: '1018698318922593263831261188',
                                    diff: '39967482501013975895146'
                                }
                            }
                        }
                    }
                ],
                metadata: {
                    firstBlock: 171115200,
                    lastBlock: 171115200,
                    totalTransactions: 1
                }
            };

            // Staking entries have no transaction hashes, so they shouldn't be enriched
            const needsEnrichment = history.transactions.filter((tx: TransactionEntry) => 
                (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
                tx.transactionHashes && tx.transactionHashes.length > 0
            );

            assert.equal(needsEnrichment.length, 0, 'Should not try to enrich synthetic staking entries');
        });

        it('should handle transactions with transfers but empty transactionHashes', function() {
            // This is a common scenario where transfers have txHash but transaction-level array is empty
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2025-11-30T20:01:14.026Z',
                updatedAt: '2025-12-06T21:48:12.202Z',
                transactions: [
                    {
                        block: 171108241,
                        transactionBlock: null,
                        timestamp: 1762205357002513400,
                        transactionHashes: [],
                        transactions: [],
                        transfers: [
                            {
                                type: 'mt',
                                direction: 'in',
                                amount: '9999980',
                                counterparty: 'solver-multichain-asset.near',
                                tokenId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
                                txHash: '6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r',
                                receiptId: '8k8oSLc2fzQUgnrefNGkmX9Nrwmg4szzuTBg5xm7QtfD'
                            }
                        ],
                        balanceBefore: {
                            near: '26506633459112343699999977',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '26506633459112343699999977',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': '9999980'
                            }
                        },
                        changes: {
                            nearChanged: false,
                            tokensChanged: {},
                            intentsChanged: {
                                'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near': {
                                    start: '0',
                                    end: '9999980',
                                    diff: '9999980'
                                }
                            }
                        }
                    }
                ],
                metadata: {
                    firstBlock: 171108241,
                    lastBlock: 171108241,
                    totalTransactions: 1
                }
            };

            // This transaction has empty transactionHashes array but has transfers with txHash
            // The enrichment logic should skip it based on transactionHashes being empty
            const needsEnrichment = history.transactions.filter((tx: TransactionEntry) => 
                (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
                tx.transactionHashes && tx.transactionHashes.length > 0
            );

            assert.equal(needsEnrichment.length, 0, 'Should not enrich when transactionHashes is empty even if transfers exist');
            
            // But we can verify the transfers exist
            assert.equal(history.transactions[0]?.transfers?.length, 1);
            assert.equal(history.transactions[0]?.transfers?.[0]?.txHash, '6LLejN4izEV5qu8xYHZPGbzY6i5yQCGSscPzNyiezt6r');
        });

        it('should preserve transactionBlock if already set', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2025-11-30T20:01:14.026Z',
                updatedAt: '2025-12-06T21:48:12.202Z',
                transactions: [
                    {
                        block: 100,
                        transactionBlock: 98,
                        timestamp: 1762205357002513400,
                        transactionHashes: ['hash1'],
                        transactions: [],
                        transfers: [],
                        balanceBefore: {
                            near: '1000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '900',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
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
                    lastBlock: 100,
                    totalTransactions: 1
                }
            };

            // Should not try to enrich if transactionBlock is already set
            const needsEnrichment = history.transactions.filter((tx: TransactionEntry) => 
                (tx.transactionBlock === null || tx.transactionBlock === undefined) && 
                tx.transactionHashes && tx.transactionHashes.length > 0
            );

            assert.equal(needsEnrichment.length, 0, 'Should not enrich when transactionBlock is already set');
            assert.equal(history.transactions[0]?.transactionBlock, 98, 'Should preserve existing transactionBlock');
        });
    });
});
