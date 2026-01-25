import { describe, it } from 'mocha';
import assert from 'assert';
import {
    createBalanceChangeRecords,
    detectTokenGaps,
    getUniqueTokenIds,
    filterRecordsByToken,
    getLatestRecordPerToken,
    type BalanceChanges,
    type TransferDetail,
    type BalanceChangeRecord
} from '../../scripts/balance-tracker.js';

describe('createBalanceChangeRecords', function() {
    it('should create a record for NEAR balance change', () => {
        const changes: BalanceChanges = {
            hasChanges: true,
            nearChanged: true,
            nearDiff: '-1000000000000000000000000',
            tokensChanged: {},
            intentsChanged: {},
            startBalance: {
                near: '5000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {}
            },
            endBalance: {
                near: '4000000000000000000000000',
                fungibleTokens: {},
                intentsTokens: {}
            }
        };

        const transfers: TransferDetail[] = [{
            type: 'near',
            direction: 'out',
            amount: '1000000000000000000000000',
            counterparty: 'bob.near',
            txHash: 'ABC123',
            receiptId: 'DEF456'
        }];

        const records = createBalanceChangeRecords(
            182347200,
            1705320000000000000, // ~2024-01-15T12:00:00Z in nanoseconds
            changes,
            transfers,
            ['ABC123']
        );

        assert.strictEqual(records.length, 1);
        const record = records[0]!;
        assert.strictEqual(record.block_height, 182347200);
        assert.strictEqual(record.token_id, 'near');
        assert.strictEqual(record.amount, '-1000000000000000000000000');
        assert.strictEqual(record.balance_before, '5000000000000000000000000');
        assert.strictEqual(record.balance_after, '4000000000000000000000000');
        assert.strictEqual(record.counterparty, 'bob.near');
        assert.strictEqual(record.tx_hash, 'ABC123');
        assert.strictEqual(record.receipt_id, 'DEF456');
    });

    it('should create separate records for each changed token', () => {
        const changes: BalanceChanges = {
            hasChanges: true,
            nearChanged: true,
            nearDiff: '-100000000000000000000000',
            tokensChanged: {
                'usdc.near': {
                    start: '1000000000',
                    end: '900000000',
                    diff: '-100000000'
                }
            },
            intentsChanged: {
                'nep141:wrap.near': {
                    start: '500000000000000000000000',
                    end: '600000000000000000000000',
                    diff: '100000000000000000000000'
                }
            },
            startBalance: {
                near: '5000000000000000000000000',
                fungibleTokens: { 'usdc.near': '1000000000' },
                intentsTokens: { 'nep141:wrap.near': '500000000000000000000000' }
            },
            endBalance: {
                near: '4900000000000000000000000',
                fungibleTokens: { 'usdc.near': '900000000' },
                intentsTokens: { 'nep141:wrap.near': '600000000000000000000000' }
            }
        };

        const records = createBalanceChangeRecords(
            182347200,
            null,
            changes,
            undefined,
            ['TX123']
        );

        assert.strictEqual(records.length, 3);

        // Find records by token_id
        const nearRecord = records.find(r => r.token_id === 'near')!;
        const usdcRecord = records.find(r => r.token_id === 'usdc.near')!;
        const wrapRecord = records.find(r => r.token_id === 'nep141:wrap.near')!;

        assert.ok(nearRecord, 'NEAR record should exist');
        assert.ok(usdcRecord, 'USDC record should exist');
        assert.ok(wrapRecord, 'wNEAR record should exist');

        assert.strictEqual(nearRecord.amount, '-100000000000000000000000');
        assert.strictEqual(usdcRecord.amount, '-100000000');
        assert.strictEqual(wrapRecord.amount, '100000000000000000000000');

        // All should have same block
        assert.strictEqual(nearRecord.block_height, 182347200);
        assert.strictEqual(usdcRecord.block_height, 182347200);
        assert.strictEqual(wrapRecord.block_height, 182347200);
    });

    it('should create records for staking pool changes', () => {
        const changes: BalanceChanges = {
            hasChanges: true,
            nearChanged: false,
            tokensChanged: {},
            intentsChanged: {},
            stakingChanged: {
                'astro-stakers.poolv1.near': {
                    start: '100000000000000000000000000',
                    end: '100001000000000000000000000',
                    diff: '1000000000000000000000'
                }
            }
        };

        const records = createBalanceChangeRecords(
            182347200,
            null,
            changes,
            undefined,
            undefined
        );

        assert.strictEqual(records.length, 1);
        const record = records[0]!;
        assert.strictEqual(record.token_id, 'astro-stakers.poolv1.near');
        assert.strictEqual(record.amount, '1000000000000000000000');
        assert.strictEqual(record.counterparty, 'astro-stakers.poolv1.near');
        assert.strictEqual(record.balance_before, '100000000000000000000000000');
        assert.strictEqual(record.balance_after, '100001000000000000000000000');
    });

    it('should return empty array when no changes', () => {
        const changes: BalanceChanges = {
            hasChanges: false,
            nearChanged: false,
            tokensChanged: {},
            intentsChanged: {}
        };

        const records = createBalanceChangeRecords(
            182347200,
            null,
            changes,
            undefined,
            undefined
        );

        assert.strictEqual(records.length, 0);
    });

    it('should handle timestamp conversion to ISO 8601', () => {
        const changes: BalanceChanges = {
            hasChanges: true,
            nearChanged: true,
            nearDiff: '1000',
            tokensChanged: {},
            intentsChanged: {},
            startBalance: { near: '0', fungibleTokens: {}, intentsTokens: {} },
            endBalance: { near: '1000', fungibleTokens: {}, intentsTokens: {} }
        };

        // Timestamp: 2024-01-15T12:00:00.000Z = 1705320000000 ms = 1705320000000000000 ns
        const timestampNs = 1705320000000000000;

        const records = createBalanceChangeRecords(
            182347200,
            timestampNs,
            changes,
            undefined,
            undefined
        );

        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0]!.block_timestamp, '2024-01-15T12:00:00.000Z');
    });
});

describe('detectTokenGaps', function() {
    it('should detect no gaps when balances connect properly', () => {
        const records: BalanceChangeRecord[] = [
            {
                block_height: 100,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '1000',
                balance_before: '0',
                balance_after: '1000'
            },
            {
                block_height: 200,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '500',
                balance_before: '1000',  // Matches previous balance_after
                balance_after: '1500'
            }
        ];

        const gaps = detectTokenGaps(records);
        assert.strictEqual(gaps.length, 0);
    });

    it('should detect gap when balances do not match', () => {
        const records: BalanceChangeRecord[] = [
            {
                block_height: 100,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '1000',
                balance_before: '0',
                balance_after: '1000'
            },
            {
                block_height: 200,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '500',
                balance_before: '800',  // MISMATCH: should be 1000
                balance_after: '1300'
            }
        ];

        const gaps = detectTokenGaps(records);
        assert.strictEqual(gaps.length, 1);
        assert.strictEqual(gaps[0]!.token_id, 'near');
        assert.strictEqual(gaps[0]!.from_block, 100);
        assert.strictEqual(gaps[0]!.to_block, 200);
        assert.strictEqual(gaps[0]!.expected_balance, '1000');
        assert.strictEqual(gaps[0]!.actual_balance, '800');
        assert.strictEqual(gaps[0]!.diff, '-200');
    });

    it('should track gaps independently for each token', () => {
        const records: BalanceChangeRecord[] = [
            // NEAR records - connected properly
            {
                block_height: 100,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '1000',
                balance_before: '0',
                balance_after: '1000'
            },
            {
                block_height: 200,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '500',
                balance_before: '1000',
                balance_after: '1500'
            },
            // USDC records - has gap
            {
                block_height: 150,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'usdc.near',
                receipt_id: null,
                counterparty: null,
                amount: '100',
                balance_before: '0',
                balance_after: '100'
            },
            {
                block_height: 250,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'usdc.near',
                receipt_id: null,
                counterparty: null,
                amount: '50',
                balance_before: '200',  // MISMATCH: should be 100
                balance_after: '250'
            }
        ];

        const gaps = detectTokenGaps(records);
        assert.strictEqual(gaps.length, 1);
        assert.strictEqual(gaps[0]!.token_id, 'usdc.near');
        assert.strictEqual(gaps[0]!.expected_balance, '100');
        assert.strictEqual(gaps[0]!.actual_balance, '200');
    });

    it('should handle empty records', () => {
        const gaps = detectTokenGaps([]);
        assert.strictEqual(gaps.length, 0);
    });

    it('should handle single record per token (no consecutive pair)', () => {
        const records: BalanceChangeRecord[] = [
            {
                block_height: 100,
                block_timestamp: null,
                tx_hash: null,
                tx_block: null,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: '1000',
                balance_before: '0',
                balance_after: '1000'
            }
        ];

        const gaps = detectTokenGaps(records);
        assert.strictEqual(gaps.length, 0);
    });
});

describe('Token utility functions', function() {
    const sampleRecords: BalanceChangeRecord[] = [
        {
            block_height: 100,
            block_timestamp: null,
            tx_hash: null,
            tx_block: null,
            signer_id: null,
            receiver_id: null,
            predecessor_id: null,
            token_id: 'near',
            receipt_id: null,
            counterparty: null,
            amount: '1000',
            balance_before: '0',
            balance_after: '1000'
        },
        {
            block_height: 200,
            block_timestamp: null,
            tx_hash: null,
            tx_block: null,
            signer_id: null,
            receiver_id: null,
            predecessor_id: null,
            token_id: 'usdc.near',
            receipt_id: null,
            counterparty: null,
            amount: '100',
            balance_before: '0',
            balance_after: '100'
        },
        {
            block_height: 300,
            block_timestamp: null,
            tx_hash: null,
            tx_block: null,
            signer_id: null,
            receiver_id: null,
            predecessor_id: null,
            token_id: 'near',
            receipt_id: null,
            counterparty: null,
            amount: '500',
            balance_before: '1000',
            balance_after: '1500'
        }
    ];

    it('getUniqueTokenIds should return unique token IDs', () => {
        const tokenIds = getUniqueTokenIds(sampleRecords);
        assert.strictEqual(tokenIds.length, 2);
        assert.ok(tokenIds.includes('near'));
        assert.ok(tokenIds.includes('usdc.near'));
    });

    it('filterRecordsByToken should filter correctly', () => {
        const nearRecords = filterRecordsByToken(sampleRecords, 'near');
        assert.strictEqual(nearRecords.length, 2);
        assert.ok(nearRecords.every(r => r.token_id === 'near'));

        const usdcRecords = filterRecordsByToken(sampleRecords, 'usdc.near');
        assert.strictEqual(usdcRecords.length, 1);
        assert.strictEqual(usdcRecords[0]!.token_id, 'usdc.near');
    });

    it('getLatestRecordPerToken should return latest record for each token', () => {
        const latest = getLatestRecordPerToken(sampleRecords);
        assert.strictEqual(latest.size, 2);

        const latestNear = latest.get('near')!;
        assert.strictEqual(latestNear.block_height, 300);
        assert.strictEqual(latestNear.balance_after, '1500');

        const latestUsdc = latest.get('usdc.near')!;
        assert.strictEqual(latestUsdc.block_height, 200);
        assert.strictEqual(latestUsdc.balance_after, '100');
    });
});
