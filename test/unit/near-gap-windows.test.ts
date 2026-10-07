import { describe, it } from 'mocha';
import assert from 'assert';
import { nearGapWindows, fillNearGapsFromApi, recordsForDebitsAtOrigin } from '../../scripts/transfers-sync.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

// The NEAR ledger proves its own gaps: a record whose balance_after is not the
// next record's balance_before. The data says where the missing transfer lies,
// so only that stretch is fetched — never the whole history, never anything
// when the ledger chains.

const T0 = Date.parse('2026-09-28T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const N = (near: number) => (BigInt(Math.round(near * 1e6)) * 10n ** 18n).toString();

function rec(block: number, ms: number, before: number, after: number, over: Partial<BalanceChangeRecord> = {}): BalanceChangeRecord {
    return {
        block_height: block, block_timestamp: iso(ms), tx_hash: 'tx', tx_block: null,
        signer_id: null, receiver_id: null, predecessor_id: null, receipt_id: null,
        counterparty: null, token_id: 'near',
        amount: (BigInt(N(after)) - BigInt(N(before))).toString(),
        balance_before: N(before), balance_after: N(after), ...over,
    };
}

describe('nearGapWindows', function () {
    it('is empty when the ledger chains', () => {
        const chained = [rec(100, T0, 10, 9), rec(200, T0 + 60_000, 9, 8)];
        assert.deepEqual(nearGapWindows(chained), []);
    });

    it('does not read two transfers in one block as a gap', () => {
        // Both carry the block's start and end balances; chained, the first's
        // end against the second's start looks like 1 200 NEAR missing inside
        // one block. Nothing is, and a window here would be fetched forever.
        const records = [
            rec(400, T0 + 1_000, 1233.3, 1233.3, { amount: N(0.0002) }),
            rec(384, T0 + 500, 33.3, 1233.3, { counterparty: 'npro.poolv1.near' }),
            rec(384, T0 + 500, 33.3, 1233.3, { counterparty: 'system', amount: N(0.1755) }),
            rec(382, T0, 33.5, 33.3),
        ];
        assert.deepEqual(nearGapWindows(records), []);
    });

    it('bounds the window by the records on either side of the gap', () => {
        // 1 200 NEAR arrived between block 382 (after 33.3) and block 723 (before 1233.3).
        const records = [
            rec(723, T0 + 200_000, 1233.3, 33.4),
            rec(382, T0, 33.5, 33.3),
        ];
        const [w] = nearGapWindows(records);
        assert.ok(w);
        assert.equal(w.fromBlock, 382);
        assert.equal(w.toBlock, 723);
        assert.equal(w.fromTimestampMs, T0);
        assert.equal(w.toTimestampMs, T0 + 200_000);
        assert.equal(w.weight, BigInt(N(1200)));
    });

    it('coalesces a run of specks into one window, keeps a long gap apart, heaviest first', () => {
        const records = [
            rec(100, T0, 10, 9.99),
            rec(110, T0 + 10_000, 9.98, 9.97),            // gap of 0.01 right after
            rec(120, T0 + 20_000, 9.96, 9.95),            // another 0.01
            rec(5000, T0 + 48 * 3_600_000, 1209.95, 9.5), // 1 200 arrived two days later
        ];
        // The specks' windows touch the big one — every consecutive gap does —
        // but merging would make a two-day fetch out of a twenty-second one.
        const windows = nearGapWindows(records);
        assert.equal(windows.length, 2);
        assert.equal(windows[0]!.weight, BigInt(N(1200)));
        assert.equal(windows[0]!.fromBlock, 120);
        assert.equal(windows[1]!.gaps, 2, 'the two specks are one window');
        assert.equal(windows[1]!.fromBlock, 100);
        assert.equal(windows[1]!.toBlock, 120);
    });

    it('returns at most maxWindows and skips a gap it cannot date', () => {
        const records = [
            rec(100, T0, 1, 0.9), rec(200, T0 + 10 * 3_600_000, 0.8, 0.7),
            rec(300, T0 + 20 * 3_600_000, 0.6, 0.5), rec(400, T0 + 30 * 3_600_000, 0.4, 0.3),
            { ...rec(500, T0 + 40 * 3_600_000, 0.2, 0.1), block_timestamp: null },
        ];
        assert.equal(nearGapWindows(records).length, 3, 'three datable gaps, the undated one is left alone');
        assert.equal(nearGapWindows(records, { maxWindows: 2 }).length, 2);
    });
});

describe('fillNearGapsFromApi', function () {
    it('fetches only the window and adopts what closes the gap', async () => {
        const records = [
            rec(723, T0 + 200_000, 1233.3, 33.4, { tx_hash: 'wrap' }),
            rec(382, T0, 33.5, 33.3, { tx_hash: 'unstake' }),
        ];
        const asked: Array<{ from?: number; to?: number }> = [];
        const result = await fillNearGapsFromApi('acct.near', records, async (_a, o) => {
            asked.push({ from: o.fromTimestampMs, to: o.toTimestampMs });
            return [
                // the payout, two blocks after the unstake
                rec(384, T0 + 1_000, 33.3, 1233.3, { tx_hash: 'unstake', counterparty: 'npro.poolv1.near' }),
                // the wrap's NEAR reported again at its receipt block, moving nothing
                rec(724, T0 + 201_000, 33.4, 33.4, { tx_hash: 'wrap', amount: N(-1200) }),
            ];
        });
        assert.equal(asked.length, 1, 'one request for one window');
        assert.ok(asked[0]!.from! <= T0 && asked[0]!.to! >= T0 + 200_000, 'the window spans the gap');
        assert.equal(result.filled, 1);
        assert.equal(result.gaps.length, 0, 'the gap is closed');
        assert.ok(result.records.some(r => r.block_height === 384 && r.counterparty === 'npro.poolv1.near'));
        assert.ok(!result.records.some(r => r.block_height === 724), 'a transfer that moved nothing is not adopted');
    });

    it('makes no request when the ledger chains', async () => {
        const chained = [rec(100, T0, 10, 9), rec(200, T0 + 60_000, 9, 8)];
        const result = await fillNearGapsFromApi('acct.near', chained, async () => { throw new Error('should not fetch'); });
        assert.equal(result.requests, 0);
        assert.equal(result.filled, 0);
    });

    it('leaves the gap for the next cycle when the API fails', async () => {
        const records = [rec(723, T0 + 200_000, 1233.3, 33.4), rec(382, T0, 33.5, 33.3)];
        const result = await fillNearGapsFromApi('acct.near', records, async () => { throw new Error('503'); });
        assert.equal(result.requests, 1);
        assert.equal(result.gaps.length, 1);
        assert.equal(result.records.length, 2);
    });
});

describe('fillNearGapsFromApi backoff', function () {
    const gapped = () => [
        rec(723, T0 + 200_000, 1233.3, 33.4, { tx_hash: 'wrap' }),
        rec(382, T0, 33.5, 33.3, { tx_hash: 'unstake' }),
    ];
    const nothing = async () => [] as BalanceChangeRecord[];

    it('does not fetch a window again until its backoff has passed, then doubles it', async () => {
        let calls = 0;
        const count = async () => { calls++; return [] as BalanceChangeRecord[]; };
        const first = await fillNearGapsFromApi('a', gapped(), count, { nowMs: T0 });
        assert.equal(calls, 1);
        assert.equal(first.attempts['382']!.tries, 1);
        assert.equal(first.attempts['382']!.nextAfterMs, T0 + 3_600_000, 'first wait is one hour');

        const soon = await fillNearGapsFromApi('a', gapped(), count, { nowMs: T0 + 60_000, attempts: first.attempts });
        assert.equal(calls, 1, 'no request one minute later');
        assert.equal(soon.deferred, 1);
        assert.deepEqual(soon.attempts, first.attempts, 'memory carried unchanged');

        const later = await fillNearGapsFromApi('a', gapped(), count, { nowMs: T0 + 2 * 3_600_000, attempts: first.attempts });
        assert.equal(calls, 2, 'tried again once the hour has passed');
        assert.equal(later.attempts['382']!.tries, 2);
        assert.equal(later.attempts['382']!.nextAfterMs, T0 + 2 * 3_600_000 + 2 * 3_600_000, 'second wait is two hours');
    });

    it('never waits longer than a week', async () => {
        let attempts = {};
        let now = T0;
        const waits: number[] = [];
        for (let i = 0; i < 12; i++) {
            const r = await fillNearGapsFromApi('a', gapped(), nothing, { nowMs: now, attempts });
            attempts = r.attempts;
            waits.push(r.attempts['382']!.nextAfterMs - now);
            now = r.attempts['382']!.nextAfterMs;
        }
        assert.equal(waits[0], 3_600_000);
        assert.equal(waits[1], 2 * 3_600_000);
        assert.equal(waits[11], 7 * 24 * 3_600_000);
        assert.ok(waits.every(w => w <= 7 * 24 * 3_600_000));
        assert.equal((attempts as any)['382'].tries, 12);
    });

    it('forgets a window once it fills, and one that no longer exists', async () => {
        const payout = async () => [rec(384, T0 + 1_000, 33.3, 1233.3, { tx_hash: 'unstake', counterparty: 'npro.poolv1.near' })];
        const r = await fillNearGapsFromApi('a', gapped(), payout, { nowMs: T0, attempts: { '382': { tries: 3, nextAfterMs: 0 }, '999': { tries: 1, nextAfterMs: 0 } } });
        assert.equal(r.filled, 1);
        assert.deepEqual(r.attempts, {}, 'the filled window and the stale key are both gone');
    });

    it('does not hold a transient API error against the window', async () => {
        const r = await fillNearGapsFromApi('a', gapped(), async () => { throw new Error('503'); }, { nowMs: T0 });
        assert.deepEqual(r.attempts, {});
    });
});

describe('recordsForDebitsAtOrigin', function () {
    // The treasury on 2026-09-25: 249.284 until block 679; 230 leave at 680;
    // 0.1 leaves at 684. The API reports both at their receipt blocks, 683
    // and 685, with balances that already exclude them.
    const balances: Record<number, number> = { 676: 249.284, 677: 249.284, 678: 249.284, 679: 249.284, 680: 19.284, 681: 19.284, 682: 19.284, 683: 19.284, 684: 19.184, 685: 19.184 };
    let reads = 0;
    const sampler = {
        balanceAt: async (b: number) => { reads++; if (!(b in balances)) throw new Error('unexpected read at ' + b); return N(balances[b]!); },
        timestampOf: async (b: number) => BigInt(T0 + b * 1000) * 1000000n as unknown as number,
    };
    const afterTheFact = [
        rec(683, T0 + 683_000, 19.284, 19.284, { amount: N(-230), tx_hash: 'CS1J', counterparty: 'wrap.near', receipt_id: 'r1' }),
        rec(685, T0 + 685_000, 19.184, 19.184, { amount: N(-0.1), tx_hash: 'CS1J', counterparty: 'petersalomonsen.near', receipt_id: 'r2' }),
    ];

    it('finds the block each debit left in and writes the record there', async () => {
        reads = 0;
        const { records, reads: r } = await recordsForDebitsAtOrigin(afterTheFact, sampler);
        assert.equal(r, reads);
        assert.ok(reads <= 10, 'a handful of reads, got ' + reads);
        const byBlock = Object.fromEntries(records.map(x => [x.block_height, x]));
        assert.deepEqual(Object.keys(byBlock).map(Number).sort(), [680, 684]);
        assert.equal(byBlock[680]!.balance_before, N(249.284));
        assert.equal(byBlock[680]!.balance_after, N(19.284));
        assert.equal(byBlock[680]!.amount, N(-230));
        assert.equal(byBlock[680]!.tx_hash, 'CS1J');
        assert.equal(byBlock[680]!.counterparty, 'wrap.near');
        assert.equal(byBlock[684]!.amount, N(-0.1));
        assert.ok(byBlock[680]!.block_timestamp?.startsWith('20'));
    });

    it('two debits that left in one block become one record', async () => {
        const both = {
            balanceAt: async (b: number) => N(b >= 680 ? 19.184 : 249.284),
            timestampOf: async () => null,
        };
        const { records } = await recordsForDebitsAtOrigin([
            rec(683, T0, 19.184, 19.184, { amount: N(-230), tx_hash: 'CS1J', counterparty: 'wrap.near' }),
            rec(685, T0, 19.184, 19.184, { amount: N(-0.1), tx_hash: 'CS1J', counterparty: 'petersalomonsen.near' }),
        ], both);
        assert.equal(records.length, 1);
        assert.equal(records[0]!.block_height, 680);
        assert.equal(records[0]!.amount, N(-230.1));
        assert.equal(records[0]!.counterparty, 'wrap.near', 'named after the larger debit');
    });

    it('leaves a transfer alone when no drop of its size is within reach', async () => {
        const flat = { balanceAt: async () => N(19.284), timestampOf: async () => null };
        const { records } = await recordsForDebitsAtOrigin(afterTheFact, flat);
        assert.deepEqual(records, []);
    });
});

describe('fillNearGapsFromApi with a debit sampler', function () {
    const balances: Record<number, number> = { 676: 249.284, 677: 249.284, 678: 249.284, 679: 249.284, 680: 19.284, 681: 19.284, 682: 19.284, 683: 19.284, 684: 19.184, 685: 19.184 };
    const sampler = {
        balanceAt: async (b: number) => N(balances[b] ?? (b < 680 ? 249.284 : 19.184)),
        timestampOf: async (b: number) => BigInt(T0 + b * 1000) * 1000000n as unknown as number,
    };
    const stored = () => [
        rec(100000, T0 + 100_000_000, 19.184, 19.195, { tx_hash: 'D2ef', counterparty: 'sponsor.trezu.near' }),
        rec(667, T0 + 667_000, 249.282, 249.284, { tx_hash: 'CBM6', counterparty: 'sponsor.trezu.near' }),
    ];
    const api = async () => [
        rec(683, T0 + 683_000, 19.284, 19.284, { amount: N(-230), tx_hash: 'CS1J', counterparty: 'wrap.near' }),
        rec(685, T0 + 685_000, 19.184, 19.184, { amount: N(-0.1), tx_hash: 'CS1J', counterparty: 'petersalomonsen.near' }),
    ];

    it('closes a window the API alone could not, with the debits where they left', async () => {
        const r = await fillNearGapsFromApi('dao', stored(), api, { nowMs: T0, debitSampler: sampler });
        assert.equal(r.gaps.length, 0, 'the ledger chains');
        assert.equal(r.filled, 2);
        assert.ok(r.rpcReads > 0 && r.rpcReads <= 12, 'bounded reads: ' + r.rpcReads);
        assert.ok(r.records.some(x => x.block_height === 680 && x.amount === N(-230) && x.tx_hash === 'CS1J'));
        assert.deepEqual(r.attempts, {}, 'nothing left to wait for');
    });

    it('reads nothing without a sampler, and the window waits', async () => {
        const r = await fillNearGapsFromApi('dao', stored(), api, { nowMs: T0 });
        assert.equal(r.rpcReads, 0);
        assert.equal(r.gaps.length, 1);
        assert.equal(r.attempts['667']!.tries, 1);
    });

    it('reads nothing when the API alone closes the window', async () => {
        let reads = 0;
        const counting = { ...sampler, balanceAt: async (b: number) => { reads++; return sampler.balanceAt(b); } };
        const closes = async () => [rec(680, T0 + 680_000, 249.284, 19.284, { amount: N(-230), tx_hash: 'CS1J', counterparty: 'wrap.near' }), rec(684, T0 + 684_000, 19.284, 19.184, { amount: N(-0.1), tx_hash: 'CS1J' })];
        const r = await fillNearGapsFromApi('dao', stored(), closes, { nowMs: T0, debitSampler: counting });
        assert.equal(r.gaps.length, 0);
        assert.equal(reads, 0);
    });
});
