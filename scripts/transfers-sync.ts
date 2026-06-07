// FT transfer sync — makes the FastNear Transfers API the authoritative source
// for fungible-token (NEP-141) balance-change records.
//
// Background: the legacy pipeline discovers a *transaction* block N and samples
// ft_balance_of at N and N+1. Multi-hop claims (e.g. distribution.nearmobile.near
// → npro.nearmobile.near) settle the credit at N+2, outside that window, so the
// transfer is dropped and the claim is invisible. The transfers API reports each
// transfer at its real receipt block with authoritative start/end-of-block
// balances, eliminating the guesswork.
//
// Scope: this module owns FT records only. NEAR (token_id "near") stays on the
// existing path (the transfers API does not surface gas/implicit balance
// movements, so switching NEAR wholesale would lose data). Intents internal
// tokens ("nep141:*") and staking pools ("*.poolv1.near", ...) keep their
// dedicated discovery paths.

import fs from 'fs';
import {
    detectTokenGaps,
    isStakingPool,
    type BalanceChangeRecord,
    type TokenGap,
} from './balance-tracker.js';
import {
    getAccountTransferRecords,
    type GapSampler,
    type GetAllTransfersOptions,
} from './fastnear-transfers-api.js';

/**
 * Does this token_id belong to the transfers-API-owned FT space?
 *
 * Owns only bare NEP-141 contract ids (e.g. "npro.nearmobile.near"). Excludes:
 *  - NEAR ("near")
 *  - intents / multi-token ids, which are scheme-prefixed and therefore contain
 *    a colon ("nep141:...", "nep245:intents.near:nep141:..."). A real NEAR
 *    account id never contains ":", so this one check covers every intents form.
 *  - staking pools ("*.poolv1.near", ...)
 */
export function isFtToken(tokenId: string): boolean {
    if (tokenId === 'near') return false;
    if (tokenId.includes(':')) return false; // intents / scheme-prefixed multi-token
    if (isStakingPool(tokenId)) return false;
    return true;
}

/** Stable identity for an FT record so the authoritative version replaces a stale one. */
function ftKey(r: BalanceChangeRecord): string {
    return `${r.token_id}|${r.receipt_id ?? r.block_height}|${r.amount}`;
}

/**
 * Default gap reconciler. The transfers API balances already tell us the true
 * balance on both sides of a discontinuity, so we synthesize a single record
 * that reconnects them (amount = the diff). No RPC sampling required; a richer
 * sampler can be injected if deeper reconstruction is ever needed.
 */
export const syntheticGapSampler: GapSampler = async (gap: TokenGap) => {
    const block = gap.from_block + 1 < gap.to_block ? gap.from_block + 1 : gap.to_block;
    return [{
        block_height: block,
        block_timestamp: null,
        tx_hash: null,
        tx_block: null,
        signer_id: null,
        receiver_id: null,
        predecessor_id: null,
        token_id: gap.token_id,
        receipt_id: null,
        counterparty: null,
        amount: gap.diff,
        balance_before: gap.expected_balance,
        balance_after: gap.actual_balance,
    }];
};

export interface MergeOptions {
    /** Replace ALL existing FT records instead of appending after the latest. */
    fullResync?: boolean;
    /** Reconcile per-token balance discontinuities. Defaults to syntheticGapSampler. */
    sampler?: GapSampler;
}

export interface MergeResult {
    /** Full merged record set across all tokens (FT replaced, others untouched). */
    records: BalanceChangeRecord[];
    /** Number of FT records fetched from the transfers API. */
    fetched: number;
    /** Discontinuities detected after merging. */
    gaps: TokenGap[];
    /** Records contributed by the sampler to close gaps. */
    filled: number;
}

/**
 * Pure merge: combine existing records with freshly fetched transfer records.
 *
 * - Non-FT records (NEAR, intents, staking) pass through untouched.
 * - FT records: in incremental mode the existing set is kept and new records are
 *   added (authoritative version wins on key collision). In fullResync mode the
 *   existing FT set is discarded and rebuilt from the fetched records.
 * - After merging, per-token continuity is checked and any gap is reconciled.
 */
export async function mergeFtTransferRecords(
    existing: BalanceChangeRecord[],
    fetched: BalanceChangeRecord[],
    opts: MergeOptions = {}
): Promise<MergeResult> {
    const sampler = opts.sampler ?? syntheticGapSampler;

    const ftFetched = fetched.filter(r => isFtToken(r.token_id));
    const ftExisting = existing.filter(r => isFtToken(r.token_id));
    const nonFt = existing.filter(r => !isFtToken(r.token_id));

    const base = opts.fullResync ? [] : ftExisting;

    // Build the FT set, existing-wins. The legacy balance-change tracker's FT
    // records are correct but INCOMPLETE: it captures single-block settlements
    // (incl. wNEAR/bridge mint & burn, which aren't transfers) but drops 2+ hop
    // claims that settle outside its sampling window. So we keep every existing
    // record and let the transfers API ADD only the genuinely-missing transfers
    // (matched by receipt id). Existing is inserted last so it wins collisions —
    // this preserves mint/burn context instead of overwriting it.
    const dedup = new Map<string, BalanceChangeRecord>();
    for (const r of ftFetched) dedup.set(ftKey(r), r);
    for (const r of base) dedup.set(ftKey(r), r);
    let merged = [...dedup.values()];

    const gaps = detectTokenGaps(merged);
    let filled = 0;
    if (gaps.length > 0) {
        for (const gap of gaps) {
            const recovered = await sampler(gap);
            for (const r of recovered) {
                dedup.set(ftKey(r), r);
                filled++;
            }
        }
        merged = [...dedup.values()];
    }

    const records = [...nonFt, ...merged].sort((a, b) => b.block_height - a.block_height);
    return { records, fetched: ftFetched.length, gaps, filled };
}

/** Highest FT-record block currently stored (0 if none). */
export function latestFtBlock(records: BalanceChangeRecord[]): number {
    let max = 0;
    for (const r of records) {
        if (isFtToken(r.token_id) && r.block_height > max) max = r.block_height;
    }
    return max;
}

// Bumped when the FT-record semantics change in a way that requires a one-time
// full re-fetch to backfill/correct existing files (e.g. the N+2 claim fix).
export const FT_BACKFILL_VERSION = 1;

export interface SyncOptions extends MergeOptions {
    /** Injectable fetcher for tests; defaults to the live transfers API. */
    fetchRecords?: (
        accountId: string,
        options: GetAllTransfersOptions
    ) => Promise<BalanceChangeRecord[]>;
    /** Timestamp for updatedAt (ISO string). */
    now?: string;
}

export interface SyncResult extends MergeResult {
    /** Block the incremental fetch started after. */
    afterBlock: number;
    /** Whether anything was written. */
    changed: boolean;
    /** Whether this run performed the one-time full backfill. */
    backfilled: boolean;
}

/**
 * Sync FT transfer records for one account into its V2 history file.
 *
 * Reads the file, fetches FT transfers from the transfers API (incrementally
 * after the latest stored FT block, or the full history on fullResync), merges,
 * reconciles gaps, and writes back. Non-V2 files are skipped.
 */
export async function syncFtTransfersForAccount(
    accountId: string,
    outputFile: string,
    opts: SyncOptions = {}
): Promise<SyncResult> {
    const fetchRecords = opts.fetchRecords ?? getAccountTransferRecords;

    if (!fs.existsSync(outputFile)) {
        return { records: [], fetched: 0, gaps: [], filled: 0, afterBlock: 0, changed: false, backfilled: false };
    }

    const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    if (data.version !== 2 || !Array.isArray(data.records)) {
        // FT sync operates on the flat V2 format only.
        return { records: data.records ?? [], fetched: 0, gaps: [], filled: 0, afterBlock: 0, changed: false, backfilled: false };
    }

    const existing: BalanceChangeRecord[] = data.records;
    data.metadata = data.metadata || {};

    // Two-phase sync:
    //
    //  - One-time backfill (file predates FT_BACKFILL_VERSION): rebuild the FT
    //    set cleanly from the authoritative transfers API (full fetch + discard).
    //    The legacy FT records and the transfers API keep balances on different
    //    bases, so blanket-merging the two produces spurious discontinuities;
    //    a clean rebuild avoids that. The only records lost are historical
    //    mint/burn (wNEAR/bridge), which aren't transfers — the continuity check
    //    re-creates them synthetically with correct amounts/balances.
    //
    //  - Steady state (incremental): fetch after the latest stored FT block and
    //    merge ADDITIVELY (existing-wins). The balance-change tracker runs first
    //    each cycle and records new mint/burn with full tx context; this keeps
    //    them and only adds the multi-hop claims the tracker still misses.
    //
    // Non-FT records (NEAR, intents, staking) are never touched.
    const needsBackfill = data.metadata.ftBackfillVersion !== FT_BACKFILL_VERSION;
    const fullResync = opts.fullResync || needsBackfill;
    const afterBlock = fullResync ? 0 : latestFtBlock(existing);

    const fetched = await fetchRecords(accountId, { afterBlock: afterBlock || undefined });
    const result = await mergeFtTransferRecords(existing, fetched, { ...opts, fullResync });

    const changed =
        result.records.length !== existing.length ||
        result.fetched > 0 ||
        result.filled > 0 ||
        needsBackfill;

    if (changed) {
        const blocks = result.records.map(r => r.block_height);
        data.records = result.records;
        if (blocks.length > 0) {
            data.metadata.firstBlock = Math.min(...blocks);
            data.metadata.lastBlock = Math.max(...blocks);
        }
        data.metadata.totalRecords = result.records.length;
        // Only mark backfilled once the full re-fetch actually succeeded.
        data.metadata.ftBackfillVersion = FT_BACKFILL_VERSION;
        data.updatedAt = opts.now ?? new Date().toISOString();
        fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
    }

    return { ...result, afterBlock, changed, backfilled: needsBackfill };
}
