import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import {
    findBalanceChangingTransaction,
    getBalanceChangesAtBlock,
    createBalanceChangeRecords,
    settleBlockFor,
    RECEIPT_SETTLE_WINDOW,
} from '../../scripts/balance-tracker.js';

/**
 * A pool that pays out inside the unstake transaction.
 *
 * petersalomonsen.near, 2026-09-28, tx JDaZfdNRyx3fRJzB3Lq6i3rHofbzM4VGYvWt6KDsfCfq
 * against npro.poolv1.near (NEAR Mobile's pool). A standard pool needs a
 * second transaction, four epochs later, to pay out; this one pays out two
 * blocks after the unstake, under the same transaction:
 *
 *   block 217641381  33.481 NEAR  (before)
 *   block 217641382  33.306        the 0.176 attached deposit leaves  <- tx block
 *   block 217641384  1233.481      1200 NEAR arrive from the pool, 0.1755 refund
 *   block 217641385  1233.481      a last 0.0002 refund
 *
 * Sampling the balance at the transaction block alone recorded a 0.176 NEAR
 * debit for this transaction and nothing for the 1 200 NEAR — the portfolio
 * then showed the 1 200 reappearing later as money added from outside, and a
 * pool-balance sample taken between the two blocks as reward.
 */
describe('A transaction whose receipts settle after its block', function () {
    this.timeout(120000);

    const accountId = 'petersalomonsen.near';
    const txBlock = 217641382;
    const txHash = 'JDaZfdNRyx3fRJzB3Lq6i3rHofbzM4VGYvWt6KDsfCfq';
    const balanceBefore = '33481463213303192705794823';
    const balanceSettled = '1233481198899965579805794823';

    it('finds the payout receipt and the block it executed in', async function () {
        const txInfo = await findBalanceChangingTransaction(accountId, txBlock);
        if (txInfo.settleBlock === undefined) {
            // The block-data source was rate limited and the plain-RPC fallback
            // found the transaction without its receipts. The net-effect test
            // below covers that path; this one is about the receipts.
            this.skip();
        }
        assert.ok(txInfo.transactionHashes.includes(txHash), 'should find the unstake transaction');

        const payout = txInfo.transfers.find(t =>
            t.type === 'near' && t.direction === 'in' && t.counterparty === 'npro.poolv1.near');
        assert.ok(payout, 'should see the 1200 NEAR coming back from the pool');
        assert.equal(payout!.amount, '1200000000000000000000000000');
        assert.equal(payout!.receiptBlock, 217641384, 'the payout executed two blocks after the transaction');
        assert.ok(txInfo.settleBlock! >= 217641384, `settled no earlier than the payout, got ${txInfo.settleBlock}`);
        assert.ok(txInfo.settleBlock! <= txBlock + 5, `settled within the receipt window, got ${txInfo.settleBlock}`);
    });

    it('records the net effect of the transaction, payout included', async function () {
        const txInfo = await findBalanceChangingTransaction(accountId, txBlock);
        // As the known-block path does: where the receipts landed if known,
        // a fixed window later if the block-data source could not say.
        const settleBlock = settleBlockFor(txBlock, txInfo.transfers, undefined, RECEIPT_SETTLE_WINDOW);
        const changes = await getBalanceChangesAtBlock(accountId, txBlock, null, null, undefined, settleBlock);

        assert.equal(changes.startBalance?.near, balanceBefore);
        assert.equal(changes.endBalance?.near, balanceSettled, 'the balance after the transaction is the settled one');
        assert.equal(BigInt(changes.nearDiff!), BigInt(balanceSettled) - BigInt(balanceBefore));

        const records = createBalanceChangeRecords(txBlock, txInfo.blockTimestamp, changes, txInfo.transfers, txInfo.transactionHashes);
        const near = records.find(r => r.token_id === 'near');
        assert.ok(near, 'one NEAR record for the transaction');
        assert.equal(near!.balance_before, balanceBefore);
        assert.equal(near!.balance_after, balanceSettled);
        if (txInfo.settleBlock !== undefined) assert.equal(near!.tx_hash, txHash);
    });

    it('still reads the transaction block alone when asked to', async function () {
        const changes = await getBalanceChangesAtBlock(accountId, txBlock, null, null, undefined);
        assert.equal(changes.endBalance?.near, '33305544004642223205794823');
    });
});
