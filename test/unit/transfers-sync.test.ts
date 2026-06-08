import { describe, it } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    isFtToken,
    isIntentsToken,
    isTransfersOwned,
    latestOwnedBlock,
    mergeFtTransferRecords,
    syntheticGapSampler,
    syncFtTransfersForAccount,
} from '../../scripts/transfers-sync.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

function rec(partial: Partial<BalanceChangeRecord> & { token_id: string; block_height: number }): BalanceChangeRecord {
    return {
        // Real records carry a timestamp; tests that want a synthetic record set it null.
        block_timestamp: '2026-01-01T00:00:00.000Z',
        tx_hash: 'tx',
        tx_block: null,
        signer_id: null,
        receiver_id: null,
        predecessor_id: null,
        receipt_id: null,
        counterparty: null,
        amount: '0',
        balance_before: '0',
        balance_after: '0',
        ...partial,
    };
}

describe('token classification', function () {
    it('isFtToken: plain FT contracts only', () => {
        assert.equal(isFtToken('npro.nearmobile.near'), true);
        assert.equal(isFtToken('usdt.tether-token.near'), true);
        assert.equal(isFtToken('near'), false);
        assert.equal(isFtToken('nep141:npro.nearmobile.near'), false); // intents
        assert.equal(isFtToken('npro.poolv1.near'), false);            // staking pool
    });

    it('isIntentsToken: nep141:/nep245:intents.near: ids', () => {
        assert.equal(isIntentsToken('nep141:npro.nearmobile.near'), true);
        assert.equal(isIntentsToken('nep245:intents.near:nep141:wrap.near'), true);
        assert.equal(isIntentsToken('npro.nearmobile.near'), false);
        assert.equal(isIntentsToken('near'), false);
    });

    it('isTransfersOwned: FT + intents, not NEAR / staking', () => {
        assert.equal(isTransfersOwned('npro.nearmobile.near'), true);       // FT
        assert.equal(isTransfersOwned('nep141:npro.nearmobile.near'), true); // intents
        assert.equal(isTransfersOwned('nep245:intents.near:nep141:wrap.near'), true);
        assert.equal(isTransfersOwned('near'), false);
        assert.equal(isTransfersOwned('binancenode1.poolv1.near'), false);
    });
});

describe('latestOwnedBlock', function () {
    it('returns the max block among owned (FT + intents) records', () => {
        const records = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 100 }),
            rec({ token_id: 'near', block_height: 999 }),               // ignored
            rec({ token_id: 'npro.poolv1.near', block_height: 888 }),   // ignored (staking)
            rec({ token_id: 'nep141:npro.nearmobile.near', block_height: 300 }), // intents counted
        ];
        assert.equal(latestOwnedBlock(records), 300);
        assert.equal(latestOwnedBlock([]), 0);
    });
});

describe('mergeFtTransferRecords', function () {
    it('appends new owned records and leaves NEAR/staking untouched', async () => {
        const existing = [
            rec({ token_id: 'near', block_height: 50, amount: '-1' }),
            rec({ token_id: 'nep141:npro.nearmobile.near', block_height: 60 }), // intents (owned)
            rec({ token_id: 'binancenode1.poolv1.near', block_height: 70 }),    // staking (not owned)
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'A', amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const fetched = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 200, receipt_id: 'B', amount: '5', balance_before: '10', balance_after: '15' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched);
        assert.equal(result.fetched, 1);
        assert.equal(result.gaps.length, 0);
        assert.equal(result.records.length, 5);
        assert.ok(result.records.some(r => r.token_id === 'near'));                       // NEAR untouched
        assert.ok(result.records.some(r => r.token_id === 'nep141:npro.nearmobile.near')); // intents preserved
        assert.ok(result.records.some(r => r.token_id === 'binancenode1.poolv1.near'));   // staking untouched
        assert.deepEqual(result.records.map(r => r.block_height), [200, 100, 70, 60, 50]);
    });

    it('adds a missing INTENTS deposit (the user-reported gap)', async () => {
        // Production shape: the intents withdrawal/swap was recorded (balance
        // jumps to a full amount from dust) but the deposit that funded it was
        // dropped — a per-token discontinuity. The transfers API supplies the
        // missing ft_on_transfer deposit, restoring continuity.
        const existing = [
            rec({ token_id: 'nep141:npro.nearmobile.near', block_height: 500, receipt_id: 'SWAP', amount: '-24', balance_before: '24', balance_after: '0' }),
        ];
        const fetched = [
            rec({ token_id: 'nep141:npro.nearmobile.near', block_height: 480, receipt_id: 'DEPOSIT', amount: '24', balance_before: '0', balance_after: '24' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched);
        const intents = result.records.filter(r => r.token_id === 'nep141:npro.nearmobile.near');
        assert.equal(result.fetched, 1, 'intents transfer is owned and ingested');
        assert.equal(intents.length, 2, 'deposit added alongside the existing swap');
        assert.equal(result.gaps.length, 0, 'deposit restores intents continuity');
    });

    it('keeps the existing record on a receipt collision (existing-wins, no duplicate)', async () => {
        // Incremental merge: a transfer the balance-change tracker already
        // recorded must not be duplicated by the same transfer from the API.
        // Existing-wins preserves the tracker's record (and its mint/burn context
        // for non-transfer events) rather than overwriting it.
        const existing = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'R1', amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const fetched = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 102, receipt_id: 'R1', amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched);
        const npro = result.records.filter(r => r.token_id === 'npro.nearmobile.near');
        assert.equal(npro.length, 1, 'same receipt must not be duplicated');
        assert.equal(npro[0]!.block_height, 100, 'existing record is preserved');
    });

    it('adds a missing transfer the tracker never recorded (no receipt collision)', async () => {
        const existing = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 300, receipt_id: 'DEPOSIT', amount: '-10', balance_before: '10', balance_after: '0' }),
        ];
        // The claim that produced the balance the deposit spends was dropped by
        // the tracker; the transfers API supplies it.
        const fetched = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 250, receipt_id: 'CLAIM', amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched);
        const npro = result.records.filter(r => r.token_id === 'npro.nearmobile.near');
        assert.equal(npro.length, 2, 'missing claim should be added alongside the existing deposit');
        assert.equal(result.gaps.length, 0, 'added claim restores continuity');
    });

    it('reconciles a real discontinuity when a sampler is provided (opt-in)', async () => {
        const existing: BalanceChangeRecord[] = [];
        const fetched = [
            rec({ token_id: 'tkn.near', block_height: 100, receipt_id: 'A', amount: '10', balance_before: '0', balance_after: '10' }),
            // jump: balance_before 50 != previous balance_after 10 -> missing transfer
            rec({ token_id: 'tkn.near', block_height: 200, receipt_id: 'B', amount: '5', balance_before: '50', balance_after: '55' }),
        ];
        // Without a sampler, gaps are reported but not filled.
        const noFill = await mergeFtTransferRecords(existing, fetched);
        assert.equal(noFill.gaps.length, 1);
        assert.equal(noFill.filled, 0);
        // Opt in to the synthetic sampler.
        const result = await mergeFtTransferRecords(existing, fetched, { sampler: syntheticGapSampler });
        assert.equal(result.gaps.length, 1);
        assert.equal(result.filled, 1);
        const synthetic = result.records.find(r => r.amount === '40');
        assert.ok(synthetic, 'expected a synthetic reconciling record for the +40 gap');
        assert.equal(synthetic!.balance_before, '10');
        assert.equal(synthetic!.balance_after, '50');
    });

    it('backfill: adopts a clean API ledger per token, keeps NEAR untouched', async () => {
        const existing = [
            // stale/incomplete existing FT records for tkn.near (will be replaced)
            rec({ token_id: 'tkn.near', block_height: 1, receipt_id: 'OLD', amount: '1', balance_before: '0', balance_after: '1' }),
            rec({ token_id: 'near', block_height: 2, amount: '-1' }),
        ];
        const fetched = [
            rec({ token_id: 'tkn.near', block_height: 100, receipt_id: 'A', amount: '10', balance_before: '0', balance_after: '10' }),
            rec({ token_id: 'tkn.near', block_height: 200, receipt_id: 'B', amount: '5', balance_before: '10', balance_after: '15' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched, { backfill: true });
        const tkn = result.records.filter(r => r.token_id === 'tkn.near');
        assert.equal(tkn.length, 2, 'clean API ledger replaces the stale existing records');
        assert.ok(!result.records.some(r => r.receipt_id === 'OLD'), 'stale record dropped');
        assert.ok(result.records.some(r => r.token_id === 'near'), 'NEAR untouched');
        assert.equal(result.gaps.length, 0);
    });

    it('backfill: adopts API transfers and fills a block-level gap from existing (mint/burn)', async () => {
        // API has two transfers but its block-level balance jumps 10 -> 50 between
        // them: a non-transfer mint the API can't represent. The balance-tracker
        // sampled it (MINT at block 200); backfill keeps that record to bridge the
        // gap, while a stale pre-history record (OLD) is dropped.
        const existing = [
            rec({ token_id: 'tkn.near', block_height: 1, receipt_id: 'OLD', amount: '1', balance_before: '0', balance_after: '1' }),
            rec({ token_id: 'tkn.near', block_height: 200, receipt_id: null, tx_hash: 'mintTx', amount: '40', balance_before: '10', balance_after: '50' }),
        ];
        const fetched = [
            rec({ token_id: 'tkn.near', block_height: 100, receipt_id: 'A', amount: '10', balance_before: '0', balance_after: '10' }),
            rec({ token_id: 'tkn.near', block_height: 300, receipt_id: 'B', amount: '-50', balance_before: '50', balance_after: '0' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched, { backfill: true });
        const tkn = result.records.filter(r => r.token_id === 'tkn.near').sort((a, b) => a.block_height - b.block_height);
        assert.deepEqual(tkn.map(r => r.block_height), [100, 200, 300], 'API transfers + the bridging mint, no stale OLD record');
        assert.equal(result.gaps.length, 0, 'block gap filled from the existing mint record');
    });

    it('backfill: a clean API token does not pull in stale existing records', async () => {
        const existing = [
            rec({ token_id: 'tkn.near', block_height: 1, receipt_id: 'STALE', amount: '1', balance_before: '0', balance_after: '1' }),
        ];
        const fetched = [
            rec({ token_id: 'tkn.near', block_height: 100, receipt_id: 'A', amount: '10', balance_before: '0', balance_after: '10' }),
            rec({ token_id: 'tkn.near', block_height: 200, receipt_id: 'B', amount: '5', balance_before: '10', balance_after: '15' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched, { backfill: true });
        assert.ok(!result.records.some(r => r.receipt_id === 'STALE'), 'no gap -> stale record not re-added');
        assert.equal(result.gaps.length, 0);
    });
});

describe('syntheticGapSampler', function () {
    it('produces a record bridging the known balances', async () => {
        const out = await syntheticGapSampler({
            token_id: 't.near', from_block: 100, to_block: 200,
            expected_balance: '10', actual_balance: '50', diff: '40',
        });
        assert.equal(out.length, 1);
        assert.equal(out[0]!.amount, '40');
        assert.equal(out[0]!.balance_before, '10');
        assert.equal(out[0]!.balance_after, '50');
        assert.equal(out[0]!.block_height, 101);
    });
});

describe('syncFtTransfersForAccount', function () {
    it('does a one-time full backfill on a pre-backfill file, then marks it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-'));
        const file = path.join(dir, 'acct.json');
        // No ftBackfillVersion -> legacy file written by the old sampling path.
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'STALE', amount: '10', balance_after: '10' }),
                rec({ token_id: 'near', block_height: 90, amount: '-1' }),
            ],
            metadata: { firstBlock: 90, lastBlock: 100, totalRecords: 2 },
        }, null, 2));

        let calledAfter: number | undefined = -1;
        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-06-07T00:00:00.000Z',
            fetchRecords: async (_acct, options) => {
                calledAfter = options.afterBlock;
                return [
                    rec({ token_id: 'npro.nearmobile.near', block_height: 200, receipt_id: 'REAL', amount: '20', balance_after: '20' }),
                ];
            },
        });

        assert.equal(calledAfter, undefined, 'backfill should fetch the full history (no afterBlock)');
        assert.equal(result.backfilled, true);
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        // Stale FT record replaced by authoritative set; NEAR preserved.
        assert.ok(!written.records.some((r: any) => r.receipt_id === 'STALE'), 'stale FT record dropped');
        assert.ok(written.records.some((r: any) => r.receipt_id === 'REAL'));
        assert.ok(written.records.some((r: any) => r.token_id === 'near'));
        assert.equal(written.metadata.ftBackfillVersion, 5);

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('syncs incrementally once already backfilled', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'A', amount: '10', balance_after: '10' }),
            ],
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 1, ftBackfillVersion: 5 },
        }, null, 2));

        let calledAfter: number | undefined = -1;
        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-06-07T00:00:00.000Z',
            fetchRecords: async (_acct, options) => {
                calledAfter = options.afterBlock;
                return [rec({ token_id: 'npro.nearmobile.near', block_height: 200, receipt_id: 'B', amount: '5', balance_before: '10', balance_after: '15' })];
            },
        });

        assert.equal(calledAfter, 100, 'should fetch incrementally after the latest FT block');
        assert.equal(result.backfilled, false);
        assert.equal(result.changed, true);
        assert.equal(result.fetched, 1);

        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.equal(written.records.length, 2);
        assert.equal(written.metadata.lastBlock, 200);
        assert.equal(written.metadata.totalRecords, 2);
        assert.equal(written.updatedAt, '2026-06-07T00:00:00.000Z');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('skips non-V2 files without throwing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-'));
        const file = path.join(dir, 'v1.json');
        fs.writeFileSync(file, JSON.stringify({ accountId: 'a', transactions: [] }));
        const result = await syncFtTransfersForAccount('a', file, { fetchRecords: async () => { throw new Error('should not fetch'); } });
        assert.equal(result.changed, false);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
