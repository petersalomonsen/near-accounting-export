// Pool records checked against the pool.
//
// A staking pool record with no transaction behind it is a sample: the pool's
// balance read at a block, and the block before. Read within a block or two
// of a transaction that moved principal, a sample can land on the wrong side
// of the move and report it reversed. One real case: the withdrawal of 1 200
// NEAR from npro.poolv1.near on 2026-09-28 was recorded at its block,
// 12 000 → 10 800, and one block later a second record said 10 800 → 12 000
// — a transition the chain never made. Downstream that read as 1 200 NEAR of
// staking income.
//
// The pool contract is the authority. For every such record the pool's
// balance at the surrounding blocks says whether the transition happened:
// either (block−1 → block), or (block → block+1), the two conventions the
// tracker uses. A record matching neither is dropped. Only records near a
// transaction are checked, and only once: the check is watermarked.

import fs from 'fs';
import { isStakingPool, type BalanceChangeRecord } from './balance-tracker.js';
import { getStakingPoolBalances } from './balance-tracker.js';

/** The pool's balance for the account at a block, yocto; null when unreadable. */
export type PoolBalanceReader = (pool: string, block: number) => Promise<bigint | null>;

export function rpcPoolBalanceReader(accountId: string): PoolBalanceReader {
    return async (pool, block) => {
        const read = await getStakingPoolBalances(accountId, block, [pool]);
        const v = read[pool];
        return v === undefined ? null : BigInt(v);
    };
}

/** How close to a principal move a sample has to be to be worth checking. */
export const NEAR_A_MOVE_BLOCKS = 2;

/**
 * Pool records with no transaction that sit within NEAR_A_MOVE_BLOCKS of a
 * NEAR record that has one and names that pool as counterparty.
 */
export function suspectPoolRecords(records: BalanceChangeRecord[], afterBlock = 0): BalanceChangeRecord[] {
    const moves = records.filter(r => r.token_id === 'near' && r.tx_hash && r.counterparty && isStakingPool(r.counterparty));
    return records.filter(r =>
        isStakingPool(r.token_id)
        && !r.tx_hash
        && r.block_height > afterBlock
        && moves.some(m => m.counterparty === r.token_id && Math.abs(m.block_height - r.block_height) <= NEAR_A_MOVE_BLOCKS));
}

export interface PoolTruthResult {
    records: BalanceChangeRecord[];
    removed: BalanceChangeRecord[];
    checked: number;
    reads: number;
}

/**
 * Drop suspect pool records the pool itself contradicts.
 */
export async function checkPoolRecordsAgainstChain(
    records: BalanceChangeRecord[],
    read: PoolBalanceReader,
    { afterBlock = 0 }: { afterBlock?: number } = {}
): Promise<PoolTruthResult> {
    const suspects = suspectPoolRecords(records, afterBlock);
    if (suspects.length === 0) return { records, removed: [], checked: 0, reads: 0 };

    const cache = new Map<string, bigint | null>();
    let reads = 0;
    const at = async (pool: string, block: number): Promise<bigint | null> => {
        const key = `${pool}@${block}`;
        if (!cache.has(key)) { reads++; cache.set(key, await read(pool, block)); }
        return cache.get(key)!;
    };

    const removed: BalanceChangeRecord[] = [];
    for (const r of suspects) {
        const b = r.block_height;
        const [prev, here, next] = await Promise.all([at(r.token_id, b - 1), at(r.token_id, b), at(r.token_id, b + 1)]);
        if (prev === null || here === null || next === null) continue; // cannot judge: keep
        const before = BigInt(r.balance_before);
        const after = BigInt(r.balance_after);
        const sampledBeforeAndAt = prev === before && here === after;
        const sampledAtAndAfter = here === before && next === after;
        if (!sampledBeforeAndAt && !sampledAtAndAfter) removed.push(r);
    }
    const gone = new Set(removed);
    return { records: records.filter(r => !gone.has(r)), removed, checked: suspects.length, reads };
}

/**
 * The file-level repair the worker runs each cycle: checks pool records newer
 * than the last check, writes the file when any are dropped, and advances the
 * watermark either way.
 */
export async function repairPoolRecordsAgainstChain(
    accountId: string,
    outputFile: string,
    read: PoolBalanceReader = rpcPoolBalanceReader(accountId)
): Promise<PoolTruthResult & { changed: boolean }> {
    const nothing = { records: [] as BalanceChangeRecord[], removed: [], checked: 0, reads: 0, changed: false };
    if (!fs.existsSync(outputFile)) return nothing;
    const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    if (data.version !== 2 || !Array.isArray(data.records)) return { ...nothing, records: data.records ?? [] };
    data.metadata = data.metadata || {};

    const afterBlock: number = data.metadata.poolTruthCheckedUpTo ?? 0;
    const result = await checkPoolRecordsAgainstChain(data.records, read, { afterBlock });
    const lastBlock = Math.max(afterBlock, ...data.records.map((r: BalanceChangeRecord) => r.block_height));
    const changed = result.removed.length > 0 || lastBlock !== afterBlock;
    if (changed) {
        data.records = result.records;
        data.metadata.poolTruthCheckedUpTo = lastBlock;
        data.metadata.totalRecords = result.records.length;
        if (result.removed.length > 0) data.updatedAt = new Date().toISOString();
        fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
    }
    return { ...result, changed };
}
