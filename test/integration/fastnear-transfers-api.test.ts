// Integration test against the live FastNear Transfers API.
//
// Reproduces the bug where petersalomonsen.near's daily NPRO claims were
// invisible: the credit settles two blocks after the claim transaction, outside
// the old ft_balance_of(N)/ft_balance_of(N+1) sampling window. The transfers API
// reports the transfer at its real settlement block, so it is captured.
import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load FASTNEAR_API_KEY (raises rate limits) if a .env is present.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import {
    getAccountTransferRecords,
    getAllAccountTransfers,
} from '../../scripts/fastnear-transfers-api.js';
import { detectTokenGaps } from '../../scripts/balance-tracker.js';

describe('FastNear Transfers API (live)', function () {
    this.timeout(120000);

    const ACCOUNT = 'petersalomonsen.near';
    const NPRO = 'nep141:npro.nearmobile.near';

    // Bracket the May 31 2026 claim (block 200679868) by block timestamp (ms).
    const FROM_MS = 1780128000000;
    const TO_MS = 1780300000000;
    const MAY31_BLOCK = 200679868;
    const MAY31_AMOUNT = '16311238469076383501666531';

    it('captures the May 31 NPRO claim at its real settlement block', async function () {
        const records = await getAccountTransferRecords(ACCOUNT, {
            directions: ['receiver'],
            assetId: NPRO,
            fromTimestampMs: FROM_MS,
            toTimestampMs: TO_MS,
        });

        const claim = records.find(r => r.block_height === MAY31_BLOCK);
        assert.ok(claim, `Expected an NPRO record at block ${MAY31_BLOCK}`);
        assert.equal(claim!.token_id, 'npro.nearmobile.near');
        assert.equal(claim!.amount, MAY31_AMOUNT);
        assert.equal(claim!.counterparty, 'distribution.nearmobile.near');
        // Authoritative balances from the indexer — what the old sampling missed.
        assert.equal(claim!.balance_before, '0');
        assert.equal(claim!.balance_after, MAY31_AMOUNT);
    });

    it('returns both incoming claims and outgoing intents deposits', async function () {
        const transfers = await getAllAccountTransfers(ACCOUNT, {
            directions: ['receiver', 'sender'],
            assetId: NPRO,
            fromTimestampMs: FROM_MS,
            toTimestampMs: TO_MS,
        });

        assert.ok(transfers.length > 0, 'Expected NPRO transfers in the window');
        const incoming = transfers.filter(t => BigInt(t.amount) > 0n);
        const outgoing = transfers.filter(t => BigInt(t.amount) < 0n);
        assert.ok(incoming.length > 0, 'Expected incoming claim transfers');
        assert.ok(outgoing.length > 0, 'Expected outgoing intents-deposit transfers');

        // Results are newest-first.
        for (let i = 0; i < transfers.length - 1; i++) {
            assert.ok(
                Number(transfers[i]!.block_height) >= Number(transfers[i + 1]!.block_height),
                'Transfers should be sorted descending by block height'
            );
        }
    });

    it('produces NPRO records whose per-token balances are internally continuous', async function () {
        // Pull a wider window so consecutive claims chain together, then assert
        // that balance_after of one record equals balance_before of the next.
        // Any discontinuity here is precisely the signal the worker would use to
        // fall back to balance sampling.
        const records = await getAccountTransferRecords(ACCOUNT, {
            assetId: NPRO,
            fromTimestampMs: FROM_MS,
            toTimestampMs: TO_MS,
        });

        const npro = records.filter(r => r.token_id === 'npro.nearmobile.near');
        assert.ok(npro.length >= 2, 'Need at least two NPRO records to check continuity');

        const gaps = detectTokenGaps(npro);
        assert.deepEqual(
            gaps,
            [],
            `Expected no balance discontinuities in transfers-derived NPRO records, got: ${JSON.stringify(gaps)}`
        );
    });

    it('captures NEAR Intents NPRO deposits as a continuous nep141: ledger', async function () {
        // The intents side (asset_type "Mt") carries the deposits into NEAR
        // Intents that the legacy path dropped. They must map to the canonical
        // nep141:<contract> token_id and form a continuous, deposit-bearing ledger.
        const records = await getAccountTransferRecords(ACCOUNT, {
            assetId: 'nep245:intents.near:nep141:npro.nearmobile.near',
            fromTimestampMs: FROM_MS,
            toTimestampMs: TO_MS,
        });

        const intents = records.filter(r => r.token_id === 'nep141:npro.nearmobile.near');
        assert.ok(intents.length >= 2, 'Expected intents NPRO records mapped to nep141: form');

        const deposits = intents.filter(r => BigInt(r.amount) > 0n);
        assert.ok(deposits.length > 0, 'Expected at least one intents NPRO deposit');

        assert.deepEqual(
            detectTokenGaps(intents),
            [],
            'Intents NPRO ledger from the API should be internally continuous'
        );
    });
});
