/**
 * Test suite for the JSON to CSV converter functionality
 */
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
import type { AccountHistory, TransferDetail, BalanceSnapshot, Changes, BalanceChange } from '../scripts/json-to-csv.js';

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
        it('should convert account history to CSV rows based on changes', async function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        transactionBlock: 99,
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
                        balanceBefore: {
                            near: '5000000000000000000000000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '4000000000000000000000000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-1000000000000000000000000',
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

            const rows = await convertToCSVRows(history);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.changeBlockHeight, 100);
            assert.equal(rows[0]?.tokenSymbol, 'NEAR');
            assert.equal(rows[0]?.counterparty, 'receiver.near');
            assert.equal(rows[0]?.direction, 'out');
            assert.equal(rows[0]?.amountWholeUnits, '1');
            assert.equal(rows[0]?.balanceWholeUnits, '4');
            assert.equal(rows[0]?.asset, 'NEAR');
            assert.equal(rows[0]?.amountRaw, '1000000000000000000000000');
            assert.equal(rows[0]?.transactionHash, 'hash1');
            assert.equal(rows[0]?.receiptId, 'receipt1');
            assert.equal(rows[0]?.tokenBalanceRaw, '4000000000000000000000000');
        });

        it('should handle multiple balance changes in one transaction', async function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 200,
                        transactionBlock: 199,
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
                        balanceBefore: {
                            near: '1100',
                            fungibleTokens: { 'usdc.near': '0' },
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '1000',
                            fungibleTokens: { 'usdc.near': '500' },
                            intentsTokens: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '-100',
                            tokensChanged: { 'usdc.near': { start: '0', end: '500', diff: '500' } },
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: {
                    firstBlock: 200,
                    lastBlock: 200,
                    totalTransactions: 1
                }
            };

            const rows = await convertToCSVRows(history);
            assert.equal(rows.length, 2);
            // NEAR is processed first, then FT
            assert.equal(rows[0]?.asset, 'NEAR');
            assert.equal(rows[1]?.asset, 'usdc.near');
        });

        it('should skip transactions without changes', async function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        transactionBlock: 99,
                        timestamp: 1705314600000000000,
                        transactionHashes: ['hash1'],
                        balanceAfter: {
                            near: '1000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        }
                        // No changes object
                    },
                    {
                        block: 200,
                        transactionBlock: 199,
                        timestamp: 1705314700000000000,
                        transactionHashes: ['hash2'],
                        transfers: [],
                        balanceAfter: {
                            near: '1000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        changes: {
                            nearChanged: false,
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

            const rows = await convertToCSVRows(history);
            assert.equal(rows.length, 0);
        });

        it('should use transactionHashes[0] if transfer.txHash is missing', async function() {
            const history: AccountHistory = {
                accountId: 'test.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-01T00:00:00Z',
                transactions: [
                    {
                        block: 100,
                        transactionBlock: 99,
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
                        balanceBefore: {
                            near: '1000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '2000',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '1000',
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

            const rows = await convertToCSVRows(history);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.transactionHash, 'fallback_hash');
        });
    });

    describe('generateCSV', function() {
        it('should generate valid CSV with headers', function() {
            const rows = [
                {
                    changeBlockHeight: 100,
                    timestamp: '2024-01-15T10:30:00.000Z',
                    counterparty: 'test.near',
                    direction: 'out' as const,
                    tokenSymbol: 'NEAR',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '5',
                    asset: 'NEAR',
                    amountRaw: '1000000000000000000000000',
                    tokenBalanceRaw: '5000000000000000000000000',
                    transactionHash: 'abc123',
                    receiptId: 'receipt123'
                }
            ];

            const csv = generateCSV(rows);
            const lines = csv.split('\n');
            
            assert.equal(lines.length, 2);
            assert.equal(lines[0], 'change_block_height,timestamp,counterparty,direction,token_symbol,amount_whole_units,balance_whole_units,asset,amount_raw,token_balance_raw,transaction_hash,receipt_id');
            assert.ok(lines[1]?.includes('100'));
            assert.ok(lines[1]?.includes('NEAR'));
            assert.ok(lines[1]?.includes('test.near'));
        });

        it('should handle empty rows array', function() {
            const csv = generateCSV([]);
            const lines = csv.split('\n');
            
            assert.equal(lines.length, 1);
            assert.equal(lines[0], 'change_block_height,timestamp,counterparty,direction,token_symbol,amount_whole_units,balance_whole_units,asset,amount_raw,token_balance_raw,transaction_hash,receipt_id');
        });

        it('should properly escape special characters in CSV', function() {
            const rows = [
                {
                    changeBlockHeight: 100,
                    timestamp: '2024-01-15T10:30:00.000Z',
                    counterparty: 'test"quote".near',
                    direction: 'in' as const,
                    tokenSymbol: 'TOKEN',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '2',
                    asset: 'token,with,commas',
                    amountRaw: '1000',
                    tokenBalanceRaw: '2000',
                    transactionHash: 'hash',
                    receiptId: 'receipt'
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

        it('should convert a complete JSON file to CSV', async function() {
            // Create sample input file
            const sampleHistory: AccountHistory = {
                accountId: 'myaccount.near',
                createdAt: '2024-01-01T00:00:00Z',
                updatedAt: '2024-01-15T12:00:00Z',
                transactions: [
                    {
                        block: 151391583,
                        transactionBlock: 151391582,
                        timestamp: 1732783100000000000,
                        transactionHashes: ['tx1hash'],
                        transfers: [
                            {
                                type: 'mt',
                                direction: 'in',
                                amount: '5000000000000000',
                                counterparty: 'intents.near',
                                tokenId: 'nep141:eth.omft.near',
                                txHash: 'tx1hash',
                                receiptId: 'receipt1'
                            }
                        ],
                        balanceBefore: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {}
                        },
                        balanceAfter: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        },
                        changes: {
                            nearChanged: false,
                            tokensChanged: {},
                            intentsChanged: {
                                'nep141:eth.omft.near': { start: '0', end: '5000000000000000', diff: '5000000000000000' }
                            }
                        }
                    },
                    {
                        block: 151391587,
                        transactionBlock: 151391586,
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
                        balanceBefore: {
                            near: '11200513712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
                        },
                        balanceAfter: {
                            near: '11100513712735084899999998',
                            fungibleTokens: {},
                            intentsTokens: {
                                'nep141:eth.omft.near': '5000000000000000'
                            }
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
                    firstBlock: 151391583,
                    lastBlock: 151391587,
                    totalTransactions: 2
                }
            };

            fs.writeFileSync(testInputFile, JSON.stringify(sampleHistory, null, 2));

            // Convert to CSV rows
            const rows = await convertToCSVRows(sampleHistory);
            assert.equal(rows.length, 2);

            // Generate CSV
            const csv = generateCSV(rows);
            fs.writeFileSync(testOutputFile, csv);

            // Verify output
            assert.ok(fs.existsSync(testOutputFile));
            const csvContent = fs.readFileSync(testOutputFile, 'utf-8');
            const lines = csvContent.split('\n');

            assert.equal(lines.length, 3); // header + 2 data rows
            assert.ok(lines[0]?.includes('change_block_height'));
            assert.ok(lines[1]?.includes('151391583'));
            assert.ok(lines[1]?.includes('nep141:eth.omft.near'));
            assert.ok(lines[2]?.includes('151391587'));
            assert.ok(lines[2]?.includes('NEAR'));
            assert.ok(lines[2]?.includes('petersalomonsen.near'));
        });
    });

    describe('Balance continuity validation', function() {
        /**
         * Verify that for each asset, previous_balance = current_balance - amount (for 'in')
         * or previous_balance = current_balance + amount (for 'out')
         * This validates that the CSV rows correctly represent actual balance changes
         */
        function validateBalanceContinuity(rows: { 
            changeBlockHeight: number;
            direction: 'in' | 'out';
            asset: string;
            amountRaw: string;
            tokenBalanceRaw: string;
            amountWholeUnits: string;
            balanceWholeUnits: string;
        }[]): { valid: boolean; errors: string[] } {
            const errors: string[] = [];
            
            // Group rows by asset and sort by block height
            const rowsByAsset = new Map<string, typeof rows>();
            for (const row of rows) {
                const assetRows = rowsByAsset.get(row.asset) || [];
                assetRows.push(row);
                rowsByAsset.set(row.asset, assetRows);
            }
            
            for (const [asset, assetRows] of rowsByAsset) {
                // Sort by block height
                const sortedRows = [...assetRows].sort((a, b) => a.changeBlockHeight - b.changeBlockHeight);
                
                for (let i = 1; i < sortedRows.length; i++) {
                    const prevRow = sortedRows[i - 1]!;
                    const currRow = sortedRows[i]!;
                    
                    // Validate raw units
                    const prevBalanceRaw = BigInt(prevRow.tokenBalanceRaw || '0');
                    const currBalanceRaw = BigInt(currRow.tokenBalanceRaw || '0');
                    const currAmountRaw = BigInt(currRow.amountRaw || '0');
                    
                    // Calculate expected previous balance based on direction
                    // If 'in': previous_balance = current_balance - amount
                    // If 'out': previous_balance = current_balance + amount
                    let expectedPrevBalanceRaw: bigint;
                    if (currRow.direction === 'in') {
                        expectedPrevBalanceRaw = currBalanceRaw - currAmountRaw;
                    } else {
                        expectedPrevBalanceRaw = currBalanceRaw + currAmountRaw;
                    }
                    
                    if (prevBalanceRaw !== expectedPrevBalanceRaw) {
                        errors.push(
                            `Raw balance mismatch for ${asset} at block ${currRow.changeBlockHeight}: ` +
                            `previous balance ${prevBalanceRaw} != expected ${expectedPrevBalanceRaw} ` +
                            `(current balance ${currBalanceRaw} ${currRow.direction === 'in' ? '-' : '+'} amount ${currAmountRaw})`
                        );
                    }
                    
                    // Validate whole units (with tolerance for rounding)
                    const prevBalanceWhole = parseFloat(prevRow.balanceWholeUnits || '0');
                    const currBalanceWhole = parseFloat(currRow.balanceWholeUnits || '0');
                    const currAmountWhole = parseFloat(currRow.amountWholeUnits || '0');
                    
                    let expectedPrevBalanceWhole: number;
                    if (currRow.direction === 'in') {
                        expectedPrevBalanceWhole = currBalanceWhole - currAmountWhole;
                    } else {
                        expectedPrevBalanceWhole = currBalanceWhole + currAmountWhole;
                    }
                    
                    // Allow small tolerance for floating point precision
                    const tolerance = Math.abs(expectedPrevBalanceWhole) * 1e-10 + 1e-10;
                    if (Math.abs(prevBalanceWhole - expectedPrevBalanceWhole) > tolerance) {
                        errors.push(
                            `Whole unit balance mismatch for ${asset} at block ${currRow.changeBlockHeight}: ` +
                            `previous balance ${prevBalanceWhole} != expected ${expectedPrevBalanceWhole} ` +
                            `(current balance ${currBalanceWhole} ${currRow.direction === 'in' ? '-' : '+'} amount ${currAmountWhole})`
                        );
                    }
                }
            }
            
            return { valid: errors.length === 0, errors };
        }

        // Real transaction data from romakqatesting.sputnik-dao.near.json
        // Two consecutive NEAR transactions: both incoming transfers
        it('should pass balance continuity for consecutive NEAR transactions (real data)', async function() {
            const history: AccountHistory = {
                accountId: 'romakqatesting.sputnik-dao.near',
                createdAt: '2025-12-09T19:18:18.495Z',
                updatedAt: '2025-12-10T20:16:49.023Z',
                transactions: [
                    // Block 171077775: Incoming 0.1 NEAR from maledress6270.near
                    {
                        block: 171077775,
                        transactionBlock: 171077775,
                        timestamp: 1762186784137076200,
                        transactionHashes: ['9w1EoTB5An9ZPbNuGeQPF4EEHSSBKd5sBSLkLKHhopwN'],
                        transfers: [{
                            type: 'near',
                            direction: 'in',
                            amount: '100000000000000000000000',
                            counterparty: 'maledress6270.near',
                            txHash: '9w1EoTB5An9ZPbNuGeQPF4EEHSSBKd5sBSLkLKHhopwN',
                            receiptId: '4wPSgJGzWvM75FpDAXfEUundHcqA85EDQHtteMe6kZ7A'
                        }],
                        balanceBefore: {
                            near: '6000063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        balanceAfter: {
                            near: '6100063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '100000000000000000000000',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    },
                    // Block 171077957: Incoming 0.02 NEAR from maledress6270.near (consecutive to above)
                    {
                        block: 171077957,
                        transactionBlock: 171077957,
                        timestamp: 1762186895110196000,
                        transactionHashes: ['9pJyXLeTMZoEFCwH6Zrv3sb6n7U1XbwQmmF8p7rERuPg'],
                        transfers: [{
                            type: 'near',
                            direction: 'in',
                            amount: '20000000000000000000000',
                            counterparty: 'maledress6270.near',
                            txHash: '9pJyXLeTMZoEFCwH6Zrv3sb6n7U1XbwQmmF8p7rERuPg',
                            receiptId: 'KNuDPkXLM29sHv3iY3Lj81kb3puoRyYRCTecinVi81w'
                        }],
                        balanceBefore: {
                            near: '6100063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        balanceAfter: {
                            near: '6120063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '20000000000000000000000',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    }
                ],
                metadata: { firstBlock: 171077775, lastBlock: 171077957, totalTransactions: 2 }
            };

            const rows = await convertToCSVRows(history);
            assert.equal(rows.length, 2);
            
            // Verify directions are correctly determined from the diff sign
            assert.equal(rows[0]?.direction, 'in');
            assert.equal(rows[1]?.direction, 'in');
            
            // Verify actual amounts from changes
            assert.equal(rows[0]?.amountRaw, '100000000000000000000000'); // 0.1 NEAR
            assert.equal(rows[1]?.amountRaw, '20000000000000000000000');  // 0.02 NEAR
            
            const result = validateBalanceContinuity(rows);
            assert.ok(result.valid, `Balance continuity failed: ${result.errors.join('; ')}`);
        });

        // Real transaction data with multiple asset types: NEAR and wNEAR intents
        it('should pass balance continuity for multiple assets (real data)', async function() {
            const history: AccountHistory = {
                accountId: 'romakqatesting.sputnik-dao.near',
                createdAt: '2025-12-09T19:18:18.495Z',
                updatedAt: '2025-12-10T20:16:49.023Z',
                transactions: [
                    // Block 171077693: Incoming 0.1 wNEAR to intents (no NEAR change)
                    {
                        block: 171077693,
                        transactionBlock: 171077693,
                        timestamp: 1762186735092690000,
                        transactionHashes: ['J4LUCcGmjwtgTwWnyo4HWxDmRTEm71ekdbGcEKar4mWo'],
                        transfers: [{
                            type: 'mt',
                            direction: 'in',
                            amount: '100000000000000000000000',
                            counterparty: 'intents.near',
                            tokenId: 'nep141:wrap.near',
                            memo: 'deposit',
                            txHash: 'J4LUCcGmjwtgTwWnyo4HWxDmRTEm71ekdbGcEKar4mWo',
                            receiptId: '3hgF3gNffHQSadq5imNyAy4KXb2wti6eo7Tn7DLWm9wr'
                        }],
                        balanceBefore: {
                            near: '6000063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: {},
                            stakingPools: {}
                        },
                        balanceAfter: {
                            near: '6000063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        changes: {
                            nearChanged: false,
                            tokensChanged: {},
                            intentsChanged: {
                                'nep141:wrap.near': {
                                    start: '0',
                                    end: '100000000000000000000000',
                                    diff: '100000000000000000000000'
                                }
                            }
                        }
                    },
                    // Block 171077775: Incoming 0.1 NEAR (wNEAR unchanged)
                    {
                        block: 171077775,
                        transactionBlock: 171077775,
                        timestamp: 1762186784137076200,
                        transactionHashes: ['9w1EoTB5An9ZPbNuGeQPF4EEHSSBKd5sBSLkLKHhopwN'],
                        transfers: [{
                            type: 'near',
                            direction: 'in',
                            amount: '100000000000000000000000',
                            counterparty: 'maledress6270.near',
                            txHash: '9w1EoTB5An9ZPbNuGeQPF4EEHSSBKd5sBSLkLKHhopwN',
                            receiptId: '4wPSgJGzWvM75FpDAXfEUundHcqA85EDQHtteMe6kZ7A'
                        }],
                        balanceBefore: {
                            near: '6000063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        balanceAfter: {
                            near: '6100063357771016300000000',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        changes: {
                            nearChanged: true,
                            nearDiff: '100000000000000000000000',
                            tokensChanged: {},
                            intentsChanged: {}
                        }
                    },
                    // Block 171176748: Outgoing 0.1 wNEAR from intents (NEAR unchanged)
                    {
                        block: 171176748,
                        transactionBlock: 171176748,
                        timestamp: 1762246914838001400,
                        transactionHashes: ['F9BqPDCenfWHvmZrMxc8RgEC2soCrKRGedCvzwVVo63i'],
                        transfers: [{
                            type: 'mt',
                            direction: 'out',
                            amount: '100000000000000000000000',
                            counterparty: 'intents.near',
                            tokenId: 'nep141:wrap.near',
                            memo: 'withdraw',
                            txHash: 'F9BqPDCenfWHvmZrMxc8RgEC2soCrKRGedCvzwVVo63i',
                            receiptId: 'JAYfW23byQWLVRCqmEqacnM9hLoZAuLimtQ2buW7FYpf'
                        }],
                        balanceBefore: {
                            near: '6320303078494178399999999',
                            fungibleTokens: {},
                            intentsTokens: { 'nep141:wrap.near': '100000000000000000000000' },
                            stakingPools: {}
                        },
                        balanceAfter: {
                            near: '6320303078494178399999999',
                            fungibleTokens: {},
                            intentsTokens: {},
                            stakingPools: {}
                        },
                        changes: {
                            nearChanged: false,
                            tokensChanged: {},
                            intentsChanged: {
                                'nep141:wrap.near': {
                                    start: '100000000000000000000000',
                                    end: '0',
                                    diff: '-100000000000000000000000'
                                }
                            }
                        }
                    }
                ],
                metadata: { firstBlock: 171077693, lastBlock: 171176748, totalTransactions: 3 }
            };

            const rows = await convertToCSVRows(history);
            // Should have 3 rows: 1 wNEAR in, 1 NEAR in, 1 wNEAR out
            assert.equal(rows.length, 3);
            
            // Verify the assets
            const nearRows = rows.filter(r => r.asset === 'NEAR');
            const wNearRows = rows.filter(r => r.asset === 'nep141:wrap.near');
            assert.equal(nearRows.length, 1);
            assert.equal(wNearRows.length, 2);
            
            const result = validateBalanceContinuity(rows);
            assert.ok(result.valid, `Balance continuity failed: ${result.errors.join('; ')}`);
        });

        it('should validate balance continuity with real-world JSON data files', async function() {
            this.timeout(30000); // Allow more time for loading and processing
            
            // Find all JSON files in the project root
            const projectRoot = path.join(__dirname, '..');
            const jsonFiles = fs.readdirSync(projectRoot)
                .filter(f => f.endsWith('.near.json'));
            
            for (const jsonFile of jsonFiles) {
                const filePath = path.join(projectRoot, jsonFile);
                const content = fs.readFileSync(filePath, 'utf-8');
                const history: AccountHistory = JSON.parse(content);
                
                // Skip if no transactions
                if (!history.transactions || history.transactions.length === 0) {
                    continue;
                }
                
                const rows = await convertToCSVRows(history);
                
                // Skip if no rows (no balance changes)
                if (rows.length === 0) {
                    continue;
                }
                
                const result = validateBalanceContinuity(rows);
                assert.ok(
                    result.valid, 
                    `Balance continuity failed for ${jsonFile}: ${result.errors.slice(0, 3).join('; ')}${result.errors.length > 3 ? ` (and ${result.errors.length - 3} more)` : ''}`
                );
            }
        });
    });
});
