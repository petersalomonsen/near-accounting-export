import { describe, it } from 'mocha';
import assert from 'assert';
import { resolveNearDuplicates } from '../../scripts/transfers-sync.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

// One NEAR movement, stored twice a few blocks apart: on petersalomonsen.near
// ten intents withdrawals (2026-10-22..11-09, ~26.6 NEAR) were each written at
// the block the balance changed AND four blocks earlier, with identical amount
// and balances. Read as a ledger, each copy is a "missing outflow"; summed, it
// is income twice. Which copy is right is not a matter of source — in one pair
// the transfers API row was early, in another the row without a transaction —
// so the chain decides: the copy at the block where the balance really moved.

const N = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

function rec(block: number, before: number, after: number, over: Partial<BalanceChangeRecord> = {}): BalanceChangeRecord {
    return {
        block_height: block, block_timestamp: new Date(1_792_683_529_000 + block).toISOString(),
        tx_hash: null, tx_block: null, signer_id: null, receiver_id: null, predecessor_id: null,
        receipt_id: null, counterparty: null, token_id: 'near',
        amount: (BigInt(N(after)) - BigInt(N(before))).toString(),
        balance_before: N(before), balance_after: N(after), ...over,
    };
}

/** The chain: the balance is 35.6 up to block 268 and 37.9 from 269. */
function chain(balances: (block: number) => number) {
    const reads: number[] = [];
    return {
        reads,
        sampler: {
            balanceAt: async (b: number) => { reads.push(b); return N(balances(b)); },
            timestampOf: async () => null,
        },
    };
}
const movedAt269 = (b: number) => (b >= 269 ? 37.9 : 35.6);

const withdrawal = { tx_hash: 'DTJZ3FQK', receipt_id: 'HrwfSfUV', counterparty: 'intents.near', predecessor_id: 'intents.near', receiver_id: 'petersalomonsen.near' };

describe('resolveNearDuplicates', function () {
    it('keeps the copy at the block where the balance moved, and drops the early one', async () => {
        const { sampler } = chain(movedAt269);
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.6, 37.9, withdrawal), rec(200, 30, 35.6)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.deepEqual(r.records.map(x => x.block_height), [269, 200]);
        assert.equal(r.removed, 1);
    });

    it('takes the transaction details from the dropped copy when the kept one has none', async () => {
        // 2026-10-25: the row at the right block had no transaction; the API's
        // row with the hash and counterparty sat four blocks early.
        const { sampler } = chain(movedAt269);
        const records = [rec(269, 35.6, 37.9, { counterparty: 'unknown' }), rec(265, 35.6, 37.9, withdrawal)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.equal(r.records.length, 1);
        const kept = r.records[0]!;
        assert.equal(kept.block_height, 269);
        assert.equal(kept.tx_hash, 'DTJZ3FQK');
        assert.equal(kept.receipt_id, 'HrwfSfUV');
        assert.equal(kept.counterparty, 'intents.near');
        assert.equal(kept.balance_before, N(35.6));
    });

    it('keeps the early copy when that is where the balance moved', async () => {
        const { sampler } = chain(b => (b >= 265 ? 37.9 : 35.6));
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.6, 37.9, withdrawal)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.deepEqual(r.records.map(x => x.block_height), [265]);
    });

    it('keeps both when the chain shows both movements', async () => {
        // 10 -> 11 at 300, back to 10 at 302, 10 -> 11 again at 304.
        const { sampler } = chain(b => (b >= 304 ? 11 : b >= 302 ? 10 : b >= 300 ? 11 : 10));
        const records = [rec(304, 10, 11), rec(302, 11, 10), rec(300, 10, 11)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.equal(r.records.length, 3);
        assert.equal(r.removed, 0);
    });

    it('changes nothing when the chain confirms neither copy', async () => {
        const { sampler } = chain(() => 35.6);
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.6, 37.9, withdrawal)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.equal(r.records.length, 2);
        assert.equal(r.removed, 0);
    });

    it('changes nothing when the chain cannot be read', async () => {
        const failing = { balanceAt: async () => { throw new Error('429'); }, timestampOf: async () => null };
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.6, 37.9, withdrawal)];
        const r = await resolveNearDuplicates(records, failing);
        assert.equal(r.records.length, 2);
    });

    it('reads nothing when there is no duplicate, and leaves copies far apart alone', async () => {
        const { sampler, reads } = chain(movedAt269);
        // The same amount and balances 1 000 blocks apart is a repeat, not a copy.
        const records = [rec(1269, 35.6, 37.9), rec(500, 37.9, 35.6), rec(269, 35.6, 37.9), rec(200, 30, 35.6)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.equal(r.records.length, 4);
        assert.equal(reads.length, 0);
    });

    it('treats one receipt at two blocks as one movement even when the balances differ', async () => {
        const { sampler } = chain(movedAt269);
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.5, 37.8, withdrawal)];
        const r = await resolveNearDuplicates(records, sampler);
        assert.deepEqual(r.records.map(x => x.block_height), [269]);
    });

    it('reads nothing without a sampler', async () => {
        const records = [rec(269, 35.6, 37.9, withdrawal), rec(265, 35.6, 37.9, withdrawal)];
        const r = await resolveNearDuplicates(records, null);
        assert.equal(r.records.length, 2);
    });

    it('leaves other tokens and reconciliation records alone', async () => {
        const { sampler, reads } = chain(movedAt269);
        const ft = { ...rec(269, 35.6, 37.9), token_id: 'wrap.near' };
        const ft2 = { ...rec(265, 35.6, 37.9), token_id: 'wrap.near' };
        const r = await resolveNearDuplicates([ft, ft2], sampler);
        assert.equal(r.records.length, 2);
        assert.equal(reads.length, 0);
    });
});
