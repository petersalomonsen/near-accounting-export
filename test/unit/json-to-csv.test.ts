/**
 * Test suite for the JSON to CSV converter functionality (V2 format)
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
    isV2Format
} from '../../scripts/json-to-csv.js';
import type { AccountHistoryV2, CSVRow } from '../../scripts/json-to-csv.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

describe('JSON to CSV Converter (V2)', function() {
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

    describe('isV2Format', function() {
        it('should return true for V2 format', function() {
            const data = {
                version: 2,
                accountId: 'test.near',
                records: []
            };
            assert.equal(isV2Format(data), true);
        });

        it('should return false for V1 format', function() {
            const data = {
                accountId: 'test.near',
                transactions: []
            };
            assert.equal(isV2Format(data), false);
        });

        it('should return false for missing version', function() {
            const data = {
                accountId: 'test.near',
                records: []
            };
            assert.equal(isV2Format(data), false);
        });
    });

    describe('convertToCSVRows', function() {
        it('should convert BalanceChangeRecords to CSV rows', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 100,
                    block_timestamp: '2024-01-15T10:30:00.000Z',
                    tx_hash: 'hash1',
                    tx_block: 99,
                    signer_id: 'signer.near',
                    receiver_id: 'receiver.near',
                    predecessor_id: 'signer.near',
                    token_id: 'near',
                    receipt_id: 'receipt1',
                    counterparty: 'receiver.near',
                    amount: '-1000000000000000000000000',
                    balance_before: '5000000000000000000000000',
                    balance_after: '4000000000000000000000000'
                }
            ];

            const rows = await convertToCSVRows(records);
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

        it('should handle incoming transfers (positive amount)', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 200,
                    block_timestamp: '2024-01-15T11:00:00.000Z',
                    tx_hash: 'hash2',
                    tx_block: 199,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'near',
                    receipt_id: 'receipt2',
                    counterparty: 'sender.near',
                    amount: '2000000000000000000000000',
                    balance_before: '4000000000000000000000000',
                    balance_after: '6000000000000000000000000'
                }
            ];

            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.direction, 'in');
            assert.equal(rows[0]?.amountWholeUnits, '2');
            assert.equal(rows[0]?.balanceWholeUnits, '6');
        });

        it('should handle FT tokens', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 300,
                    block_timestamp: '2024-01-15T12:00:00.000Z',
                    tx_hash: 'hash3',
                    tx_block: 299,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'usdc.near',
                    receipt_id: 'receipt3',
                    counterparty: 'sender.near',
                    amount: '1000000',
                    balance_before: '0',
                    balance_after: '1000000'
                }
            ];

            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.asset, 'usdc.near');
            assert.equal(rows[0]?.direction, 'in');
        });

        it('should handle MT/Intents tokens', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 400,
                    block_timestamp: '2024-01-15T13:00:00.000Z',
                    tx_hash: 'hash4',
                    tx_block: 399,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'nep141:eth.omft.near',
                    receipt_id: 'receipt4',
                    counterparty: 'sender.near',
                    amount: '5000000000000000',
                    balance_before: '0',
                    balance_after: '5000000000000000'
                }
            ];

            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.asset, 'nep141:eth.omft.near');
        });

        it('should handle staking pool tokens', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 500,
                    block_timestamp: '2024-01-15T14:00:00.000Z',
                    tx_hash: 'hash5',
                    tx_block: 499,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'astro-stakers.poolv1.near',
                    receipt_id: 'receipt5',
                    counterparty: 'astro-stakers.poolv1.near',
                    amount: '1000000000000000000000000',
                    balance_before: '0',
                    balance_after: '1000000000000000000000000'
                }
            ];

            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 1);
            assert.ok(rows[0]?.asset.includes('STAKING:'));
        });

        it('should handle empty records array', async function() {
            const records: BalanceChangeRecord[] = [];
            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 0);
        });

        it('should handle multiple records', async function() {
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 100,
                    block_timestamp: '2024-01-15T10:00:00.000Z',
                    tx_hash: 'hash1',
                    tx_block: 99,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'near',
                    receipt_id: 'r1',
                    counterparty: 'a.near',
                    amount: '-100',
                    balance_before: '1100',
                    balance_after: '1000'
                },
                {
                    block_height: 100,
                    block_timestamp: '2024-01-15T10:00:00.000Z',
                    tx_hash: 'hash1',
                    tx_block: 99,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'usdc.near',
                    receipt_id: 'r2',
                    counterparty: 'b.near',
                    amount: '500',
                    balance_before: '0',
                    balance_after: '500'
                }
            ];

            const rows = await convertToCSVRows(records);
            assert.equal(rows.length, 2);
        });
    });

    describe('generateCSV', function() {
        it('should generate valid CSV with headers', function() {
            const rows: CSVRow[] = [
                {
                    changeBlockHeight: 100,
                    timestamp: '2024-01-15T10:00:00.000Z',
                    counterparty: 'test.near',
                    direction: 'out',
                    tokenSymbol: 'NEAR',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '4',
                    asset: 'NEAR',
                    amountRaw: '1000000000000000000000000',
                    tokenBalanceRaw: '4000000000000000000000000',
                    transactionHash: 'hash1',
                    receiptId: 'receipt1'
                }
            ];

            const csv = generateCSV(rows);
            const lines = csv.split('\n');

            // Check headers
            assert.ok(lines[0]?.includes('change_block_height'));
            assert.ok(lines[0]?.includes('timestamp'));
            assert.ok(lines[0]?.includes('counterparty'));
            assert.ok(lines[0]?.includes('direction'));
            assert.ok(lines[0]?.includes('token_symbol'));

            // Check data row
            assert.ok(lines[1]?.includes('100'));
            assert.ok(lines[1]?.includes('test.near'));
            assert.ok(lines[1]?.includes('out'));
            assert.ok(lines[1]?.includes('NEAR'));
        });

        it('should sort rows by block height ascending', function() {
            const rows: CSVRow[] = [
                {
                    changeBlockHeight: 300,
                    timestamp: '',
                    counterparty: '',
                    direction: 'in',
                    tokenSymbol: 'NEAR',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '1',
                    asset: 'NEAR',
                    amountRaw: '1',
                    tokenBalanceRaw: '1',
                    transactionHash: '',
                    receiptId: ''
                },
                {
                    changeBlockHeight: 100,
                    timestamp: '',
                    counterparty: '',
                    direction: 'in',
                    tokenSymbol: 'NEAR',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '1',
                    asset: 'NEAR',
                    amountRaw: '1',
                    tokenBalanceRaw: '1',
                    transactionHash: '',
                    receiptId: ''
                },
                {
                    changeBlockHeight: 200,
                    timestamp: '',
                    counterparty: '',
                    direction: 'in',
                    tokenSymbol: 'NEAR',
                    amountWholeUnits: '1',
                    balanceWholeUnits: '1',
                    asset: 'NEAR',
                    amountRaw: '1',
                    tokenBalanceRaw: '1',
                    transactionHash: '',
                    receiptId: ''
                }
            ];

            const csv = generateCSV(rows);
            const lines = csv.split('\n');

            // Data rows should be sorted: 100, 200, 300
            assert.ok(lines[1]?.startsWith('100'));
            assert.ok(lines[2]?.startsWith('200'));
            assert.ok(lines[3]?.startsWith('300'));
        });

        it('should handle empty rows array', function() {
            const csv = generateCSV([]);
            const lines = csv.split('\n');

            // Should just have header
            assert.equal(lines.length, 1);
            assert.ok(lines[0]?.includes('change_block_height'));
        });
    });

    describe('Real file processing', function() {
        // Skip this test if no test files available
        it.skip('should process V2 JSON files without errors', async function() {
            this.timeout(30000);

            const projectRoot = path.join(__dirname, '..');
            const jsonFiles = fs.readdirSync(projectRoot)
                .filter(f => f.endsWith('.near.json'));

            for (const jsonFile of jsonFiles) {
                const filePath = path.join(projectRoot, jsonFile);
                const content = fs.readFileSync(filePath, 'utf-8');
                const history = JSON.parse(content);

                // Skip V1 format files
                if (!isV2Format(history)) {
                    continue;
                }

                const rows = await convertToCSVRows(history.records);

                // Should not throw and should produce valid rows
                assert.ok(Array.isArray(rows));
            }
        });
    });
});
