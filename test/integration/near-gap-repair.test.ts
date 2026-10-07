import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import { fillNearGapsFromApi, nearGapWindows, rpcDebitSampler } from '../../scripts/transfers-sync.js';
import { getAccountTransferRecords } from '../../scripts/fastnear-transfers-api.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

/**
 * The real records the gateway stored for petersalomonsen.near around the
 * npro.poolv1.near withdrawal on 2026-09-28, exactly as they were: the unstake
 * transaction booked as a 0.176 NEAR debit at block 217641382, and the next
 * NEAR record starting 1 200 higher than that one ended. The data alone says a
 * transfer is missing between 14:01:21 and 14:04:45; only that stretch is
 * fetched, and the payout from the pool is what comes back.
 */
const stored: BalanceChangeRecord[] = [
    { block_height: 217641727, block_timestamp: '2026-09-28T14:04:47.447Z', tx_hash: 'AqrfpoHb7ujDpM8tPhbs9eAFQodD4sxHBT6bjCXvXwmb', tx_block: null, signer_id: null, receiver_id: 'petersalomonsen.near', predecessor_id: 'system', token_id: 'near', receipt_id: 'DKD8owLAnn9ycGYYfCpvB9968d49Dc7HeKyJkDcUyswJ', counterparty: 'system', amount: '5752169753939000000000', balance_before: '33474471646984232305794822', balance_after: '33480223816738171305794822' },
    { block_height: 217641723, block_timestamp: '2026-09-28T14:04:45.020Z', tx_hash: 'AqrfpoHb7ujDpM8tPhbs9eAFQodD4sxHBT6bjCXvXwmb', tx_block: null, signer_id: null, receiver_id: 'wrap.near', predecessor_id: 'petersalomonsen.near', token_id: 'near', receipt_id: 'F7yJjm1Z2GVshNjGAb5VEXVTfhfQoGfgViBMKqQ39o7c', counterparty: 'wrap.near', amount: '-1200081781628919299500000001', balance_before: '1233481198899965579805794823', balance_after: '33399417271046280305794822' },
    { block_height: 217641382, block_timestamp: '2026-09-28T14:01:21.506Z', tx_hash: 'JDaZfdNRyx3fRJzB3Lq6i3rHofbzM4VGYvWt6KDsfCfq', tx_block: null, signer_id: null, receiver_id: 'petersalomonsen.near', predecessor_id: 'npro.poolv1.near', token_id: 'near', receipt_id: '2J848HWKfkMPjps63ebeNANAJp5dBFPT5tJU2TodMMq2', counterparty: 'npro.poolv1.near', amount: '-175919208660969500000000', balance_before: '33481463213303192705794823', balance_after: '33305544004642223205794823' },
];

describe('NEAR gap repair from the transfers API', function () {
    this.timeout(120000);

    it('finds the gap in the data, with the window the payout must lie in', () => {
        const windows = nearGapWindows(stored);
        // Two gaps three minutes apart — the big one, and the 0.075 of refunds
        // between the wrap and its last speck — make one short window.
        assert.equal(windows.length, 1);
        const [w] = windows;
        assert.equal(w!.gaps, 2);
        assert.equal(w!.fromBlock, 217641382);
        assert.equal(w!.toBlock, 217641727);
        assert.ok(w!.weight > 1200n * 10n ** 24n);
    });

    it('fetches only those windows and recovers the 1200 NEAR from the pool', async () => {
        const asked: number[] = [];
        const result = await fillNearGapsFromApi('petersalomonsen.near', stored, async (acct, o) => {
            asked.push((o.toTimestampMs! - o.fromTimestampMs!) / 1000);
            return getAccountTransferRecords(acct, o);
        });
        assert.equal(result.requests, 1);
        assert.ok(asked.every(s => s < 300), `the window is a few minutes, not the history: ${asked.join(', ')}s`);

        const payout = result.records.find(r => r.token_id === 'near' && r.counterparty === 'npro.poolv1.near' && r.amount === '1200000000000000000000000000');
        assert.ok(payout, 'the payout record is adopted');
        assert.equal(payout!.block_height, 217641384);
        assert.equal(payout!.tx_hash, 'JDaZfdNRyx3fRJzB3Lq6i3rHofbzM4VGYvWt6KDsfCfq');
        // End of its own block: the last 0.0002 refund lands a block later and
        // is its own record, which is what makes the ledger chain below.
        assert.equal(payout!.balance_after, '1233480998035659329805794823');
        assert.ok(!result.records.some(r => r.block_height === 217641724), 'the wrap NEAR reported again at its receipt block is not adopted');
        assert.equal(result.gaps.length, 0, 'the ledger chains afterwards');
    });
});

/**
 * The treasury DAO, 2026-09-25: a proposal wrapped 230 NEAR and sent the
 * wNEAR to a 1Click address (tx CS1JFNK3Zj...). The NEAR left at block
 * 217201682, when the outgoing receipt was created; the transfers API reports
 * it at 217201683 with balances that already exclude it. Neither the tracker
 * nor the API-only fill ever recorded it: the stored ledger went from 249.284
 * after the last sponsor credit on 09-25 to 19.184 before the next one on
 * 09-26, with nothing in between.
 */
describe('A debit the transfers API reports after the fact', function () {
    this.timeout(120000);
    const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
    const stored: BalanceChangeRecord[] = [
        { block_height: 217302803, block_timestamp: '2026-09-26T06:23:00.000Z', tx_hash: 'D2efn7zs', tx_block: null, signer_id: null, receiver_id: accountId, predecessor_id: 'sponsor.trezu.near', token_id: 'near', receipt_id: null, counterparty: 'sponsor.trezu.near', amount: '11300000000000000000000', balance_before: '19184107391108925560899999958', balance_after: '19195407391108925560899999958' },
        { block_height: 217201667, block_timestamp: '2026-09-25T13:43:00.000Z', tx_hash: 'CBM6zCqm', tx_block: null, signer_id: null, receiver_id: accountId, predecessor_id: 'sponsor.trezu.near', token_id: 'near', receipt_id: null, counterparty: 'sponsor.trezu.near', amount: '1300000000000000000000', balance_before: '249282981997800000000000000', balance_after: '249284281997800000000000000' },
    ];

    it('finds where the 230 NEAR left and closes the gap for a few reads', async function () {
        // Balances are read from the chain; the exact yocto values are asserted
        // against the record the sampler writes, so first read them.
        const sampler = rpcDebitSampler(accountId);
        const before = await sampler.balanceAt(217201681);
        const after = await sampler.balanceAt(217201682);
        const drop = BigInt(before) - BigInt(after);
        // 230 NEAR less the gas charged in the same block.
        assert.ok(drop > 229_99n * 10n ** 22n && drop <= 230n * 10n ** 24n, 'the chain shows 230 NEAR leaving at 217201682, got ' + drop);

        // Make the stored neighbours exact, as the real ledger's are: the last
        // credit of 09-25 ends at the balance before the debit, the first credit
        // of 09-26 starts at the balance before it.
        stored[1]!.balance_after = before;
        const beforeCredit = await sampler.balanceAt(217302802);
        stored[0]!.balance_before = beforeCredit;
        stored[0]!.balance_after = (BigInt(beforeCredit) + BigInt(stored[0]!.amount)).toString();
        const { records: out, gaps, rpcReads, requests } = await fillNearGapsFromApi(accountId, stored, getAccountTransferRecords, { nowMs: Date.now(), debitSampler: sampler });
        assert.equal(requests, 1);
        assert.ok(rpcReads > 0 && rpcReads <= 16, 'a handful of reads: ' + rpcReads);
        const debit = out.find(r => r.block_height === 217201682 && r.token_id === 'near');
        assert.ok(debit, 'the outflow is recorded at the block it left in');
        assert.equal(debit!.balance_before, before);
        assert.equal(debit!.balance_after, after);
        assert.ok(debit!.tx_hash!.startsWith('CS1JFNK3'));
        assert.equal(debit!.counterparty, 'wrap.near');
        assert.equal(gaps.length, 0, 'the ledger chains afterwards');
    });
});
