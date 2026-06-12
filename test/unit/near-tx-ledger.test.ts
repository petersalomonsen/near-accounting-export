import { describe, it } from 'mocha';
import assert from 'assert';
import { groupTxBlocks, buildNearLedger, SETTLE_BUFFER } from '../../scripts/near-tx-ledger.js';

describe('groupTxBlocks', function () {
    it('merges tx blocks that settle within SETTLE_BUFFER, splits the rest', () => {
        const g = groupTxBlocks([200, 100, 102, 110]);
        // 100,102,110 chain together (each within SETTLE_BUFFER of the growing window); 200 separate
        assert.equal(g.length, 2);
        assert.equal(g[0]!.firstBlock, 100);
        assert.equal(g[1]!.firstBlock, 200);
    });

    it('de-duplicates same-block transactions into one group', () => {
        const g = groupTxBlocks([500, 500, 500]);
        assert.equal(g.length, 1);
        assert.equal(g[0]!.firstBlock, 500);
    });
});

describe('buildNearLedger', function () {
    it('produces one net record per tx group (before/after the whole tx, no gas ticks)', async () => {
        // Two transactions: group at 100 (net -10), group at 200 (net -5).
        const balances = (block: number) =>
            block < 100 ? '100' :
            block < 200 ? '90' :  // settled after tx@100
            '85';                 // settled after tx@200
        const { records, rpcReads } = await buildNearLedger('acct.near', {
            fetchTxBlocks: async () => [100, 200],
            nearBalanceAt: async (b) => balances(b),
            blockTimestamp: async () => 1_700_000_000_000_000_000,
        });
        assert.equal(records.length, 2);
        // newest first
        assert.deepEqual(records.map(r => r.block_height), [200, 100]);
        const byBlock = Object.fromEntries(records.map(r => [r.block_height, r]));
        assert.equal(byBlock[100]!.amount, '-10');
        assert.equal(byBlock[100]!.balance_before, '100');
        assert.equal(byBlock[100]!.balance_after, '90');
        assert.equal(byBlock[200]!.amount, '-5');
        assert.equal(byBlock[200]!.token_id, 'near');
        assert.ok(byBlock[200]!.block_timestamp, 'has timestamp');
        // ~1 read per tx group + 1 initial "before"
        assert.equal(rpcReads, 3);
    });

    it('collapses intra-tx gas ticks: a single tx sampled only before/after', async () => {
        // tx at block 1000; within its settlement the balance dips (gas) then refunds,
        // but we only sample before (999) and the settled point (>=1000+BUFFER).
        let sampledBlocks: number[] = [];
        const { records } = await buildNearLedger('acct.near', {
            fetchTxBlocks: async () => [1000],
            nearBalanceAt: async (b) => { sampledBlocks.push(b); return b < 1000 ? '50' : '49'; },
            blockTimestamp: async () => 1_700_000_000_000_000_000,
        });
        assert.equal(records.length, 1);
        assert.equal(records[0]!.amount, '-1', 'net of the whole tx (gas), not the intra-tx dips');
        assert.equal(records[0]!.balance_before, '50');
        assert.equal(records[0]!.balance_after, '49');
        // only two samples: before (999) and settled (1000+BUFFER) — no per-block sampling
        assert.equal(sampledBlocks.length, 2);
        assert.equal(sampledBlocks[0], 999);
        assert.equal(sampledBlocks[1], 1000 + SETTLE_BUFFER);
    });

    it('omits groups with zero net change', async () => {
        const { records } = await buildNearLedger('acct.near', {
            fetchTxBlocks: async () => [100, 200],
            nearBalanceAt: async () => '100', // never changes
            blockTimestamp: async () => 1_700_000_000_000_000_000,
        });
        assert.deepEqual(records, []);
    });
});
