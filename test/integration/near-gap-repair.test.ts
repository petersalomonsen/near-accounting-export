import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import { fillNearGapsFromApi, nearGapWindows } from '../../scripts/transfers-sync.js';
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
