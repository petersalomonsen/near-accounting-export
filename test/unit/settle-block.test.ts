import { describe, it } from 'mocha';
import assert from 'assert';
import { settleBlockFor } from '../../scripts/balance-tracker.js';
import type { TransferDetail } from '../../scripts/balance-tracker.js';

// A transaction's NEAR effect is not confined to its own block. The deposit
// leaves at the transaction block; receipts that credit the account — a
// staking pool paying out, a gas refund — execute one to a few blocks later.
// The block to read the balance after the transaction at is the last block in
// which one of its receipts touched the account, never past the next known
// transaction.
describe('settleBlockFor', function () {
    const transfer = (over: Partial<TransferDetail>): TransferDetail => ({
        type: 'near', direction: 'in', amount: '1', counterparty: 'x', ...over,
    });

    it('is the transaction block when nothing settled later', function () {
        assert.strictEqual(settleBlockFor(100, [transfer({ receiptBlock: 100 })]), 100);
        assert.strictEqual(settleBlockFor(100, []), 100);
        assert.strictEqual(settleBlockFor(100, [transfer({})]), 100);
    });

    it('is the last block a receipt of the transaction executed in', function () {
        const transfers = [
            transfer({ receiptBlock: 100, direction: 'out' }),
            transfer({ receiptBlock: 102, counterparty: 'npro.poolv1.near' }),
            transfer({ receiptBlock: 103, counterparty: 'system' }),
        ];
        assert.strictEqual(settleBlockFor(100, transfers), 103);
    });

    it('never reaches the next known transaction', function () {
        const transfers = [transfer({ receiptBlock: 103 })];
        assert.strictEqual(settleBlockFor(100, transfers, 102), 101);
        assert.strictEqual(settleBlockFor(100, transfers, 101), 100);
        assert.strictEqual(settleBlockFor(100, transfers, 200), 103);
    });

    it('ignores a receipt block before the transaction block', function () {
        assert.strictEqual(settleBlockFor(100, [transfer({ receiptBlock: 98 })]), 100);
    });

    it('reads a fixed window later when no receipt block is known at all', function () {
        // The plain-RPC fallback finds the transaction but not where its
        // receipts landed. Everything it set in motion has settled a few
        // blocks on, so the balance is read there — still short of the next
        // known transaction.
        assert.strictEqual(settleBlockFor(100, [], undefined, 5), 105);
        assert.strictEqual(settleBlockFor(100, [transfer({})], undefined, 5), 105);
        assert.strictEqual(settleBlockFor(100, [], 103, 5), 102);
        // A known receipt block wins over the window, even when earlier.
        assert.strictEqual(settleBlockFor(100, [transfer({ receiptBlock: 102 })], undefined, 5), 102);
    });
});
