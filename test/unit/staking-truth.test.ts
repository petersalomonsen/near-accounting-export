import { describe, it } from 'mocha';
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { suspectPoolRecords, checkPoolRecordsAgainstChain, repairPoolRecordsAgainstChain } from '../../scripts/staking-truth.js';
import type { BalanceChangeRecord } from '../../scripts/balance-tracker.js';

// petersalomonsen.near on npro.poolv1.near, 2026-09-28, as stored and as on chain.
const POOL = 'npro.poolv1.near';
const N = (near: number) => (BigInt(Math.round(near)) * 10n ** 24n).toString();
function rec(p: Partial<BalanceChangeRecord> & { token_id: string; block_height: number }): BalanceChangeRecord {
    return { block_timestamp: '2026-09-28T14:01:21.000Z', tx_hash: null, tx_block: null, signer_id: null, receiver_id: null, predecessor_id: null, receipt_id: null, counterparty: null, amount: '0', balance_before: '0', balance_after: '0', ...p };
}
const stored = () => [
    rec({ token_id: POOL, block_height: 217684800, balance_before: N(10800), balance_after: N(10800) }),            // epoch snapshot
    rec({ token_id: POOL, block_height: 217641600, balance_before: N(10800), balance_after: N(10800) }),            // epoch snapshot
    rec({ token_id: POOL, block_height: 217641383, amount: N(1200), balance_before: N(10800), balance_after: N(12000) }),   // the bounce
    rec({ token_id: POOL, block_height: 217641382, amount: N(-1200), balance_before: N(12000), balance_after: N(10800) }),  // the withdrawal, sampled at block / block+1
    rec({ token_id: 'near', block_height: 217641382, tx_hash: 'JDaZ', counterparty: POOL, amount: '-175919208660969500000000', balance_before: '1', balance_after: '1' }),
    rec({ token_id: POOL, block_height: 217598400, balance_before: N(12000), balance_after: N(12000) }),            // epoch snapshot
];
// The pool's own answers (get_account_total_balance): 12 000 through 217641382, 10 800 from 217641383.
const chain = async (_pool: string, block: number) => BigInt(N(block <= 217641382 ? 12000 : 10800));

describe('pool records against the chain', function () {
    it('suspects only transaction-less pool records within two blocks of a principal move', () => {
        const s = suspectPoolRecords(stored()).map(r => r.block_height).sort();
        assert.deepEqual(s, [217641382, 217641383]);
        assert.deepEqual(suspectPoolRecords(stored(), 217641382).map(r => r.block_height), [217641383], 'watermark');
    });

    it('drops the transition the pool never made and keeps the one it did', async () => {
        const r = await checkPoolRecordsAgainstChain(stored(), chain);
        assert.equal(r.checked, 2);
        assert.deepEqual(r.removed.map(x => x.block_height), [217641383]);
        assert.ok(r.records.some(x => x.token_id === POOL && x.block_height === 217641382), 'the withdrawal record stays');
        assert.ok(r.records.some(x => x.token_id === POOL && x.block_height === 217641600), 'snapshots are not touched');
        assert.ok(r.reads <= 6, 'a handful of reads: ' + r.reads);
    });

    it('keeps a record it cannot judge', async () => {
        const r = await checkPoolRecordsAgainstChain(stored(), async () => null);
        assert.equal(r.removed.length, 0);
    });

    it('accepts both sampling conventions', async () => {
        // A record sampled as (block-1 -> block): 12 000 at 217641382, 10 800 at 217641383, recorded at 217641383.
        const alt = [
            rec({ token_id: POOL, block_height: 217641383, amount: N(-1200), balance_before: N(12000), balance_after: N(10800) }),
            rec({ token_id: 'near', block_height: 217641382, tx_hash: 'JDaZ', counterparty: POOL }),
        ];
        const r = await checkPoolRecordsAgainstChain(alt, chain);
        assert.equal(r.removed.length, 0);
    });

    it('repairs the file once and remembers how far it checked', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pooltruth-'));
        const file = path.join(dir, 'acct.json');
        fs.writeFileSync(file, JSON.stringify({ version: 2, accountId: 'a', records: stored(), metadata: {} }));
        let reads = 0;
        const counting = async (p: string, b: number) => { reads++; return chain(p, b); };

        const first = await repairPoolRecordsAgainstChain('a', file, counting);
        assert.equal(first.removed.length, 1);
        const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
        assert.ok(!written.records.some((r: any) => r.token_id === POOL && r.block_height === 217641383));
        assert.equal(written.metadata.poolTruthCheckedUpTo, 217684800);

        const readsAfterFirst = reads;
        const second = await repairPoolRecordsAgainstChain('a', file, counting);
        assert.equal(second.checked, 0, 'nothing newer than the watermark');
        assert.equal(reads, readsAfterFirst, 'no reads the second time');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
