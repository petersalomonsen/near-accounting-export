import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import { checkPoolRecordsAgainstChain, rpcPoolBalanceReader } from '../../scripts/staking-truth.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

/**
 * petersalomonsen.near on npro.poolv1.near, 2026-09-28, exactly as the gateway
 * stored it: the withdrawal of 1 200 NEAR at block 217641382 (12 000 → 10 800)
 * and, one block later, a record saying 10 800 → 12 000 — which the pool never
 * did. Read downstream, that second record was 1 200 NEAR of staking income.
 */
describe('Pool records against the live pool contract', function () {
    this.timeout(120000);
    const POOL = 'npro.poolv1.near';
    const stored: BalanceChangeRecord[] = [
        { block_height: 217641600, block_timestamp: '2026-09-28T14:03:30.340Z', tx_hash: null, tx_block: null, signer_id: null, receiver_id: null, predecessor_id: null, token_id: POOL, receipt_id: null, counterparty: POOL, amount: '0', balance_before: '10800000000000000000000000000', balance_after: '10800000000000000000000000000' },
        { block_height: 217641383, block_timestamp: '2026-09-28T14:01:22.019Z', tx_hash: null, tx_block: null, signer_id: null, receiver_id: null, predecessor_id: null, token_id: POOL, receipt_id: null, counterparty: POOL, amount: '1200000000000000000000000000', balance_before: '10800000000000000000000000000', balance_after: '12000000000000000000000000000' },
        { block_height: 217641382, block_timestamp: '2026-09-28T14:01:21.506Z', tx_hash: null, tx_block: null, signer_id: null, receiver_id: null, predecessor_id: null, token_id: POOL, receipt_id: null, counterparty: POOL, amount: '-1200000000000000000000000000', balance_before: '12000000000000000000000000000', balance_after: '10800000000000000000000000000' },
        { block_height: 217641382, block_timestamp: '2026-09-28T14:01:21.506Z', tx_hash: 'JDaZfdNRyx3fRJzB3Lq6i3rHofbzM4VGYvWt6KDsfCfq', tx_block: null, signer_id: null, receiver_id: 'petersalomonsen.near', predecessor_id: POOL, token_id: 'near', receipt_id: '2J848HWKfkMPjps63ebeNANAJp5dBFPT5tJU2TodMMq2', counterparty: POOL, amount: '-175919208660969500000000', balance_before: '33481463213303192705794823', balance_after: '33305544004642223205794823' },
    ];

    it('drops the 10 800 -> 12 000 record and keeps the withdrawal', async function () {
        const r = await checkPoolRecordsAgainstChain(stored, rpcPoolBalanceReader('petersalomonsen.near'));
        assert.equal(r.checked, 2);
        assert.deepEqual(r.removed.map(x => x.block_height), [217641383]);
        assert.ok(r.records.some(x => x.token_id === POOL && x.block_height === 217641382));
        assert.equal(r.records.length, 3);
        assert.ok(r.reads <= 6, 'reads: ' + r.reads);
    });
});
