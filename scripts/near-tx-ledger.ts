// NEAR per-transaction ledger builder (API-first, RPC only to read settled balances).
//
// A NEAR transaction's balance wobbles across its blocks (gas charged, receipts
// execute, refund at the end). For accounting we only want the NET: balance
// before the tx and balance after it fully settles — one record per transaction,
// no intra-tx gas ticks.
//
// Approach:
//  1. Seed the exact transaction blocks from the FastNear TX index (HTTP, no RPC,
//     no binary search). This is the complete list of blocks where the account's
//     NEAR balance could change.
//  2. Group blocks that settle together — transactions within SETTLE_BUFFER blocks
//     of each other (a rapid batch / a tx whose refund overlaps the next) become
//     one net event, so we never sample mid-settlement.
//  3. Sample the NEAR balance once per group at a settled point. Consecutive
//     samples give before→after per group. ~1 archival read per transaction group,
//     vs the old binary-search + per-change-block sampling.

import fs from 'fs';
import { getAllFastNearTxTransactionBlocks } from './fastnear-tx-api.js';
import { getAllBalances } from './balance-tracker.js';
import { getBlockTimestamp, getCurrentBlockHeight } from './rpc.js';
import type { BalanceChangeRecord } from './balance-tracker.js';

// Receipts (incl. the gas refund) settle within a few blocks of the tx block.
export const SETTLE_BUFFER = 5;

export interface NearLedgerOptions {
    afterBlock?: number;   // only transactions strictly after this block
    beforeBlock?: number;
    // injectable for tests:
    fetchTxBlocks?: (acct: string, o: { afterBlock?: number; beforeBlock?: number }) => Promise<number[]>;
    nearBalanceAt?: (block: number) => Promise<string>;
    blockTimestamp?: (block: number) => Promise<number | null>;
    currentBlock?: number; // tail "after" point; defaults to last group's settle block
}

/** A transaction group: one or more tx blocks that settle together. */
interface TxGroup {
    firstBlock: number; // representative block for the record (the tx block)
    settleBlock: number; // a block where the group's balance has fully settled
}

/** Group sorted, de-duplicated tx blocks that settle within SETTLE_BUFFER of each other. */
export function groupTxBlocks(blocks: number[]): TxGroup[] {
    const sorted = [...new Set(blocks)].sort((a, b) => a - b);
    const groups: TxGroup[] = [];
    for (const b of sorted) {
        const last = groups[groups.length - 1];
        if (last && b - last.settleBlock <= SETTLE_BUFFER) {
            // overlaps the previous group's settlement window — merge.
            last.settleBlock = b + SETTLE_BUFFER;
        } else {
            groups.push({ firstBlock: b, settleBlock: b + SETTLE_BUFFER });
        }
    }
    return groups;
}

/**
 * Build NEAR balance-change records, one per transaction group, with the net
 * effect (balance_before -> balance_after across the whole settled transaction).
 * Returns records newest-first. Records with zero net change are omitted.
 */
export async function buildNearLedger(
    accountId: string,
    opts: NearLedgerOptions = {}
): Promise<{ records: BalanceChangeRecord[]; rpcReads: number }> {
    const fetchTxBlocks = opts.fetchTxBlocks
        ?? (async (a, o) => (await getAllFastNearTxTransactionBlocks(a, o)).map(t => t.blockHeight));
    const blockTime = opts.blockTimestamp ?? getBlockTimestamp;

    let rpcReads = 0;
    const balAt = async (block: number): Promise<string> => {
        rpcReads++;
        if (opts.nearBalanceAt) return opts.nearBalanceAt(block);
        return (await getAllBalances(accountId, block, null, null, true, null)).near;
    };

    const txBlocks = await fetchTxBlocks(accountId, { afterBlock: opts.afterBlock, beforeBlock: opts.beforeBlock });
    const groups = groupTxBlocks(txBlocks);
    if (groups.length === 0) return { records: [], rpcReads: 0 };

    // "before" of the first group: balance just before its tx block.
    let prevBalance = await balAt(groups[0]!.firstBlock - 1);

    const records: BalanceChangeRecord[] = [];
    const tailBlock = opts.currentBlock;
    for (let i = 0; i < groups.length; i++) {
        const g = groups[i]!;
        // Sample the settled balance at the latest point before the next transaction.
        // Between two separate groups the account has no activity, so the balance is
        // stable there — sampling just before the next tx captures even late gas
        // refunds (which a fixed +BUFFER offset can miss). For the final group, use
        // the provided current block (or its settle block as a fallback).
        const next = groups[i + 1];
        const samplePoint = next ? next.firstBlock - 1 : (tailBlock ?? g.settleBlock);
        const after = await balAt(samplePoint);

        if (after !== prevBalance) {
            const ts = await blockTime(g.firstBlock);
            records.push({
                block_height: g.firstBlock,
                block_timestamp: ts != null ? new Date(Math.floor(ts / 1_000_000)).toISOString() : null,
                tx_hash: null,
                tx_block: g.firstBlock,
                signer_id: null,
                receiver_id: null,
                predecessor_id: null,
                token_id: 'near',
                receipt_id: null,
                counterparty: null,
                amount: (BigInt(after) - BigInt(prevBalance)).toString(),
                balance_before: prevBalance,
                balance_after: after,
            });
        }
        prevBalance = after;
    }

    records.sort((a, b) => b.block_height - a.block_height);
    return { records, rpcReads };
}

export interface SyncNearResult {
    changed: boolean;
    nearRecords?: number;
    rpcReads?: number;
    reason?: string;
}

/**
 * Rebuild an account's NEAR ledger from the tx index and mark it historyComplete.
 *
 * Targets the perpetually-"incomplete" accounts whose backward binary search runs
 * every cycle and never finishes — the steady-state RPC hotspot. The tx index
 * gives the complete transaction list back to creation, so one bounded pass
 * produces an authoritative, on-chain-accurate NEAR ledger AND lets us mark the
 * account complete (the worker then skips the backward search entirely).
 *
 * Already-complete accounts are skipped (no backward-search problem) unless
 * opts.force. NEAR records are replaced; all other tokens are untouched.
 */
export async function syncNearLedgerForAccount(
    accountId: string,
    outputFile: string,
    opts: { force?: boolean; currentBlock?: number } & Pick<NearLedgerOptions, 'fetchTxBlocks' | 'nearBalanceAt' | 'blockTimestamp'> = {}
): Promise<SyncNearResult> {
    if (!fs.existsSync(outputFile)) return { changed: false, reason: 'no-file' };
    const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    if (data.version !== 2 || !Array.isArray(data.records)) return { changed: false, reason: 'not-v2' };

    data.metadata = data.metadata || {};
    if (data.metadata.historyComplete === true && !opts.force) {
        return { changed: false, reason: 'already-complete' };
    }

    const currentBlock = opts.currentBlock ?? await getCurrentBlockHeight();
    const { records: nearRecords, rpcReads } = await buildNearLedger(accountId, {
        currentBlock,
        fetchTxBlocks: opts.fetchTxBlocks,
        nearBalanceAt: opts.nearBalanceAt,
        blockTimestamp: opts.blockTimestamp,
    });

    const nonNear = data.records.filter((r: BalanceChangeRecord) => r.token_id !== 'near');
    const merged = [...nonNear, ...nearRecords].sort((a, b) => b.block_height - a.block_height);
    data.records = merged;
    if (merged.length > 0) {
        const blocks = merged.map((r: BalanceChangeRecord) => r.block_height);
        data.metadata.firstBlock = Math.min(...blocks);
        data.metadata.lastBlock = Math.max(...blocks);
    }
    data.metadata.totalRecords = merged.length;
    data.metadata.historyComplete = true; // tx index covers all history -> stop the backward search
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
    return { changed: true, nearRecords: nearRecords.length, rpcReads };
}
