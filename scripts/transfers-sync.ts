// Transfers sync — makes the FastNear Transfers API the authoritative source for
// fungible-token (NEP-141) AND NEAR Intents (NEP-245) balance-change records.
//
// Background: the legacy pipeline discovers a *transaction* block N and samples
// balances at N and N+1. Multi-hop transfers settle a couple blocks later, outside
// that window, so they're dropped — e.g. NPRO claims (distribution.nearmobile.near
// → npro.nearmobile.near, credited at N+2) and intents deposits (ft_transfer_call
// → intents.near, credited via ft_on_transfer at N+2). The transfers API reports
// every transfer at its real receipt block with authoritative start/end-of-block
// balances, eliminating the guesswork — FT as asset_type "Ft", intents as "Mt".
//
// Scope: this module owns FT records (bare contract ids) and intents records
// (canonical "nep141:<contract>"). NEAR (token_id "near") stays on the existing
// path — the transfers API doesn't surface gas/implicit movements, so switching
// NEAR wholesale would lose data. Staking pools ("*.poolv1.near", ...) keep their
// dedicated discovery path.

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
 * A bare on-chain NEP-141 fungible token (e.g. "npro.nearmobile.near").
 * Excludes NEAR, scheme-prefixed intents ids (they contain ":"), and staking pools.
 */
export function isFtToken(tokenId: string): boolean {
    if (tokenId === 'near') return false;
    if (tokenId.includes(':')) return false; // intents / scheme-prefixed multi-token
    if (isStakingPool(tokenId)) return false;
    return true;
}

/**
 * A NEAR Intents internal balance. Canonical form is "nep141:<contract>"; older
 * records may use the longer "nep245:intents.near:nep141:<contract>" form, which
 * the backfill rewrites to the canonical id.
 */
export function isIntentsToken(tokenId: string): boolean {
    return tokenId.startsWith('nep141:') || tokenId.startsWith('nep245:intents.near:');
}

/**
 * Tokens owned by the transfers-API sync: bare FT contracts AND NEAR Intents
 * balances. Both have a complete, authoritative ledger in the transfers API
 * (FT as asset_type "Ft", intents as "Mt"). NEAR and staking pools are NOT owned
 * and keep their existing discovery paths.
 */
export function isTransfersOwned(tokenId: string): boolean {
    return isFtToken(tokenId) || isIntentsToken(tokenId);
}

/** Stable identity for an FT record so the authoritative version replaces a stale one. */
function ftKey(r: BalanceChangeRecord): string {
    return `${r.token_id}|${r.receipt_id ?? r.block_height}|${r.amount}`;
}

/**
 * A record this module previously synthesized to bridge a gap: it has no tx,
 * receipt, or timestamp. Used to purge such records on re-backfill. (Owned FT/
 * intents records from the API always carry a tx hash and timestamp, so this
 * never matches real transfer records.)
 */
function isSynthetic(r: BalanceChangeRecord): boolean {
    return r.block_timestamp == null && r.receipt_id == null && r.tx_hash == null;
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
    /**
     * Backfill mode: the `fetched` set is the FULL history, so decide per token
     * whether the API ledger is authoritative. A token whose API ledger is
     * internally continuous replaces the existing records for that token; a token
     * whose API ledger has gaps (swap-heavy intents tokens settle several
     * transfers per block, so the API's per-transfer balances don't chain) is
     * left as-is to avoid regressing it. Without this flag the merge is
     * incremental (additive, existing-wins).
     */
    backfill?: boolean;
    /**
     * Optional gap reconciler. If provided, per-token balance discontinuities are
     * filled by this sampler. Off by default — production does not synthesize
     * records (see syntheticGapSampler, kept for experiments/tests).
     */
    sampler?: GapSampler;
}

export interface MergeResult {
    /** Full merged record set across all tokens (owned merged, others untouched). */
    records: BalanceChangeRecord[];
    /** Number of owned (FT + intents) records fetched from the transfers API. */
    fetched: number;
    /** Discontinuities detected after merging. */
    gaps: TokenGap[];
    /** Records contributed by the sampler to close gaps. */
    filled: number;
}

function groupByToken(records: BalanceChangeRecord[]): Map<string, BalanceChangeRecord[]> {
    const m = new Map<string, BalanceChangeRecord[]>();
    for (const r of records) {
        const list = m.get(r.token_id) || [];
        list.push(r);
        m.set(r.token_id, list);
    }
    return m;
}

/**
 * Pure merge: combine existing records with freshly fetched transfer records.
 *
 * Non-owned records (NEAR, staking) always pass through untouched. For owned
 * tokens (FT + intents):
 *
 *  - Incremental (default): keep every existing record and ADD only genuinely
 *    new transfers (existing wins on key collision). The legacy balance-change
 *    tracker records single-block settlements (incl. wNEAR/bridge mint & burn,
 *    which aren't transfers); this preserves them and just adds the multi-hop
 *    transfers it drops (FT claims, intents deposits).
 *
 *  - Backfill: per token, if the API's full ledger is internally continuous it
 *    is authoritative and replaces the existing records for that token; if it has
 *    gaps (swap-heavy intents tokens), the existing records are kept so we never
 *    regress a token. New tokens (no existing records) take the API ledger.
 *
 * After merging, per-token continuity is checked and any residual gap is
 * reconciled by the sampler.
 */
export async function mergeFtTransferRecords(
    existing: BalanceChangeRecord[],
    fetched: BalanceChangeRecord[],
    opts: MergeOptions = {}
): Promise<MergeResult> {
    // Gap reconciliation is opt-in. By default we do NOT synthesize records:
    // the per-token backfill already keeps each token on a single coherent
    // source, and synthetic records (no tx/receipt/timestamp) are low value and
    // caused downstream issues (null block_timestamp). Pass opts.sampler to
    // re-enable, e.g. for experiments.
    const sampler = opts.sampler;

    const ownedFetched = fetched.filter(r => isTransfersOwned(r.token_id));
    // Drop previously-synthesized records (null timestamp marker) so a re-backfill
    // cleans them out instead of carrying them forward.
    const ownedExisting = existing.filter(r => isTransfersOwned(r.token_id) && !isSynthetic(r));
    const nonOwned = existing.filter(r => !isTransfersOwned(r.token_id));

    let merged: BalanceChangeRecord[];

    if (opts.backfill) {
        // Per-token: adopt the API ledger only when it is internally continuous.
        const fByTok = groupByToken(ownedFetched);
        const eByTok = groupByToken(ownedExisting);
        const tokens = new Set<string>([...fByTok.keys(), ...eByTok.keys()]);
        merged = [];
        for (const tok of tokens) {
            const cand = (fByTok.get(tok) || []).slice().sort((a, b) => a.block_height - b.block_height);
            const ex = eByTok.get(tok) || [];
            if (cand.length > 0 && detectTokenGaps(cand).length === 0) {
                merged.push(...cand);          // API ledger complete -> authoritative
            } else if (ex.length > 0) {
                merged.push(...ex);            // API incomplete -> keep existing (no regression)
            } else {
                merged.push(...cand);          // new token, best effort
            }
        }
    } else {
        // Incremental, existing-wins: add only genuinely-missing transfers.
        const dedup = new Map<string, BalanceChangeRecord>();
        for (const r of ownedFetched) dedup.set(ftKey(r), r);
        for (const r of ownedExisting) dedup.set(ftKey(r), r);
        merged = [...dedup.values()];
    }

    const gaps = detectTokenGaps(merged);
    let filled = 0;
    if (gaps.length > 0 && sampler) {
        const byKey = new Map<string, BalanceChangeRecord>();
        for (const r of merged) byKey.set(ftKey(r), r);
        for (const gap of gaps) {
            const recovered = await sampler(gap);
            for (const r of recovered) {
                byKey.set(ftKey(r), r);
                filled++;
            }
        }
        merged = [...byKey.values()];
    }

    const records = [...nonOwned, ...merged].sort((a, b) => b.block_height - a.block_height);
    return { records, fetched: ownedFetched.length, gaps, filled };
}

/** Highest block among transfers-API-owned records (FT + intents); 0 if none. */
export function latestOwnedBlock(records: BalanceChangeRecord[]): number {
    let max = 0;
    for (const r of records) {
        if (isTransfersOwned(r.token_id) && r.block_height > max) max = r.block_height;
    }
    return max;
}

// Bumped when the owned-record semantics change in a way that requires a one-time
// full re-fetch to backfill/correct existing files.
//   1: initial FT (NEP-141) ingestion (N+2 claim fix)
//   2: + NEAR Intents balances (NEP-245 "Mt"), normalized to canonical nep141:X
//   3: purge synthetic gap records (null timestamp); gap reconciliation now opt-in
export const FT_BACKFILL_VERSION = 3;

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
 * Sync transfers-API records (FT + NEAR Intents) for one account into its V2
 * history file.
 *
 * Reads the file, fetches transfers from the API (incrementally after the latest
 * stored owned block, or the full history on backfill), merges, reconciles gaps,
 * and writes back. Non-V2 files are skipped.
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
        // Sync operates on the flat V2 format only.
        return { records: data.records ?? [], fetched: 0, gaps: [], filled: 0, afterBlock: 0, changed: false, backfilled: false };
    }

    const existing: BalanceChangeRecord[] = data.records;
    data.metadata = data.metadata || {};

    // Two-phase sync (applies to owned tokens: FT + NEAR Intents balances):
    //
    //  - One-time backfill (file predates FT_BACKFILL_VERSION): fetch the FULL
    //    history and, per token, adopt the API ledger where it is internally
    //    continuous (authoritative, normalized to canonical ids) while leaving
    //    tokens the API can't represent cleanly (swap-heavy intents) as-is. This
    //    recovers the dropped transfers without regressing any token.
    //
    //  - Steady state (incremental): fetch after the latest stored owned block and
    //    merge ADDITIVELY (existing-wins). The balance-change tracker runs first
    //    each cycle and records new mint/burn with full tx context; this keeps
    //    them and only adds the multi-hop transfers the tracker misses (FT claims,
    //    intents deposits).
    //
    // NEAR and staking records are never touched.
    const needsBackfill = data.metadata.ftBackfillVersion !== FT_BACKFILL_VERSION;
    const backfill = needsBackfill || opts.backfill === true;
    const afterBlock = backfill ? 0 : latestOwnedBlock(existing);

    const fetched = await fetchRecords(accountId, { afterBlock: afterBlock || undefined });
    const result = await mergeFtTransferRecords(existing, fetched, { ...opts, backfill });

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
