// Test case for the JSON to CSV converter
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
    convertToCSVRows,
    generateCSV,
    escapeCSV,
    formatTimestamp,
    getAssetName,
    getTokenBalance
} from '../scripts/json-to-csv.js';
import type { AccountHistory, TransferDetail, BalanceSnapshot } from '../scripts/json-to-csv.js';

describe('JSON to CSV Converter', function() {
    describe('escapeCSV', function() {
        it('should return value unchanged if no special characters', function() {
            assert.equal(escapeCSV('simple'), 'simple');
            assert.equal(escapeCSV('test123'), 'test123');
        });

        it('should wrap value in quotes if it contains comma', function() {
            assert.equal(escapeCSV('value,with,commas'), '"value,with,commas"');
        });

        it('should wrap value in quotes if it contains newline', function() {
            assert.equal(escapeCSV('line1\nline2'), '"line1\nline2"');
        });

        it('should escape double quotes by doubling them', function() {
            assert.equal(escapeCSV('value"with"quotes'), '"value""with""quotes"');
        });

        it('should handle combination of special characters', function() {
            assert.equal(escapeCSV('a,b"c\nd'), '"a,b""c\nd"');
        });
    });

    describe('formatTimestamp', function() {
        it('should return empty string for null timestamp', function() {
            assert.equal(formatTimestamp(null), '');
        });

        it('should convert nanoseconds to ISO string', function() {
            // 2024-01-15T10:30:00.000Z in milliseconds = 1705314600000
            // In nanoseconds = 1705314600000000000
            const timestamp = 1705314600000000000;
            const result = formatTimestamp(timestamp);
            assert.ok(result.startsWith('2024-01-15'));
            assert.ok(result.includes('T'));
            assert.ok(result.endsWith('Z'));
        });
    });

    describe('getAssetName', function() {
        it('should return "NEAR" for near transfer type', function() {
            const transfer: TransferDetail = {
                type: 'near',
                direction: 'in',
                amount: '1000',
                counterparty: 'test.near'
            };
            assert.equal(getAssetName(transfer), 'NEAR');
        });

        it('should return tokenId for ft transfer', function() {
            const transfer: TransferDetail = {
                type: 'ft',
                direction: 'out',
                amount: '1000',
                counterparty: 'test.near',
                tokenId: 'usdc.near'
            };
            assert.equal(getAssetName(transfer), 'usdc.near');
        });

        it('should return tokenId for mt transfer', function() {
            const transfer: TransferDetail = {
                type: 'mt',
                direction: 'in',
                amount: '500',
                counterparty: 'test.near',
                tokenId: 'nep141:eth.omft.near'
            };
            assert.equal(getAssetName(transfer), 'nep141:eth.omft.near');
        });

        it('should return "unknown" if tokenId is missing', function() {
            const transfer: TransferDetail = {
                type: 'ft',
                direction: 'in',
                amount: '100',
                counterparty: 'test.near'
            };
            assert.equal(getAssetName(transfer), 'unknown');
        });
    });

    describe('getTokenBalance', function() {
        const balanceAfter: BalanceSnapshot = {
            near: '5000000000000000000000000',
            fungibleTokens: {
                'usdc.near': '1000000',
                'wrap.near': '2000000000000000000000000'
            },
            intentsTokens: {
                'nep141:eth.omft.near': '5000000000000000'
            }
        };

        it('should return NEAR balance for near transfer', function() {
            const transfer: TransferDetail = {
                type: 'near',
                direction: 'in',
                amount: '1000',
                counterparty: 'test.near'
            };
            assert.equal(getTokenBalance(transfer, balanceAfter), '5000000000000000000000000');
        });

        it('should return FT balance for ft transfer', function() {
            const transfer: TransferDetail = {
                type: 'ft',
                direction: 'out',
                amount: '100',
                counterparty: 'test.near',
                tokenId: 'usdc.near'
            };
            assert.equal(getTokenBalance(transfer, balanceAfter), '1000000');
        });

        it('should return MT balance for mt transfer', function() {
            const transfer: TransferDetail = {
                type: 'mt',
                direction: 'in',
                amount: '500',
                counterparty: 'test.near',
                tokenId: 'nep141:eth.omft.near'
            };
            assert.equal(getTokenBalance(transfer, balanceAfter), '5000000000000000');
        });

        it('should return "0" for unknown FT token', function() {
            const transfer: TransferDetail = {
                type: 'ft',
                direction: 'in',
                amount: '100',
                counterparty: 'test.near',
                tokenId: 'unknown.token'
            };
            assert.equal(getTokenBalance(transfer, balanceAfter), '0');
        });

        it('should return empty string if balanceAfter is undefined', function() {
            const transfer: TransferDetail = {
                type: 'near',
                direction: 'in',
                amount: '1000',
                counterparty: 'test.near'
            };
            assert.equal(getTokenBalance(transfer, undefined), '');
        });
    });

    describe('convertToCSVRows', function() {
        it('should convert account history to CSV rows', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        timestamp: 1705314600000000000,
                        transactionHashes: ['hash1'],
                        transfers: [
                            {
                                type: 'near',
                                direction: 'out',
                                amount: '1000000000000000000000000',
                                counterparty: 'receiver.near',
                                txHash: 'hash1',
                                receiptId: 'receipt1'
                            }
                        ],
                        balanceAfter: {
                            near: '4000000000000000000000000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 100,
                    lastBlock: 100,
                    totalTransactions: 1
                }
            };

            const rows = convertToCSVRows(history);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.blockHeight, 100);
            assert.equal(rows[0]?.asset, 'NEAR');
            assert.equal(rows[0]?.counterparty, 'receiver.near');
            assert.equal(rows[0]?.direction, 'out');
            assert.equal(rows[0]?.amount, '1000000000000000000000000');
            assert.equal(rows[0]?.transactionHash, 'hash1');
            assert.equal(rows[0]?.receiptId, 'receipt1');
            assert.equal(rows[0]?.tokenBalance, '4000000000000000000000000');
        });

        it('should handle multiple transfers in one transaction', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 200,
                        timestamp: 1705314700000000000,
                        transactionHashes: ['hash2'],
                        transfers: [
                            {
                                type: 'near',
                                direction: 'out',
                                amount: '100',
                                counterparty: 'a.near',
                                txHash: 'hash2',
                                receiptId: 'r1'
                            },
                            {
                                type: 'ft',
                                direction: 'in',
                                amount: '500',
                                counterparty: 'b.near',
                                tokenId: 'usdc.near',
                                txHash: 'hash2',
                                receiptId: 'r2'
                            }
                        ],
                        balanceAfter: {
                            near: '1000',
                            fungibleTokens: { 'usdc.near': '500' },
                            intentsTokens: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 200,
                    lastBlock: 200,
                    totalTransactions: 1
                }
            };

            const rows = convertToCSVRows(history);
            assert.equal(rows.length, 2);
            assert.equal(rows[0]?.asset, 'NEAR');
            assert.equal(rows[1]?.asset, 'usdc.near');
        });

        it('should skip transactions without transfers', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        timestamp: 1705314600000000000,
                        transactionHashes: ['hash1'],
                        balanceAfter: {
                            near: '1000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        }
                    },
                    {
                        block: 200,
                        timestamp: 1705314700000000000,
                        transactionHashes: ['hash2'],
                        transfers: [],
                        balanceAfter: {
                            near: '900',
                            fungibleTokens: {},
                            intentsTokens: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 100,
                    lastBlock: 200,
                    totalTransactions: 2
                }
            };

            const rows = convertToCSVRows(history);
            assert.equal(rows.length, 0);
        });

        it('should use transactionHashes[0] if transfer.txHash is missing', function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        timestamp: 1705314600000000000,
                        transactionHashes: ['fallback_hash'],
                        transfers: [
                            {
                                type: 'near',
                                direction: 'in',
                                amount: '1000',
                                counterparty: 'sender.near'
                                // No txHash
                            }
                        ],
                        balanceAfter: {
                            near: '2000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 100,
                    lastBlock: 100,
                    totalTransactions: 1
                }
            };

            const rows = convertToCSVRows(history);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.transactionHash, 'fallback_hash');
        });
    });

    describe('generateCSV', function() {
        it('should generate valid CSV with headers', function() {
            const rows = [
                {
                    blockHeight: 100,
                    timestamp: '2024-01-15T10:30:00.000Z',
                    asset: 'NEAR',
                    counterparty: 'test.near',
                    direction: 'out' as const,
                    amount: '1000000000000000000000000',
                    transactionHash: 'abc123',
                    receiptId: 'receipt123',
                    tokenBalance: '5000000000000000000000000'
                }
            ];

            const csv = generateCSV(rows);
            const lines = csv.split('\n');
            
            assert.equal(lines.length, 2);
            assert.equal(lines[0], 'block_height,timestamp,asset,counterparty,direction,amount,transaction_hash,receipt_id,token_balance');
            assert.ok(lines[1]?.includes('100'));
            assert.ok(lines[1]?.includes('NEAR'));
            assert.ok(lines[1]?.includes('test.near'));
        });

        it('should handle empty rows array', function() {
            const csv = generateCSV([]);
            const lines = csv.split('\n');
            
            assert.equal(lines.length, 1);
            assert.equal(lines[0], 'block_height,timestamp,asset,counterparty,direction,amount,transaction_hash,receipt_id,token_balance');
        });

        it('should properly escape special characters in CSV', function() {
            const rows = [
                {
                    blockHeight: 100,
                    timestamp: '2024-01-15T10:30:00.000Z',
                    asset: 'token,with,commas',
                    counterparty: 'test"quote".near',
                    direction: 'in' as const,
                    amount: '1000',
                    transactionHash: 'hash',
                    receiptId: 'receipt',
                    tokenBalance: '2000'
                }
            ];

            const csv = generateCSV(rows);
            const lines = csv.split('\n');
            
            assert.ok(lines[1]?.includes('"token,with,commas"'));
            assert.ok(lines[1]?.includes('"test""quote"".near"'));
        });
    });

    describe('Integration test with sample data', function() {
        const testInputFile = path.join(__dirname, 'test-json-input.json');
        const testOutputFile = path.join(__dirname, 'test-csv-output.csv');

        afterEach(function() {
            // Clean up test files
            if (fs.existsSync(testInputFile)) {
                fs.unlinkSync(testInputFile);
            }
            if (fs.existsSync(testOutputFile)) {
                fs.unlinkSync(testOutputFile);
            }
        });

        it('should convert a complete JSON file to CSV', function() {
            // Create sample input file
            const sampleHistory: AccountHistory = {
                accountId: 'myaccount.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-15T12:00:00Z',
                transactions: [
                    {
                        block: 151391583,
                        timestamp: 1732783100000000000,
                        transactionHashes: ['tx1hash'],
                        transfers: [
                            {
                                type: 'mt',
                                direction: 'out',
                                amount: '5000000000000000',
                                counterparty: 'intents.near',
                                tokenId: 'nep141:eth.omft.near',
                                txHash: 'tx1hash',
                                receiptId: 'receipt1'
                            }
                        ],
                        balanceAfter: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        }
                    },
                    {
                        block: 151391587,
                        timestamp: 1732783104000000000,
                        transactionHashes: ['tx2hash'],
                        transfers: [
                            {
                                type: 'near',
                                direction: 'out',
                                amount: '100000000000000000000000',
                                counterparty: 'petersalomonsen.near',
                                txHash: 'tx2hash',
                                receiptId: 'receipt2'
                            }
                        ],
                        balanceAfter: {
                            near: '11100413712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        }
                    }
                ],
                metadata: {
                    firstBlock: 151391583,
                    lastBlock: 151391587,
                    totalTransactions: 2
                }
            };

            fs.writeFileSync(testInputFile, JSON.stringify(sampleHistory, null, 2));

            // Convert to CSV rows
            const rows = convertToCSVRows(sampleHistory);
            assert.equal(rows.length, 2);

            // Generate CSV
            const csv = generateCSV(rows);
            fs.writeFileSync(testOutputFile, csv);

            // Verify output
            assert.ok(fs.existsSync(testOutputFile));
            const csvContent = fs.readFileSync(testOutputFile, 'utf-8');
            const lines = csvContent.split('\n');

            assert.equal(lines.length, 3); // header + 2 data rows
            assert.ok(lines[0]?.includes('block_height'));
            assert.ok(lines[1]?.includes('151391583'));
            assert.ok(lines[1]?.includes('nep141:eth.omft.near'));
            assert.ok(lines[2]?.includes('151391587'));
            assert.ok(lines[2]?.includes('NEAR'));
            assert.ok(lines[2]?.includes('petersalomonsen.near'));
        });
    });
});
