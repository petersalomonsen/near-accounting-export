import { describe, it } from 'mocha';
import assert from 'assert';
import {
    assetIdToTokenId,
    mapTransferToRecord,
    reconcileTransferGaps,
    type FastNearTransfer,
} from '../../scripts/fastnear-transfers-api.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

// Real /v0/transfers row for petersalomonsen.near's May 31 2026 NPRO claim.
// The credit settles at block 200679868 (the claim tx is at 200679866), which
// is exactly the N+2 block the old ft_balance_of(N), ft_balance_of(N+1)
// sampling window missed — so this transfer used to be dropped entirely.
const MAY31_CLAIM: FastNearTransfer = {
    account_id: 'petersalomonsen.near',
    action_index: 0,
    amount: '16311238469076383501666531',
    asset_id: 'nep141:npro.nearmobile.near',
    asset_type: 'Ft',
    block_height: '200679868',
    block_timestamp: '1780215236717334127',
    end_of_block_balance: '16311238469076383501666531',
    human_amount: 16.31123846907638,
    log_index: 0,
    method_name: 'ft_transfer',
    other_account_id: 'distribution.nearmobile.near',
    predecessor_id: 'distribution.nearmobile.near',
    receipt_account_id: 'npro.nearmobile.near',
    receipt_id: 'HBy5oeWwt1h3UbuTK5UpMdV1zqMTuL6an5G7oGJw9Gkv',
    signer_id: 'petersalomonsen.near',
    start_of_block_balance: '0',
    transaction_id: 'N6WWnfDwAgChadqY2bmvV2jwcLjLrvm2e38M4NWTWbE',
    transfer_index: 0,
};

describe('assetIdToTokenId', function () {
    it('maps native NEAR to "near"', () => {
        assert.equal(assetIdToTokenId('native:near'), 'near');
        assert.equal(assetIdToTokenId('anything', 'Native'), 'near');
    });

    it('strips the nep141: prefix to the bare FT contract id', () => {
        assert.equal(
            assetIdToTokenId('nep141:npro.nearmobile.near', 'Ft'),
            'npro.nearmobile.near'
        );
        assert.equal(
            assetIdToTokenId('nep141:usdt.tether-token.near', 'Ft'),
            'usdt.tether-token.near'
        );
    });

    it('maps intents (Mt) multi-token ids to the canonical nep141: form', () => {
        assert.equal(
            assetIdToTokenId('nep245:intents.near:nep141:npro.nearmobile.near', 'Mt'),
            'nep141:npro.nearmobile.near'
        );
        assert.equal(
            assetIdToTokenId('nep245:intents.near:nep141:wrap.near', 'Mt'),
            'nep141:wrap.near'
        );
    });
});

describe('mapTransferToRecord', function () {
    it('maps a claim transfer to a BalanceChangeRecord using authoritative balances', () => {
        const record = mapTransferToRecord(MAY31_CLAIM);

        // The record is placed at the real settlement block, not the tx block.
        assert.equal(record.block_height, 200679868);
        assert.equal(record.block_timestamp, '2026-05-31T08:13:56.717Z');

        // FT token_id is the bare contract id (matches existing V2 records).
        assert.equal(record.token_id, 'npro.nearmobile.near');

        // Amount and balances come straight from the indexer — no sampling.
        assert.equal(record.amount, '16311238469076383501666531');
        assert.equal(record.balance_before, '0');
        assert.equal(record.balance_after, '16311238469076383501666531');

        // Provenance.
        assert.equal(record.counterparty, 'distribution.nearmobile.near');
        assert.equal(record.tx_hash, 'N6WWnfDwAgChadqY2bmvV2jwcLjLrvm2e38M4NWTWbE');
        assert.equal(record.receipt_id, 'HBy5oeWwt1h3UbuTK5UpMdV1zqMTuL6an5G7oGJw9Gkv');
        assert.equal(record.signer_id, 'petersalomonsen.near');
        assert.equal(record.receiver_id, 'npro.nearmobile.near');
        assert.equal(record.predecessor_id, 'distribution.nearmobile.near');
    });

    it('reconciles a continuous chain without invoking the sampler', async () => {
        const claim = mapTransferToRecord(MAY31_CLAIM);
        const deposit = mapTransferToRecord({
            ...MAY31_CLAIM,
            block_height: '200679927',
            amount: '-16311238469076383501666531',
            method_name: 'ft_transfer_call',
            other_account_id: 'intents.near',
            start_of_block_balance: '16311238469076383501666531',
            end_of_block_balance: '0',
        });

        let sampled = false;
        const result = await reconcileTransferGaps([claim, deposit], async () => {
            sampled = true;
            return [];
        });

        assert.equal(sampled, false, 'continuous records must not trigger sampling');
        assert.deepEqual(result.gaps, []);
        assert.equal(result.filled.length, 0);
    });

    it('falls back to the sampler for a real discontinuity and merges the result', async () => {
        // balance_after of the first record (0) != balance_before of the second
        // (50): a transfer is missing between blocks 100 and 200.
        const before: BalanceChangeRecord = {
            block_height: 100,
            block_timestamp: null,
            tx_hash: null,
            tx_block: null,
            signer_id: null,
            receiver_id: null,
            predecessor_id: null,
            token_id: 'token.near',
            receipt_id: null,
            counterparty: null,
            amount: '0',
            balance_before: '0',
            balance_after: '0',
        };
        const after: BalanceChangeRecord = { ...before, block_height: 200, balance_before: '50', balance_after: '50' };

        const recovered: BalanceChangeRecord = { ...before, block_height: 150, amount: '50', balance_before: '0', balance_after: '50' };

        const result = await reconcileTransferGaps([before, after], async (gap) => {
            assert.equal(gap.token_id, 'token.near');
            assert.equal(gap.from_block, 100);
            assert.equal(gap.to_block, 200);
            return [recovered];
        });

        assert.equal(result.gaps.length, 1);
        assert.equal(result.filled.length, 1);
        // Merged + sorted newest-first.
        assert.deepEqual(result.records.map(r => r.block_height), [200, 150, 100]);
    });

    it('preserves the sign for outgoing transfers', () => {
        const outgoing: FastNearTransfer = {
            ...MAY31_CLAIM,
            amount: '-16311238469076383501666531',
            method_name: 'ft_transfer_call',
            other_account_id: 'intents.near',
            start_of_block_balance: '16311238469076383501666531',
            end_of_block_balance: '0',
        };
        const record = mapTransferToRecord(outgoing);
        assert.equal(record.amount, '-16311238469076383501666531');
        assert.equal(record.counterparty, 'intents.near');
        assert.equal(record.balance_before, '16311238469076383501666531');
        assert.equal(record.balance_after, '0');
    });
});
