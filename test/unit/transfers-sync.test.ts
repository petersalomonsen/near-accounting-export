import { describe, it } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    fillOwnedGapsFromApi,
    isFtToken,
    isIntentsToken,
    isTransfersOwned,
    latestSyncedBlock,
    mergeFtTransferRecords,
    reconcileFtTailBalances,
    syntheticGapSampler,
    syncFtTransfersForAccount,
    tokenIdToAssetId,
    type BalanceProbe,
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

describe('latestSyncedBlock', function () {
    it('ignores reconciliation records (they carry the probe block, not a fetched transfer)', () => {
        const records = [
            rec({ token_id: 'token.near', block_height: 100 }),
            { ...rec({ token_id: 'token.near', block_height: 999 }), reconciled: true },
        ];
        assert.equal(latestSyncedBlock(records), 100);
    });

    it('returns the max block among FT + intents + NEAR (not staking)', () => {
        const records = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 100 }),       // FT
            rec({ token_id: 'nep141:npro.nearmobile.near', block_height: 300 }), // intents
            rec({ token_id: 'near', block_height: 500 }),                       // NEAR counted now
            rec({ token_id: 'npro.poolv1.near', block_height: 888 }),           // staking ignored
        ];
        assert.equal(latestSyncedBlock(records), 500);
        assert.equal(latestSyncedBlock([]), 0);
    });

    it('uses NEAR when there are no owned tokens (avoids full re-fetch each cycle)', () => {
        const records = [rec({ token_id: 'near', block_height: 777 })];
        assert.equal(latestSyncedBlock(records), 777);
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

    it('fills a NEAR gap with an API native:near transfer the tracker dropped', async () => {
        // The balance-tracker's NEAR ledger jumps 100 -> 300 between two records:
        // a cross-contract NEAR transfer (DAO/treasury) it missed. The API has it;
        // keep the tracker's NEAR records and add the missing transfer in the gap.
        const existing = [
            rec({ token_id: 'near', block_height: 100, amount: '-1', balance_before: '101', balance_after: '100' }),
            rec({ token_id: 'near', block_height: 300, amount: '-1', balance_before: '300', balance_after: '299' }),
        ];
        const fetched = [
            rec({ token_id: 'near', block_height: 200, receipt_id: 'DAO', amount: '200', balance_before: '100', balance_after: '300', counterparty: 'treasury.sputnik-dao.near' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched, { backfill: true });
        const near = result.records.filter(r => r.token_id === 'near').sort((a, b) => a.block_height - b.block_height);
        assert.equal(near.length, 3, 'missing NEAR transfer added between the tracker records');
        assert.equal(near[1]!.receipt_id, 'DAO');
        assert.equal(result.fetched, 0, 'NEAR is not counted as an owned fetch');
    });

    it('does not add an API NEAR transfer where the tracker has no gap', async () => {
        const existing = [
            rec({ token_id: 'near', block_height: 100, amount: '-1', balance_before: '101', balance_after: '100' }),
            rec({ token_id: 'near', block_height: 300, amount: '-1', balance_before: '100', balance_after: '99' }),
        ];
        const fetched = [
            rec({ token_id: 'near', block_height: 200, receipt_id: 'DUP', amount: '0', balance_before: '100', balance_after: '100' }),
        ];
        const result = await mergeFtTransferRecords(existing, fetched, { backfill: true });
        assert.ok(!result.records.some(r => r.receipt_id === 'DUP'), 'no gap -> no NEAR fill (no double-count)');
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
        assert.equal(written.metadata.ftBackfillVersion, 6);

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
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 1, ftBackfillVersion: 6 },
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

describe('reconcileFtTailBalances', function () {
    // Probe that returns a fixed on-chain balance per token; records the calls.
    const probeOf = (balances: Record<string, string | null>, calls?: string[]): BalanceProbe =>
        async (tokenId) => { calls?.push(tokenId); return balances[tokenId] ?? null; };

    it('synthesizes a correcting record for a burned tail (the stNEAR case)', async () => {
        // Last transfer left 287 stNEAR; on-chain it's now 0 (redeemed via meta-pool
        // — a burn, no ft_transfer, so no later record and detectTokenGaps is blind).
        const records = [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_before: '0', balance_after: '287' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: probeOf({ 'meta-pool.near': '0' }),
            block: 500,
            timestamp: '2026-07-21T00:00:00.000Z',
        });
        assert.equal(res.modified, true);
        assert.equal(res.reconciled, 1);
        const fix = res.records.find(r => r.reconciled);
        assert.ok(fix, 'a reconciliation record was added');
        assert.equal(fix!.token_id, 'meta-pool.near');
        assert.equal(fix!.balance_before, '287');
        assert.equal(fix!.balance_after, '0');
        assert.equal(fix!.amount, '-287');
        assert.equal(fix!.block_height, 500);
        assert.equal(fix!.tx_hash, null);
        assert.equal(fix!.block_timestamp, '2026-07-21T00:00:00.000Z');
    });

    it('does nothing when the tail already matches chain', async () => {
        const records = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, amount: '10', balance_after: '10' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: probeOf({ 'npro.nearmobile.near': '10' }),
            block: 500, timestamp: 't',
        });
        assert.equal(res.modified, false);
        assert.equal(res.reconciled, 0);
        assert.ok(!res.records.some(r => r.reconciled));
    });

    it('is idempotent: re-running with the same chain balance does not churn', async () => {
        const records = [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_after: '287' }),
        ];
        const first = await reconcileFtTailBalances('acct.near', records, {
            probe: probeOf({ 'meta-pool.near': '0' }), block: 500, timestamp: 't',
        });
        assert.equal(first.modified, true);
        // Feed the reconciled set back in at a later head; nothing changed on-chain.
        const second = await reconcileFtTailBalances('acct.near', first.records, {
            probe: probeOf({ 'meta-pool.near': '0' }), block: 600, timestamp: 't2',
        });
        assert.equal(second.modified, false, 'unchanged on-chain -> no rewrite');
        assert.equal(second.records.filter(r => r.reconciled).length, 1);
    });

    it('a late-indexed real transfer supersedes the reconciliation', async () => {
        // Cycle 1: burn reconciled to 0.
        const c1 = await reconcileFtTailBalances('acct.near', [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_after: '287' }),
        ], { probe: probeOf({ 'meta-pool.near': '0' }), block: 500, timestamp: 't' });
        assert.equal(c1.records.filter(r => r.reconciled).length, 1);

        // Cycle 2: the transfers API finally indexed the real out-transfer (287 -> 0)
        // at block 300. The persisted file still carries cycle 1's reconciliation,
        // so it's part of the input and must be dropped now the real tail matches.
        const withRealTransfer = [
            ...c1.records,
            rec({ token_id: 'meta-pool.near', block_height: 300, amount: '-287', balance_before: '287', balance_after: '0', receipt_id: 'REAL' }),
        ];
        const c2 = await reconcileFtTailBalances('acct.near', withRealTransfer, {
            probe: probeOf({ 'meta-pool.near': '0' }), block: 600, timestamp: 't2',
        });
        assert.equal(c2.modified, true, 'stale reconciliation dropped');
        assert.ok(!c2.records.some(r => r.reconciled), 'no reconciliation once real tail matches chain');
    });

    it('does not probe intents, NEAR, or staking-pool tokens', async () => {
        const calls: string[] = [];
        const records = [
            rec({ token_id: 'nep141:usdc.near', block_height: 100, balance_after: '50' }),
            rec({ token_id: 'near', block_height: 100, balance_after: '9' }),
            rec({ token_id: 'astro.poolv1.near', block_height: 100, balance_after: '7' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: probeOf({}, calls), block: 500, timestamp: 't',
        });
        assert.deepEqual(calls, [], 'no ft_balance_of calls for non-owned/unprobeable tokens');
        assert.equal(res.modified, false);
    });

    it('keeps a prior reconciliation when the probe fails transiently', async () => {
        const seeded = await reconcileFtTailBalances('acct.near', [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_after: '287' }),
        ], { probe: probeOf({ 'meta-pool.near': '0' }), block: 500, timestamp: 't' });

        const failing: BalanceProbe = async () => { throw new Error('rpc down'); };
        const res = await reconcileFtTailBalances('acct.near', seeded.records, {
            probe: failing, block: 600, timestamp: 't2',
        });
        assert.equal(res.records.filter(r => r.reconciled).length, 1, 'prior reconciliation retained');
        assert.equal(res.modified, false);
        assert.deepEqual(res.probeFailures, ['meta-pool.near'], 'unverified tail is reported, not silent');
    });

    // Probe backed by a balance timeline: fn(block) -> raw balance at that block.
    const timelineProbe = (fn: (block: number) => string): BalanceProbe =>
        async (_token, _acct, block) => fn(block);
    const tsOf = async (block: number) => `ts-${block}`;

    it('locate: dates the correction at the actual change block via bisection', async () => {
        // Balance was 287 through block 450, 0 from 451 on (the burn block).
        const records = [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_before: '0', balance_after: '287' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: timelineProbe(b => (b <= 450 ? '287' : '0')),
            block: 1000,
            timestamp: 't-head',
            locate: { timestampOf: tsOf },
        });
        const fix = res.records.find(r => r.reconciled);
        assert.ok(fix);
        assert.equal(fix!.block_height, 451, 'dated at the actual burn block, not the probe head');
        assert.equal(fix!.block_timestamp, 'ts-451');
        assert.equal(fix!.amount, '-287');
        assert.equal(fix!.balance_before, '287');
        assert.equal(fix!.balance_after, '0');
    });

    it('locate: dates multiple change-points as separate chained records', async () => {
        // 10 through 300, 5 through 600, 0 after — two distinct disposals.
        const records = [
            rec({ token_id: 'token.near', block_height: 100, amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: timelineProbe(b => (b <= 300 ? '10' : b <= 600 ? '5' : '0')),
            block: 1000,
            timestamp: 't-head',
            locate: { timestampOf: tsOf },
        });
        const fixes = res.records.filter(r => r.reconciled).sort((a, b) => a.block_height - b.block_height);
        assert.equal(fixes.length, 2);
        assert.deepEqual(
            fixes.map(f => [f.block_height, f.amount, f.balance_before, f.balance_after, f.block_timestamp]),
            [
                [301, '-5', '10', '5', 'ts-301'],
                [601, '-5', '5', '0', 'ts-601'],
            ]
        );
    });

    it('locate: lumps the remainder at the head after maxTransitions', async () => {
        const records = [
            rec({ token_id: 'token.near', block_height: 100, amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: timelineProbe(b => (b <= 300 ? '10' : b <= 600 ? '5' : '0')),
            block: 1000,
            timestamp: 't-head',
            locate: { timestampOf: tsOf, maxTransitions: 1 },
        });
        const fixes = res.records.filter(r => r.reconciled).sort((a, b) => a.block_height - b.block_height);
        assert.equal(fixes.length, 2);
        // First change-point dated; the rest lumped into a head-stamped record.
        assert.deepEqual(fixes.map(f => [f.block_height, f.balance_before, f.balance_after, f.block_timestamp]), [
            [301, '10', '5', 'ts-301'],
            [1000, '5', '0', 't-head'],
        ]);
    });

    it('locate: falls back to a head-stamped correction when archival probes fail', async () => {
        // Head probe works; any historical (bisect) probe throws.
        const probe: BalanceProbe = async (_t, _a, block) => {
            if (block === 1000) return '0';
            throw new Error('archival unavailable');
        };
        const records = [
            rec({ token_id: 'meta-pool.near', block_height: 100, amount: '287', balance_before: '0', balance_after: '287' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe, block: 1000, timestamp: 't-head',
            locate: { timestampOf: tsOf },
        });
        const fix = res.records.find(r => r.reconciled);
        assert.ok(fix, 'the balance correction survives a dating failure');
        assert.equal(fix!.block_height, 1000);
        assert.equal(fix!.block_timestamp, 't-head');
        assert.equal(fix!.balance_after, '0');
        assert.deepEqual(res.datingFallbacks, ['meta-pool.near'], 'fallback is reported, not silent');
        assert.deepEqual(res.probeFailures, []);
    });

    it('locate: reuses an unchanged multi-record correction set without re-bisecting', async () => {
        // Prior cycle produced a two-record dated correction (10 -> 5 -> 0).
        const records = [
            rec({ token_id: 'token.near', block_height: 100, amount: '10', balance_before: '0', balance_after: '10' }),
            { ...rec({ token_id: 'token.near', block_height: 301, amount: '-5', balance_before: '10', balance_after: '5' }), tx_hash: null, reconciled: true },
            { ...rec({ token_id: 'token.near', block_height: 601, amount: '-5', balance_before: '5', balance_after: '0' }), tx_hash: null, reconciled: true },
        ];
        // Probe only tolerates the head query — a bisect probe would throw.
        const probe: BalanceProbe = async (_t, _a, block) => {
            if (block === 2000) return '0';
            throw new Error('unexpected historical probe on a reuse cycle');
        };
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe, block: 2000, timestamp: 't-head2',
            locate: { timestampOf: async () => { throw new Error('should not be called'); } },
        });
        assert.equal(res.modified, false, 'unchanged span -> reuse, no churn');
        assert.equal(res.records.filter(r => r.reconciled).length, 2);
    });

    it('does not probe a tail at or beyond the probe block', async () => {
        const calls: string[] = [];
        const records = [
            rec({ token_id: 'meta-pool.near', block_height: 500, amount: '287', balance_after: '287' }),
        ];
        const res = await reconcileFtTailBalances('acct.near', records, {
            probe: probeOf({ 'meta-pool.near': '0' }, calls), block: 500, timestamp: 't',
        });
        assert.deepEqual(calls, [], 'no probe when a real record already covers the head block');
        assert.equal(res.modified, false);
    });
});

describe('syncFtTransfersForAccount — tail reconciliation', function () {
    it('reconciles a burned FT tail end-to-end and writes the correcting record', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-recon-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'meta-pool.near', block_height: 100, receipt_id: 'ACQ', amount: '287', balance_before: '0', balance_after: '287' }),
            ],
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 1, ftBackfillVersion: 6, historyComplete: true },
        }, null, 2));

        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-07-21T00:00:00.000Z',
            fetchRecords: async () => [], // no new transfers
            reconcile: {
                probe: async () => '0', // on-chain stNEAR now 0
                block: 999,
                timestamp: '2026-07-21T00:00:00.000Z',
            },
        });

        assert.equal(result.reconciled, 1);
        assert.equal(result.changed, true);
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const fix = written.records.find((r: any) => r.reconciled);
        assert.ok(fix, 'correcting record persisted');
        assert.equal(fix.balance_after, '0');
        assert.equal(fix.amount, '-287');
        // Block-range metadata must reflect real history, not the probe block.
        assert.equal(written.metadata.lastBlock, 100);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('purges the old reconciliation on read: it never advances the watermark, and a late-indexed real transfer is fetched and supersedes it', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-recon2-'));
        const file = path.join(dir, 'acct.json');
        // Cycle N left: real tail 10 @100, plus a reconciliation 10 -> 5 stamped at
        // the then-head block 500 (the API hadn't indexed the real out-transfer yet).
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'token.near', block_height: 100, receipt_id: 'ACQ', amount: '10', balance_before: '0', balance_after: '10' }),
                { ...rec({ token_id: 'token.near', block_height: 500, amount: '-5', balance_before: '10', balance_after: '5' }), tx_hash: null, reconciled: true },
            ],
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 2, ftBackfillVersion: 6, historyComplete: true },
        }, null, 2));

        let calledAfter: number | undefined;
        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-07-21T00:00:00.000Z',
            fetchRecords: async (_acct, options) => {
                calledAfter = options.afterBlock;
                // The API has now indexed the real transfer (settled at 450, i.e.
                // BELOW the old reconciliation's block 500).
                return [rec({ token_id: 'token.near', block_height: 450, receipt_id: 'REAL', amount: '-5', balance_before: '10', balance_after: '5' })];
            },
            reconcile: {
                probe: async () => '3', // chain moved again since: 5 -> 3
                block: 900,
                timestamp: '2026-07-21T00:00:00.000Z',
            },
        });

        // Watermark from the REAL tail (100), not the old reconciliation (500) —
        // otherwise the block-450 transfer would never have been fetched.
        assert.equal(calledAfter, 100);
        assert.equal(result.changed, true);

        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const tokenRecs = written.records.filter((r: any) => r.token_id === 'token.near');
        assert.ok(tokenRecs.some((r: any) => r.receipt_id === 'REAL'), 'late-indexed real transfer ingested');
        const recons = tokenRecs.filter((r: any) => r.reconciled);
        assert.equal(recons.length, 1, 'old reconciliation replaced, not accumulated');
        assert.equal(recons[0].balance_before, '5', 'recomputed from the new real tail');
        assert.equal(recons[0].balance_after, '3');
        assert.equal(recons[0].block_height, 900);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('locate: persists the correction dated at the actual change block', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-recon4-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'meta-pool.near', block_height: 100, receipt_id: 'ACQ', amount: '287', balance_before: '0', balance_after: '287' }),
            ],
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 1, ftBackfillVersion: 6, historyComplete: true },
        }, null, 2));

        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-07-21T00:00:00.000Z',
            fetchRecords: async () => [],
            reconcile: {
                probe: async (_t, _a, block) => (block <= 450 ? '287' : '0'),
                block: 999,
                timestamp: 't-head',
                locate: { timestampOf: async (b) => `ts-${b}` },
            },
        });

        assert.equal(result.reconciled, 1);
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const fix = written.records.find((r: any) => r.reconciled);
        assert.equal(fix.block_height, 451, 'disposal booked on the real burn block');
        assert.equal(fix.block_timestamp, 'ts-451');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('no-op cycle with an unchanged reconciliation does not rewrite the file', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-recon3-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify({
            version: 2,
            accountId: 'acct.near',
            records: [
                rec({ token_id: 'token.near', block_height: 100, amount: '287', balance_before: '0', balance_after: '287' }),
                { ...rec({ token_id: 'token.near', block_height: 500, amount: '-287', balance_before: '287', balance_after: '0' }), tx_hash: null, reconciled: true },
            ],
            metadata: { firstBlock: 100, lastBlock: 100, totalRecords: 2, ftBackfillVersion: 6, historyComplete: true },
        }, null, 2));
        const before = fs.readFileSync(file, 'utf-8');

        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-07-22T00:00:00.000Z',
            fetchRecords: async () => [],
            reconcile: { probe: async () => '0', block: 900, timestamp: 't' },
        });

        assert.equal(result.changed, false, 'same (tail, on-chain) pair -> reuse, no write');
        assert.equal(result.reconciled, 1);
        assert.equal(fs.readFileSync(file, 'utf-8'), before, 'file untouched');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('tokenIdToAssetId', function () {
    it('inverts assetIdToTokenId for FT, intents, and rejects non-owned', () => {
        assert.equal(tokenIdToAssetId('npro.nearmobile.near'), 'nep141:npro.nearmobile.near');
        assert.equal(tokenIdToAssetId('nep141:npro.nearmobile.near'), 'nep245:intents.near:nep141:npro.nearmobile.near');
        assert.equal(tokenIdToAssetId('near'), null);
        assert.equal(tokenIdToAssetId('binancenode1.poolv1.near'), null);
    });
});

describe('fillOwnedGapsFromApi', function () {
    it('repairs a dropped FT claim by re-adopting the token ledger from the API', async () => {
        // A claim credit (block 200, +20) was skipped by the incremental watermark;
        // only the later withdrawal (block 250) was recorded, so its balance "20"
        // appears from nowhere -> a gap between block 150 and 250.
        const gapped = [
            rec({ token_id: 'near', block_height: 300, amount: '-1' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'c1', amount: '10', balance_before: '0', balance_after: '10' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 150, receipt_id: 'w1', amount: '-10', balance_before: '10', balance_after: '0' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 250, receipt_id: 'w2', amount: '-20', balance_before: '20', balance_after: '0' }),
        ];

        let askedAsset: string | undefined;
        const result = await fillOwnedGapsFromApi('acct.near', gapped, async (_acct, options) => {
            askedAsset = options.assetId;
            // Authoritative ledger from the transfers API: includes the missing claim.
            return [
                rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'c1', amount: '10', balance_before: '0', balance_after: '10' }),
                rec({ token_id: 'npro.nearmobile.near', block_height: 150, receipt_id: 'w1', amount: '-10', balance_before: '10', balance_after: '0' }),
                rec({ token_id: 'npro.nearmobile.near', block_height: 200, receipt_id: 'CLAIM', amount: '20', balance_before: '0', balance_after: '20', tx_hash: 'claimtx' }),
                rec({ token_id: 'npro.nearmobile.near', block_height: 250, receipt_id: 'w2', amount: '-20', balance_before: '20', balance_after: '0' }),
            ];
        });

        assert.equal(askedAsset, 'nep141:npro.nearmobile.near', 'should re-query the gapped token by asset_id');
        assert.equal(result.gaps.length, 0, 'gap closed after adopting the ledger');
        assert.ok(result.records.some(r => r.receipt_id === 'CLAIM' && r.amount === '20'), 'missing claim credit recovered');
        assert.ok(result.records.some(r => r.token_id === 'near'), 'NEAR records untouched');
        assert.ok(result.filled >= 1);
    });

    it('is a no-op when there are no gaps', async () => {
        const clean = [
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, amount: '10', balance_before: '0', balance_after: '10' }),
        ];
        const result = await fillOwnedGapsFromApi('a', clean, async () => { throw new Error('should not fetch'); });
        assert.equal(result.gaps.length, 0);
        assert.equal(result.filled, 0);
    });
});

describe('syncFtTransfersForAccount — gap repair + historyComplete', function () {
    const gappedFile = (extraMeta: Record<string, unknown> = {}) => ({
        version: 2,
        accountId: 'acct.near',
        records: [
            rec({ token_id: 'near', block_height: 300, amount: '-1' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'c1', amount: '10', balance_before: '0', balance_after: '10' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 150, receipt_id: 'w1', amount: '-10', balance_before: '10', balance_after: '0' }),
            rec({ token_id: 'npro.nearmobile.near', block_height: 250, receipt_id: 'w2', amount: '-20', balance_before: '20', balance_after: '0' }),
        ],
        metadata: { firstBlock: 100, lastBlock: 300, totalRecords: 4, ftBackfillVersion: 6, historyComplete: true, ...extraMeta },
    });

    const fullLedger = () => [
        rec({ token_id: 'npro.nearmobile.near', block_height: 100, receipt_id: 'c1', amount: '10', balance_before: '0', balance_after: '10' }),
        rec({ token_id: 'npro.nearmobile.near', block_height: 150, receipt_id: 'w1', amount: '-10', balance_before: '10', balance_after: '0' }),
        rec({ token_id: 'npro.nearmobile.near', block_height: 200, receipt_id: 'CLAIM', amount: '20', balance_before: '0', balance_after: '20', tx_hash: 'claimtx' }),
        rec({ token_id: 'npro.nearmobile.near', block_height: 250, receipt_id: 'w2', amount: '-20', balance_before: '20', balance_after: '0' }),
    ];

    it('fills the gap from the API and keeps historyComplete true', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-gap-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify(gappedFile(), null, 2));

        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-06-20T00:00:00.000Z',
            fetchRecords: async (_acct, options) => {
                if (options.assetId === 'nep141:npro.nearmobile.near') return fullLedger();
                return []; // incremental fetch finds nothing new
            },
        });

        assert.ok(result.filled >= 1);
        assert.equal(result.gaps.length, 0);
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.ok(written.records.some((r: any) => r.receipt_id === 'CLAIM'), 'claim credit written');
        assert.equal(written.metadata.historyComplete, true, 'stays complete once the gap is filled');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('flips historyComplete to false when the API still lacks the credit', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftsync-gap2-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify(gappedFile(), null, 2));

        const result = await syncFtTransfersForAccount('acct.near', file, {
            now: '2026-06-20T00:00:00.000Z',
            // API hasn't indexed the claim yet: returns the same gapped ledger.
            fetchRecords: async (_acct, options) => {
                if (options.assetId === 'nep141:npro.nearmobile.near') {
                    return fullLedger().filter(r => r.receipt_id !== 'CLAIM');
                }
                return [];
            },
        });

        assert.ok(result.gaps.some(g => g.token_id === 'npro.nearmobile.near'), 'gap still open');
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.equal(written.metadata.historyComplete, false, 'genuinely-missing FT data marks the account incomplete');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
