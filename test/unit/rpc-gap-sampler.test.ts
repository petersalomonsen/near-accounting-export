import { describe, it } from 'mocha';
import assert from 'assert';
import { makeRpcGapSampler } from '../../scripts/rpc-gap-sampler.js';
import type { TokenGap } from '../../scripts/balance-tracker.js';

// A gap: wrap.near balance is 10 up to (and incl.) block 149, then 50 from 150 on
// — a non-transfer mint of 40 at block 150 inside the (100, 200] gap.
function balanceAtFor(changeBlock: number, before: string, after: string) {
    let calls = 0;
    const fn = async (_token: string, block: number) => {
        calls++;
        return block < changeBlock ? before : after;
    };
    return { fn, calls: () => calls };
}

const gap: TokenGap = {
    token_id: 'wrap.near',
    from_block: 100,
    to_block: 200,
    expected_balance: '10',
    actual_balance: '50',
    diff: '40',
};

describe('makeRpcGapSampler', function () {
    it('bisects to the exact mint block and emits one real record', async () => {
        const b = balanceAtFor(150, '10', '50');
        const sampler = makeRpcGapSampler('acct.near', {
            balanceAt: b.fn,
            blockTimestamp: async () => 1_700_000_000_000_000_000, // ns
        });
        const out = await sampler(gap);
        assert.equal(out.length, 1);
        assert.equal(out[0]!.block_height, 150, 'found the change block');
        assert.equal(out[0]!.amount, '40');
        assert.equal(out[0]!.balance_before, '10');
        assert.equal(out[0]!.balance_after, '50');
        assert.equal(out[0]!.token_id, 'wrap.near');
        assert.ok(out[0]!.block_timestamp, 'has a real timestamp (not null)');
        // ~log2(100) calls, not 100
        assert.ok(b.calls() <= 8, `bounded RPC: ${b.calls()} calls`);
    });

    it('respects the bisect step cap (returns [] rather than spinning)', async () => {
        const b = balanceAtFor(150, '10', '50');
        const sampler = makeRpcGapSampler('acct.near', {
            balanceAt: b.fn,
            blockTimestamp: async () => 1_700_000_000_000_000_000,
            maxBisectSteps: 2,
        });
        // huge range, only 2 steps -> can't isolate -> []
        const out = await sampler({ ...gap, from_block: 0, to_block: 1_000_000 });
        assert.deepEqual(out, []);
    });
});
