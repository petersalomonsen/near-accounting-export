/**
 * Gap Detection Module
 *
 * Pure functions for detecting gaps in transaction history.
 * Gaps are detected by comparing balances between consecutive records.
 *
 * This module is stateless and performs no I/O - it operates purely on in-memory data.
 *
 * Supports both:
 * - V1 format: TransactionEntry[] with nested balanceBefore/balanceAfter snapshots
 * - V2 format: BalanceChangeRecord[] with flat per-token records
 */

import {
    type BalanceChangeRecord,
    detectTokenGaps,
    type TokenGap
} from './balance-tracker.js';

/**
 * A balance snapshot at a specific block
 */
export interface BalanceSnapshot {
    near: string;
    fungibleTokens: Record<string, string>;
    intentsTokens: Record<string, string>;
    stakingPools?: Record<string, string>;
}

/**
 * A transfer detail record
 */
export interface TransferDetail {
    type: 'near' | 'ft' | 'mt' | 'staking_reward' | 'action_receipt_gas_reward';
    direction: 'in' | 'out';
    amount: string;
    counterparty: string;
    tokenId?: string;
    memo?: string;
    txHash?: string;
    receiptId?: string;
}

/**
 * A transaction entry representing a block with balance changes
 */
export interface TransactionEntry {
    block: number;
    transactionBlock?: number | null;
    timestamp?: number | null;
    transactionHashes?: string[];
    transactions?: any[];
    transfers?: TransferDetail[];
    balanceBefore?: BalanceSnapshot;
    balanceAfter?: BalanceSnapshot;
    changes: {
        nearChanged: boolean;
        nearDiff?: string;
        tokensChanged: Record<string, { start: string; end: string; diff: string }>;
        intentsChanged: Record<string, { start: string; end: string; diff: string }>;
        stakingChanged?: Record<string, { start: string; end: string; diff: string }>;
    };
}

/**
 * A verification result for balance connectivity between two records
 */
export interface VerificationResult {
    valid: boolean;
    errors: VerificationError[];
}

export interface VerificationError {
    type: 'near_balance_mismatch' | 'token_balance_mismatch' | 'intents_balance_mismatch' | 'staking_balance_mismatch';
    token?: string;
    pool?: string;
    expected: string;
    actual: string;
    message: string;
}

/**
 * A detected gap in the transaction history
 */
export interface Gap {
    /** Block number of the earlier record */
    startBlock: number;
    /** Block number of the later record */
    endBlock: number;
    /** The earlier transaction record */
    prevTransaction: TransactionEntry;
    /** The later transaction record */
    nextTransaction: TransactionEntry;
    /** Details about what changed in the gap */
    verification: VerificationResult;
}

/**
 * Summary of all gaps detected in the history
 */
export interface GapAnalysis {
    /** Total number of gaps detected */
    totalGaps: number;
    /** Gaps between existing records */
    internalGaps: Gap[];
    /** Gap from earliest record back to account creation (if balanceBefore is non-zero) */
    gapToCreation: Gap | null;
    /** Gap from latest record to current on-chain state (requires external balance check) */
    gapToPresent: Gap | null;
    /** Whether the history is complete (no gaps) */
    isComplete: boolean;
}

/**
 * Check if a transaction entry is a staking-only entry (synthetic staking reward).
 * Staking-only entries don't track NEAR/FT/intents balances and should be excluded from gap detection.
 */
export function isStakingOnlyEntry(tx: TransactionEntry): boolean {
    // Staking-only entries have:
    // - No transaction hashes (synthetic entry)
    // - stakingChanged in changes
    // - near balance of '0' (not tracked)
    const hasNoTxHashes = !tx.transactionHashes || tx.transactionHashes.length === 0;
    const hasStakingChanges = Boolean(tx.changes?.stakingChanged && Object.keys(tx.changes.stakingChanged).length > 0);
    const hasNoOtherChanges = !tx.changes?.nearChanged && 
        Object.keys(tx.changes?.tokensChanged || {}).length === 0 &&
        Object.keys(tx.changes?.intentsChanged || {}).length === 0;
    
    return hasNoTxHashes && hasStakingChanges && hasNoOtherChanges;
}

/**
 * Compare two balance snapshots and return verification result.
 * The expected balance is what we have after the previous record.
 * The actual balance is what we have before the current record.
 * 
 * For sparse balance representation:
 * - Only compare tokens that appear in BOTH snapshots
 * - If a token appears in only one snapshot, it's not considered a mismatch
 *   (sparse representation means the token wasn't queried, not that it's zero)
 */
export function compareBalances(
    expected: BalanceSnapshot | undefined,
    actual: BalanceSnapshot | undefined
): VerificationResult {
    const result: VerificationResult = {
        valid: true,
        errors: []
    };

    // Compare NEAR balance only if present in both snapshots
    // Special handling for sparse mode: '0' could mean "not queried"
    // Only compare if BOTH are non-zero (both were actually queried)
    const expectedNear = expected?.near;
    const actualNear = actual?.near;

    // Compare only if both are defined AND both are non-zero
    if (expectedNear !== undefined && actualNear !== undefined &&
        expectedNear !== '0' && actualNear !== '0') {
        if (expectedNear !== actualNear) {
            result.valid = false;
            result.errors.push({
                type: 'near_balance_mismatch',
                expected: expectedNear,
                actual: actualNear,
                message: `NEAR balance mismatch: expected ${expectedNear} but got ${actualNear}`
            });
        }
    }

    // Compare fungible token balances - only for tokens present in BOTH snapshots
    const expectedTokens = expected?.fungibleTokens || {};
    const actualTokens = actual?.fungibleTokens || {};
    const commonTokens = Object.keys(expectedTokens).filter(t => t in actualTokens);

    for (const token of commonTokens) {
        const expectedVal = expectedTokens[token] || '0';
        const actualVal = actualTokens[token] || '0';
        if (expectedVal !== actualVal) {
            result.valid = false;
            result.errors.push({
                type: 'token_balance_mismatch',
                token,
                expected: expectedVal,
                actual: actualVal,
                message: `Token ${token} balance mismatch: expected ${expectedVal} but got ${actualVal}`
            });
        }
    }

    // Compare intents token balances - only for tokens present in BOTH snapshots
    const expectedIntents = expected?.intentsTokens || {};
    const actualIntents = actual?.intentsTokens || {};
    const commonIntents = Object.keys(expectedIntents).filter(t => t in actualIntents);

    for (const token of commonIntents) {
        const expectedVal = expectedIntents[token] || '0';
        const actualVal = actualIntents[token] || '0';
        if (expectedVal !== actualVal) {
            result.valid = false;
            result.errors.push({
                type: 'intents_balance_mismatch',
                token,
                expected: expectedVal,
                actual: actualVal,
                message: `Intents token ${token} balance mismatch: expected ${expectedVal} but got ${actualVal}`
            });
        }
    }

    // Compare staking pool balances - only for pools present in BOTH snapshots
    const expectedStaking = expected?.stakingPools || {};
    const actualStaking = actual?.stakingPools || {};
    const commonPools = Object.keys(expectedStaking).filter(p => p in actualStaking);

    for (const pool of commonPools) {
        const expectedVal = expectedStaking[pool] || '0';
        const actualVal = actualStaking[pool] || '0';
        if (expectedVal !== actualVal) {
            result.valid = false;
            result.errors.push({
                type: 'staking_balance_mismatch',
                pool,
                expected: expectedVal,
                actual: actualVal,
                message: `Staking pool ${pool} balance mismatch: expected ${expectedVal} but got ${actualVal}`
            });
        }
    }

    return result;
}

/**
 * Check if a balance snapshot represents a zero/empty state (account not yet created).
 */
export function isZeroBalance(balance: BalanceSnapshot | undefined): boolean {
    if (!balance) return true;
    
    // Check NEAR
    if (balance.near && balance.near !== '0') return false;
    
    // Check fungible tokens
    for (const val of Object.values(balance.fungibleTokens || {})) {
        if (val && val !== '0') return false;
    }
    
    // Check intents tokens
    for (const val of Object.values(balance.intentsTokens || {})) {
        if (val && val !== '0') return false;
    }
    
    // Check staking pools
    for (const val of Object.values(balance.stakingPools || {})) {
        if (val && val !== '0') return false;
    }
    
    return true;
}

/**
 * Detect all gaps in a transaction history.
 * 
 * This is a pure function that operates on in-memory data.
 * It does NOT perform any I/O or blockchain queries.
 * 
 * @param transactions - Array of transaction entries (will be sorted internally)
 * @param currentBalance - Optional: current on-chain balance to detect gap to present
 * @returns Analysis of all detected gaps
 */
export function detectGaps(
    transactions: TransactionEntry[],
    currentBalance?: BalanceSnapshot
): GapAnalysis {
    const analysis: GapAnalysis = {
        totalGaps: 0,
        internalGaps: [],
        gapToCreation: null,
        gapToPresent: null,
        isComplete: true
    };

    if (transactions.length === 0) {
        // No data - we can't detect gaps without at least one record
        // The caller needs to fetch initial data first
        return analysis;
    }

    // Sort transactions by block and filter out staking-only entries
    // Staking-only entries are synthetic (no actual on-chain tx) and don't track NEAR/FT/intents balances
    const sortedTransactions = [...transactions]
        .filter(tx => !isStakingOnlyEntry(tx))
        .sort((a, b) => a.block - b.block);

    if (sortedTransactions.length === 0) {
        return analysis;
    }

    // 1. Detect internal gaps (between consecutive records)
    for (let i = 1; i < sortedTransactions.length; i++) {
        const prevTx = sortedTransactions[i - 1]!;
        const currTx = sortedTransactions[i]!;

        const verification = compareBalances(prevTx.balanceAfter, currTx.balanceBefore);

        if (!verification.valid) {
            analysis.internalGaps.push({
                startBlock: prevTx.block,
                endBlock: currTx.block,
                prevTransaction: prevTx,
                nextTransaction: currTx,
                verification
            });
            analysis.isComplete = false;
        }
    }

    // 2. Detect gap to account creation (if earliest balance is non-zero)
    const earliestTx = sortedTransactions[0]!;
    if (!isZeroBalance(earliestTx.balanceBefore)) {
        // Create a synthetic "zero balance" record representing account creation
        const zeroBalance: BalanceSnapshot = {
            near: '0',
            fungibleTokens: {},
            intentsTokens: {},
            stakingPools: {}
        };
        
        const verification = compareBalances(zeroBalance, earliestTx.balanceBefore);
        
        analysis.gapToCreation = {
            startBlock: 0, // Account creation block (unknown)
            endBlock: earliestTx.block,
            prevTransaction: {
                block: 0,
                balanceBefore: zeroBalance,
                balanceAfter: zeroBalance,
                changes: { nearChanged: false, tokensChanged: {}, intentsChanged: {} }
            } as TransactionEntry,
            nextTransaction: earliestTx,
            verification
        };
        analysis.isComplete = false;
    }

    // 3. Detect gap to present (if current balance is provided and differs from latest)
    if (currentBalance) {
        const latestTx = sortedTransactions[sortedTransactions.length - 1]!;
        const verification = compareBalances(latestTx.balanceAfter, currentBalance);

        if (!verification.valid) {
            analysis.gapToPresent = {
                startBlock: latestTx.block,
                endBlock: Infinity, // Current block (unknown)
                prevTransaction: latestTx,
                nextTransaction: {
                    block: Infinity,
                    balanceBefore: currentBalance,
                    balanceAfter: currentBalance,
                    changes: { nearChanged: false, tokensChanged: {}, intentsChanged: {} }
                } as TransactionEntry,
                verification
            };
            analysis.isComplete = false;
        }
    }

    // Calculate total gaps
    analysis.totalGaps = analysis.internalGaps.length + 
        (analysis.gapToCreation ? 1 : 0) + 
        (analysis.gapToPresent ? 1 : 0);

    return analysis;
}

/**
 * Get a summary of which tokens/assets changed in a gap.
 * Useful for knowing which tokens to query when filling the gap.
 */
export function getGapChangedAssets(gap: Gap): {
    nearChanged: boolean;
    fungibleTokensChanged: string[];
    intentsTokensChanged: string[];
    stakingPoolsChanged: string[];
} {
    const result = {
        nearChanged: false,
        fungibleTokensChanged: [] as string[],
        intentsTokensChanged: [] as string[],
        stakingPoolsChanged: [] as string[]
    };

    for (const error of gap.verification.errors) {
        switch (error.type) {
            case 'near_balance_mismatch':
                result.nearChanged = true;
                break;
            case 'token_balance_mismatch':
                if (error.token) result.fungibleTokensChanged.push(error.token);
                break;
            case 'intents_balance_mismatch':
                if (error.token) result.intentsTokensChanged.push(error.token);
                break;
            case 'staking_balance_mismatch':
                if (error.pool) result.stakingPoolsChanged.push(error.pool);
                break;
        }
    }

    return result;
}

/**
 * Get all unique tokens that appear in a list of gaps.
 * Useful for knowing which tokens to track when filling gaps.
 */
export function getAllTokensFromGaps(gaps: Gap[]): {
    fungibleTokens: string[];
    intentsTokens: string[];
    stakingPools: string[];
} {
    const fungibleTokens = new Set<string>();
    const intentsTokens = new Set<string>();
    const stakingPools = new Set<string>();

    for (const gap of gaps) {
        const changed = getGapChangedAssets(gap);
        changed.fungibleTokensChanged.forEach(t => fungibleTokens.add(t));
        changed.intentsTokensChanged.forEach(t => intentsTokens.add(t));
        changed.stakingPoolsChanged.forEach(t => stakingPools.add(t));
    }

    return {
        fungibleTokens: [...fungibleTokens],
        intentsTokens: [...intentsTokens],
        stakingPools: [...stakingPools]
    };
}

// ============================================================================
// V2 FORMAT SUPPORT (BalanceChangeRecord[])
// ============================================================================

/**
 * Gap analysis result for V2 format.
 * Simplified compared to V1 since V2 is already per-token.
 */
export interface GapAnalysisV2 {
    /** Total number of gaps detected across all tokens */
    totalGaps: number;
    /** Per-token gaps detected */
    tokenGaps: TokenGap[];
    /** Unique tokens with gaps */
    tokensWithGaps: string[];
    /** Whether the history is complete (no gaps) */
    isComplete: boolean;
}

/**
 * Detect gaps in V2 format (BalanceChangeRecord[]).
 *
 * For V2 format, we use the per-token gap detection from balance-tracker.ts.
 * This is much simpler because each record is already per-token.
 *
 * @param records - Array of BalanceChangeRecord objects
 * @returns GapAnalysisV2 with detected gaps
 */
export function detectGapsV2(records: BalanceChangeRecord[]): GapAnalysisV2 {
    const tokenGaps = detectTokenGaps(records);

    const tokensWithGaps = [...new Set(tokenGaps.map(g => g.token_id))];

    return {
        totalGaps: tokenGaps.length,
        tokenGaps,
        tokensWithGaps,
        isComplete: tokenGaps.length === 0
    };
}

/**
 * Convert V1 Gap[] to V2-compatible TokenGap[].
 * Useful for transitioning code from V1 to V2.
 */
export function convertGapsToTokenGaps(gaps: Gap[]): TokenGap[] {
    const tokenGaps: TokenGap[] = [];

    for (const gap of gaps) {
        for (const error of gap.verification.errors) {
            let tokenId: string;

            switch (error.type) {
                case 'near_balance_mismatch':
                    tokenId = 'near';
                    break;
                case 'token_balance_mismatch':
                    tokenId = error.token || 'unknown';
                    break;
                case 'intents_balance_mismatch':
                    tokenId = error.token || 'unknown';
                    break;
                case 'staking_balance_mismatch':
                    tokenId = error.pool || 'unknown';
                    break;
                default:
                    continue;
            }

            tokenGaps.push({
                token_id: tokenId,
                from_block: gap.startBlock,
                to_block: gap.endBlock,
                expected_balance: error.expected,
                actual_balance: error.actual,
                diff: (BigInt(error.actual) - BigInt(error.expected)).toString()
            });
        }
    }

    return tokenGaps;
}

// Re-export TokenGap type from balance-tracker for convenience
export type { TokenGap, BalanceChangeRecord };
