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

/**
 * Inverse of assetIdToTokenId: map a V2 token_id back to the transfers-API
 * asset_id, so we can re-query the API for a single token (server-side filter).
 *   - bare FT contract "X"        -> "nep141:X"
 *   - intents balance "nep141:X"  -> "nep245:intents.near:nep141:X"
 * Returns null for tokens the transfers API doesn't own (NEAR, staking).
 */
export function tokenIdToAssetId(tokenId: string): string | null {
    if (!isTransfersOwned(tokenId)) return null;
    if (isIntentsToken(tokenId)) {
        const inner = tokenId.startsWith('nep245:intents.near:')
            ? tokenId.slice('nep245:intents.near:'.length)
            : tokenId;
        return `nep245:intents.near:${inner}`;
    }
    return `nep141:${tokenId}`;
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
 * The transfers API reports BLOCK-level balances, so per-token continuity is
 * checked at block granularity: block N's end balance must equal block N+1's
 * start balance. A mismatch means a NON-transfer balance change happened in
 * between (mint/burn, unwrap, bridge withdrawal) — the API can't represent it,
 * but the legacy balance-change tracker sampled it.
 *
 * Returns the existing records that fall inside such API gaps (and before the
 * first API block when it starts from a non-zero balance), so they can be added
 * to complete the ledger. Records that merely duplicate an API transfer are NOT
 * returned, because they don't fall inside a gap.
 */
function fillBlockGapsFromExisting(
    apiRecords: BalanceChangeRecord[],
    existing: BalanceChangeRecord[]
): BalanceChangeRecord[] {
    const apiByTok = groupByToken(apiRecords);
    const exByTok = groupByToken(existing);
    const fills: BalanceChangeRecord[] = [];

    for (const [token, recs] of apiByTok) {
        const ex = exByTok.get(token);
        if (!ex || ex.length === 0) continue;

        // Block-level balances (consistent within a block); sorted unique blocks.
        const blockBal = new Map<number, { start: string; end: string }>();
        for (const r of recs) {
            if (!blockBal.has(r.block_height)) {
                blockBal.set(r.block_height, { start: r.balance_before, end: r.balance_after });
            }
        }
        const blocks = [...blockBal.keys()].sort((a, b) => a - b);

        const addInRange = (lo: number, hi: number) => {
            for (const r of ex) if (r.block_height > lo && r.block_height < hi) fills.push(r);
        };

        // Leading gap: API history starts above zero -> earlier records are missing.
        if (blockBal.get(blocks[0]!)!.start !== '0') addInRange(-1, blocks[0]!);

        // Internal gaps: end of one block != start of the next.
        for (let i = 0; i < blocks.length - 1; i++) {
            if (blockBal.get(blocks[i]!)!.end !== blockBal.get(blocks[i + 1]!)!.start) {
                addInRange(blocks[i]!, blocks[i + 1]!);
            }
        }
    }
    return fills;
}

/**
 * Pure merge: combine existing records with freshly fetched transfer records.
 *
 * Non-owned records (NEAR, staking) always pass through untouched. For owned
 * tokens (FT + intents):
 *
 *  - Backfill: ADOPT the API's full ledger as the single authoritative source
 *    (the existing owned records are discarded). The transfers API is the
 *    comprehensive transfer index, so this gives the most complete event history
 *    without double-counting across two sources. Some tokens keep balance-
 *    continuity gaps — swap-heavy intents tokens settle several transfers per
 *    block (block-level balance snapshots), and a few balance moves aren't
 *    transfers (wNEAR/bridge mint & burn) — but those are accepted: complete,
 *    non-duplicated events matter more than a perfectly chained running balance.
 *
 *  - Incremental (default): keep every existing record and ADD only genuinely
 *    new transfers (existing wins on key collision), so the balance-change
 *    tracker's between-backfill records aren't duplicated.
 *
 * NEAR is handled separately (not "owned"): the balance-tracker stays primary
 * (it sees gas/staking), and the API's native:near transfers only fill the
 * tracker's block-level gaps — capturing cross-contract moves it dropped without
 * displacing the gas/staking records.
 *
 * After merging, per-token continuity is reported; gap reconciliation is opt-in.
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

    // NEAR is NOT owned (the API can't see gas/staking balance moves, so the
    // balance-tracker stays primary). But the API DOES index explicit native:near
    // transfers the tracker drops (cross-contract DAO/treasury moves that settle a
    // couple blocks late). So keep the tracker's NEAR records and fill THEIR
    // block-level gaps with the API's NEAR transfers — the inverse of owned
    // tokens. Balances are RPC-verified, and only records inside a real gap are
    // added, so nothing is double-counted. Residual gas gaps are left as-is.
    const nearExisting = existing.filter(r => r.token_id === 'near' && !isSynthetic(r));
    const nearFetched = fetched.filter(r => r.token_id === 'near');
    const nearFills = fillBlockGapsFromExisting(nearExisting, nearFetched);
    const nonOwned = [
        ...existing.filter(r => !isTransfersOwned(r.token_id) && r.token_id !== 'near'),
        ...nearExisting,
        ...nearFills,
    ];

    let merged: BalanceChangeRecord[];

    if (opts.backfill) {
        // Adopt the authoritative API transfer ledger for all owned tokens, then
        // fill the API's block-level gaps with the existing balance-tracker
        // records that bridge them. The API misses NON-transfer balance changes
        // (wNEAR/bridge mint & burn, unwraps); the balance-tracker sampled those.
        // We only add existing records that fall inside a genuine API gap, so
        // transfers are never double-counted.
        merged = [...ownedFetched, ...fillBlockGapsFromExisting(ownedFetched, ownedExisting)];
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

/**
 * Probe the live on-chain balance of an owned FT token for `accountId` at `block`.
 * Returns the raw balance string, or null if it can't be read (treated as "skip
 * this token this cycle"). Injected so the module stays RPC-free and testable.
 */
export type BalanceProbe = (
    tokenId: string,
    accountId: string,
    block: number
) => Promise<string | null>;

export interface ReconcileOptions {
    probe: BalanceProbe;
    /** Block to probe at — the current chain head. */
    block: number;
    /** ISO timestamp of `block`, stamped onto synthesized records (may be null). */
    timestamp: string | null;
    /**
     * When provided, a NEW discrepancy is DATED by binary-searching `probe` over
     * (lastRealBlock, block] for the block(s) where the balance actually moved,
     * instead of stamping the correction at the probe head. Requires an archival-
     * capable RPC behind the probe (old blocks). Without it, corrections are
     * booked at detection time — right balance, wrong date, which skews the
     * realization's price date (and potentially its fiscal year) in reports.
     * Runs only when a discrepancy is first detected, not on reuse cycles
     * (~log2(range) probes per change-point).
     */
    locate?: {
        /** Resolve a block's ISO timestamp for the dated record (may return null). */
        timestampOf: (block: number) => Promise<string | null>;
        /** Change-points to date before lumping the remainder at the head (default 4). */
        maxTransitions?: number;
    };
}

export interface ReconcileResult {
    /** Records with stale reconciliations dropped and fresh ones appended. */
    records: BalanceChangeRecord[];
    /** Number of tokens carrying reconciliation records after this pass. */
    reconciled: number;
    /** Whether the record set actually changed (drives the file write). */
    modified: boolean;
    /**
     * Tokens whose head probe failed or returned null — their tail was NOT
     * verified this pass (any prior correction was kept). Non-empty output must
     * be surfaced, not swallowed: a silent skip reads as "reconciled" when it
     * wasn't. Self-heals on the next cycle if the failure was transient.
     */
    probeFailures: string[];
    /** Tokens whose correction was head-stamped because dating (bisection) failed. */
    datingFallbacks: string[];
}

/**
 * Reconcile each owned FT token's TAIL balance against the live chain.
 *
 * `detectTokenGaps` only checks continuity BETWEEN consecutive records, so a
 * non-transfer balance move that happens AFTER the last transfer — with no later
 * transfer to expose the discontinuity — is invisible. The canonical case is a
 * liquid-staking redemption/unstake (e.g. meta-pool.near stNEAR) that BURNS the
 * token: no ft_transfer, so the transfers-API ledger simply ends at the stale
 * pre-burn balance and every consumer keeps showing it.
 *
 * For each bare FT contract (isFtToken — intents balances have no per-account
 * ft_balance_of; NEAR and staking pools aren't owned) we take the latest real
 * record's balance_after and compare it to ft_balance_of at the chain head. On a
 * mismatch we synthesize a correcting record (amount = on-chain − tail) so the
 * running balance reconciles to chain.
 *
 * Idempotent and self-healing: prior reconciliation records are stripped and
 * recomputed from the latest REAL tail each cycle, so a late-indexed transfer
 * (settlement lag) transparently supersedes a reconciliation instead of leaving a
 * gap. A reconciliation whose (tail, on-chain) pair is unchanged is reused as-is,
 * so a steady state doesn't churn the file.
 */
export async function reconcileFtTailBalances(
    accountId: string,
    records: BalanceChangeRecord[],
    opts: ReconcileOptions
): Promise<ReconcileResult> {
    const oldRecon = records.filter(r => r.reconciled);
    const real = records.filter(r => !r.reconciled);

    // Prior reconciliations grouped per token: a dated correction can span
    // several change-points, so a token may carry more than one record.
    const oldReconByToken = new Map<string, BalanceChangeRecord[]>();
    for (const r of oldRecon) {
        const list = oldReconByToken.get(r.token_id) || [];
        list.push(r);
        oldReconByToken.set(r.token_id, list);
    }
    for (const list of oldReconByToken.values()) {
        list.sort((a, b) => a.block_height - b.block_height);
    }

    const realByToken = groupByToken(real.filter(r => isFtToken(r.token_id)));
    const newRecon: BalanceChangeRecord[] = [];
    let reconciledTokens = 0;
    let modified = false;
    const visited = new Set<string>();
    const probeFailures: string[] = [];
    const datingFallbacks: string[] = [];

    // Keep a token's prior reconciliation untouched (probe unavailable, or the
    // tail hasn't moved past it) — reused by reference, so not a modification.
    const keepPrior = (token: string) => {
        const prior = oldReconByToken.get(token);
        if (prior) {
            newRecon.push(...prior);
            reconciledTokens++;
        }
    };

    for (const [token, recs] of realByToken) {
        visited.add(token);
        const latest = recs.reduce((a, b) => (b.block_height > a.block_height ? b : a));
        // The probe block must be strictly ahead of everything we already know, or
        // we'd be asserting a balance for a block a real record already covers.
        if (latest.block_height >= opts.block) {
            keepPrior(token);
            continue;
        }

        let onChain: string | null;
        try {
            onChain = await opts.probe(token, accountId, opts.block);
        } catch {
            // Transient RPC failure: keep any prior reconciliation for this token
            // (don't regress it to stale-but-unflagged) and move on.
            probeFailures.push(token);
            keepPrior(token);
            continue;
        }
        if (onChain == null) {
            probeFailures.push(token);
            keepPrior(token);
            continue;
        }

        const known = BigInt(latest.balance_after);
        const actual = BigInt(onChain);
        const prior = oldReconByToken.get(token);

        if (actual === known) {
            // Tail matches chain: any prior correction is now redundant (a real
            // transfer superseded it, or the balance round-tripped back).
            if (prior) modified = true;
            continue;
        }

        // Reuse the prior correction set as-is if it already bridges this exact
        // (tail → on-chain) span, so a steady state doesn't churn the file or
        // re-run the (archival-probing) dating search every cycle.
        if (
            prior &&
            prior[0]!.balance_before === known.toString() &&
            prior[prior.length - 1]!.balance_after === actual.toString()
        ) {
            newRecon.push(...prior);
            reconciledTokens++;
            continue;
        }

        modified = true;
        reconciledTokens++;
        const synth = await synthesizeCorrections(accountId, token, latest.block_height, known, actual, opts);
        if (!synth.datedOk) datingFallbacks.push(token);
        newRecon.push(...synth.records);
    }

    // Prior reconciliations for tokens that no longer have a real base record are
    // dropped (a backfill replaced the token's history) — that's a modification.
    for (const token of oldReconByToken.keys()) {
        if (!visited.has(token)) modified = true;
    }

    if (!modified) {
        return { records, reconciled: reconciledTokens, modified: false, probeFailures, datingFallbacks };
    }

    const merged = [...real, ...newRecon].sort((a, b) => b.block_height - a.block_height);
    return { records: merged, reconciled: reconciledTokens, modified: true, probeFailures, datingFallbacks };
}

/**
 * Build the correcting record(s) for one token whose tail balance (`known`, at
 * `tailBlock`) differs from the on-chain balance (`actual`, at `opts.block`).
 *
 * Without opts.locate: a single record stamped at the probe head — the running
 * balance becomes correct, but the disposal is booked at DETECTION time.
 *
 * With opts.locate: binary-search the probe over (tailBlock, opts.block] for the
 * block where the balance actually moved, so the correction lands on the real
 * change date (the right price date for accounting). A bisection finds one
 * transition, so multiple change-points are dated iteratively — each search
 * resumes from the previous find — up to maxTransitions, after which the
 * remainder is lumped into a final head-stamped record. Balances that changed
 * and changed back between probes cancel out and are invisible, which is fine:
 * the net ledger is what's being reconciled. Any probe failure during the search
 * falls back to the single head-stamped record — the balance correction must not
 * be lost just because dating it failed.
 */
async function synthesizeCorrections(
    accountId: string,
    token: string,
    tailBlock: number,
    known: bigint,
    actual: bigint,
    opts: ReconcileOptions
): Promise<{ records: BalanceChangeRecord[]; datedOk: boolean }> {
    const mkRecord = (
        block: number,
        timestamp: string | null,
        before: bigint,
        after: bigint
    ): BalanceChangeRecord => ({
        block_height: block,
        block_timestamp: timestamp,
        tx_hash: null,
        tx_block: null,
        signer_id: null,
        receiver_id: null,
        predecessor_id: null,
        token_id: token,
        receipt_id: null,
        counterparty: null,
        amount: (after - before).toString(),
        balance_before: before.toString(),
        balance_after: after.toString(),
        reconciled: true,
    });

    if (!opts.locate) {
        // Dating not requested — head-stamping is the expected outcome, not a fallback.
        return { records: [mkRecord(opts.block, opts.timestamp, known, actual)], datedOk: true };
    }

    try {
        const maxTransitions = opts.locate.maxTransitions ?? 4;
        const fixes: BalanceChangeRecord[] = [];
        let curBlock = tailBlock;
        let curBal = known;
        for (let t = 0; t < maxTransitions && curBal !== actual; t++) {
            // Invariant: balance(curBlock) === curBal, balance(opts.block) === actual ≠ curBal.
            let lo = curBlock;
            let hi = opts.block;
            let hiBal = actual;
            while (hi - lo > 1) {
                const mid = lo + Math.floor((hi - lo) / 2);
                const midRaw = await opts.probe(token, accountId, mid);
                if (midRaw == null) throw new Error(`probe returned null at block ${mid}`);
                const midBal = BigInt(midRaw);
                if (midBal === curBal) {
                    lo = mid;
                } else {
                    hi = mid;
                    hiBal = midBal;
                }
            }
            fixes.push(mkRecord(hi, await opts.locate.timestampOf(hi), curBal, hiBal));
            curBlock = hi;
            curBal = hiBal;
        }
        // More change-points than we're willing to date: lump the rest at the head.
        if (curBal !== actual) {
            fixes.push(mkRecord(opts.block, opts.timestamp, curBal, actual));
        }
        return { records: fixes, datedOk: true };
    } catch {
        return { records: [mkRecord(opts.block, opts.timestamp, known, actual)], datedOk: false };
    }
}

export interface FillGapsResult {
    /** Full record set with gapped owned tokens repaired from the API ledger. */
    records: BalanceChangeRecord[];
    /** Owned-token discontinuities remaining after the repair. */
    gaps: TokenGap[];
    /** Net owned records added while repairing. */
    filled: number;
}

/**
 * Repair per-token balance discontinuities using the transfers API itself.
 *
 * The incremental fetch boundary (latestSyncedBlock) is a single watermark across
 * ALL tokens incl. NEAR. The NEAR balance-tracker advances it every cycle, so an
 * FT claim / intents deposit that settles a couple blocks below the watermark is
 * never fetched — it surfaces only later as a discontinuity (the next transfer of
 * that token starts from a balance that "appears from nowhere"). detectTokenGaps
 * catches that; this closes it.
 *
 * For each owned token that has a gap, re-fetch its FULL authoritative ledger
 * (server-side asset_id filter — cheap, one token) and adopt it, bridging any
 * non-transfer balance moves (mint/burn) with the existing records. The transfers
 * API reports every transfer with start/end-of-block balances, so the recovered
 * records carry the real amount, balances and tx hash — i.e. the missing credit
 * lands on the same transaction that previously showed only its NEAR gas cost.
 *
 * Remaining gaps after a full re-fetch are irreducible from the transfers API
 * (e.g. swap-heavy intents tokens that settle several transfers per block, so the
 * per-transfer block snapshots don't chain) and are returned for the caller to
 * report — they do not indicate genuinely-missing data.
 */
export async function fillOwnedGapsFromApi(
    accountId: string,
    records: BalanceChangeRecord[],
    fetchRecords: (
        accountId: string,
        options: GetAllTransfersOptions
    ) => Promise<BalanceChangeRecord[]>
): Promise<FillGapsResult> {
    const gaps = detectTokenGaps(records.filter(r => isTransfersOwned(r.token_id)));
    if (gaps.length === 0) return { records, gaps, filled: 0 };

    const gappedTokens = [...new Set(gaps.map(g => g.token_id))].filter(isTransfersOwned);
    const byToken = groupByToken(records);
    let filled = 0;

    for (const token of gappedTokens) {
        const assetId = tokenIdToAssetId(token);
        if (!assetId) continue;
        let ledger: BalanceChangeRecord[];
        try {
            ledger = (await fetchRecords(accountId, { assetId })).filter(r => r.token_id === token);
        } catch {
            // Transient API error: leave this token's gap for a later cycle.
            continue;
        }
        if (ledger.length === 0) continue;
        const existingForToken = byToken.get(token) ?? [];
        // Adopt the authoritative ledger, then bridge non-transfer moves the API
        // can't represent with the existing balance-tracker records.
        const adopted = [...ledger, ...fillBlockGapsFromExisting(ledger, existingForToken)];
        filled += Math.max(0, adopted.length - existingForToken.length);
        byToken.set(token, adopted);
    }

    const merged = [...byToken.values()].flat().sort((a, b) => b.block_height - a.block_height);
    const remaining = detectTokenGaps(merged.filter(r => isTransfersOwned(r.token_id)));
    return { records: merged, gaps: remaining, filled };
}

/**
 * Highest block among records the transfers API supplies — FT + intents (owned)
 * AND NEAR. Used as the incremental fetch boundary. Must include NEAR: otherwise
 * NEAR-only accounts (no FT/intents) get a boundary of 0 and re-fetch their whole
 * transfer history every cycle. Safe after a full backfill, since everything up
 * to this block has already been fetched. 0 if none.
 *
 * Reconciliation records are excluded: they carry the probe block (chain head at
 * sync time), not a fetched transfer — counting them would advance the boundary
 * past real transfers the API indexes with lag, so they'd never be fetched.
 */
export function latestSyncedBlock(records: BalanceChangeRecord[]): number {
    let max = 0;
    for (const r of records) {
        if (r.reconciled) continue;
        if ((isTransfersOwned(r.token_id) || r.token_id === 'near') && r.block_height > max) {
            max = r.block_height;
        }
    }
    return max;
}

// Bumped when the owned-record semantics change in a way that requires a one-time
// full re-fetch to backfill/correct existing files.
//   1: initial FT (NEP-141) ingestion (N+2 claim fix)
//   2: + NEAR Intents balances (NEP-245 "Mt"), normalized to canonical nep141:X
//   3: purge synthetic gap records (null timestamp); gap reconciliation now opt-in
//   4: backfill adopts the full API ledger for all owned tokens (complete events
//      over balance continuity) — recovers swap-heavy intents history (wNEAR etc.)
//   5: backfill also fills the API's block-level gaps with existing balance-tracker
//      records (captures non-transfer mint/burn the API can't represent)
//   6: fill the balance-tracker's NEAR gaps with the API's native:near transfers
//      (captures cross-contract DAO/treasury moves the tracker drops)
export const FT_BACKFILL_VERSION = 6;

export interface SyncOptions extends MergeOptions {
    /** Injectable fetcher for tests; defaults to the live transfers API. */
    fetchRecords?: (
        accountId: string,
        options: GetAllTransfersOptions
    ) => Promise<BalanceChangeRecord[]>;
    /** Timestamp for updatedAt (ISO string). */
    now?: string;
    /**
     * Opt-in tail reconciliation against live ft_balance_of. When provided, after
     * the transfer merge each owned FT token's tail is compared to on-chain and a
     * correcting record is synthesized on mismatch (see reconcileFtTailBalances) —
     * this is what catches burn-style disposals (e.g. stNEAR redemptions) the
     * transfers API can't represent. Omit to keep sync purely transfer-driven.
     */
    reconcile?: ReconcileOptions;
}

export interface SyncResult extends MergeResult {
    /** Block the incremental fetch started after. */
    afterBlock: number;
    /** Whether anything was written. */
    changed: boolean;
    /** Whether this run performed the one-time full backfill. */
    backfilled: boolean;
    /** Tokens carrying a tail-reconciliation record after this run. */
    reconciled: number;
    /** Tokens whose tail could NOT be verified this run (probe failed). */
    reconcileProbeFailures: string[];
    /** Tokens corrected with a head-stamped record because dating failed. */
    reconcileDatingFallbacks: string[];
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
        return { records: [], fetched: 0, gaps: [], filled: 0, afterBlock: 0, changed: false, backfilled: false, reconciled: 0, reconcileProbeFailures: [], reconcileDatingFallbacks: [] };
    }

    const data = JSON.parse(fs.readFileSync(outputFile, 'utf-8'));
    if (data.version !== 2 || !Array.isArray(data.records)) {
        // Sync operates on the flat V2 format only.
        return { records: data.records ?? [], fetched: 0, gaps: [], filled: 0, afterBlock: 0, changed: false, backfilled: false, reconciled: 0, reconcileProbeFailures: [], reconcileDatingFallbacks: [] };
    }

    const allExisting: BalanceChangeRecord[] = data.records;
    data.metadata = data.metadata || {};

    // Reconciliation records (reconcileFtTailBalances) are EPHEMERAL: they are
    // recomputed from the real tail every cycle. Strip them before merging so they
    // never advance the incremental watermark, shadow a real fetched transfer in
    // the merge dedup (their ftKey can collide), or bridge — and thereby mask —
    // the very balance gap that fillOwnedGapsFromApi needs to see to recover a
    // late-indexed real transfer. They are re-derived (or reused unchanged) after
    // the merge. Without opts.reconcile they pass through untouched, so turning
    // the feature off does not silently delete prior corrections.
    const oldRecon = opts.reconcile ? allExisting.filter(r => r.reconciled) : [];
    const existing = opts.reconcile ? allExisting.filter(r => !r.reconciled) : allExisting;

    // Two-phase sync (applies to owned tokens: FT + NEAR Intents balances):
    //
    //  - One-time backfill (file predates FT_BACKFILL_VERSION): fetch the FULL
    //    history and adopt the API transfer ledger for all owned tokens
    //    (normalized to canonical ids), then fill the API's block-level gaps with
    //    the existing balance-tracker records that bridge them (non-transfer
    //    mint/burn the API can't see). Recovers every balance-changing event,
    //    including swap-heavy intents history (wNEAR etc.) the old path missed.
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
    const afterBlock = backfill ? 0 : latestSyncedBlock(existing);

    const fetched = await fetchRecords(accountId, { afterBlock: afterBlock || undefined });
    let result = await mergeFtTransferRecords(existing, fetched, { ...opts, backfill });

    // Safety net: if any owned token has a balance discontinuity (the incremental
    // watermark skipped an FT claim / intents deposit), repair it directly from
    // the transfers API — re-fetch the gapped token's full ledger and adopt it.
    if (result.gaps.length > 0) {
        const repaired = await fillOwnedGapsFromApi(accountId, result.records, fetchRecords);
        result = {
            records: repaired.records,
            fetched: result.fetched,
            gaps: repaired.gaps,
            filled: result.filled + repaired.filled,
        };
    }

    // Tail reconciliation (opt-in): catch non-transfer disposals (burns/
    // redemptions) that land after the last transfer, which detectTokenGaps can't
    // see. Runs on the merged+repaired ledger so it reconciles against the real
    // latest tail, not a stale one.
    let reconciled = 0;
    let reconcileModified = false;
    let reconcileProbeFailures: string[] = [];
    let reconcileDatingFallbacks: string[] = [];
    if (opts.reconcile) {
        // Old reconciliations ride along only for the unchanged-reuse check; the
        // merged result itself is recon-free (purged on read above).
        const rec = await reconcileFtTailBalances(accountId, [...result.records, ...oldRecon], opts.reconcile);
        reconciled = rec.reconciled;
        reconcileModified = rec.modified;
        reconcileProbeFailures = rec.probeFailures;
        reconcileDatingFallbacks = rec.datingFallbacks;
        result = { ...result, records: rec.records };
    }

    // Genuinely-missing FT data keeps the account "incomplete" so the sync loop
    // re-visits it frequently until the transfers API has indexed the credit.
    // (Intents block-level gaps are expected — several settlements per block — and
    // don't flip the flag, otherwise swap-heavy accounts would never be complete.)
    const unfilledFtGaps = result.gaps.filter(g => isFtToken(g.token_id));
    const flipIncomplete = unfilledFtGaps.length > 0 && data.metadata.historyComplete === true;

    const changed =
        result.records.length !== allExisting.length ||
        result.fetched > 0 ||
        result.filled > 0 ||
        needsBackfill ||
        flipIncomplete ||
        reconcileModified;

    if (changed) {
        // Block-range metadata reflects real history only: a reconciliation record
        // carries the probe block (the chain head at sync time), which would drag
        // lastBlock to "now" on every correction.
        const blocks = result.records.filter(r => !r.reconciled).map(r => r.block_height);
        data.records = result.records;
        if (blocks.length > 0) {
            data.metadata.firstBlock = Math.min(...blocks);
            data.metadata.lastBlock = Math.max(...blocks);
        }
        data.metadata.totalRecords = result.records.length;
        // Only mark backfilled once the full re-fetch actually succeeded.
        data.metadata.ftBackfillVersion = FT_BACKFILL_VERSION;
        if (flipIncomplete) {
            data.metadata.historyComplete = false;
        }
        data.updatedAt = opts.now ?? new Date().toISOString();
        fs.writeFileSync(outputFile, JSON.stringify(data, null, 2));
    }

    return {
        ...result, afterBlock, changed, backfilled: needsBackfill,
        reconciled, reconcileProbeFailures, reconcileDatingFallbacks,
    };
}
