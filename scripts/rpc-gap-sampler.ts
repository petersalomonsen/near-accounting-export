// RPC gap-sampler — the "RPC only for gaps" fallback.
//
// The transfers API gives every TRANSFER (with block-level balances), so the
// ledger is built from it with zero RPC. What the API can't see are NON-transfer
// balance changes — wNEAR/bridge mint & burn, unwraps. Those show up as a
// per-token block-level gap: the balance jumps between two API records with no
// transfer in between.
//
// This sampler resolves such a gap with a BOUNDED binary search over RPC: the
// balance is `expected_balance` at from_block and `actual_balance` at to_block,
// so we bisect the (from_block, to_block] range to find the exact block where it
// changed, then emit one real record there. Cost is ~log2(gap size) RPC calls,
// and only for the rare genuine gaps — not for every block like the old path.

import { getAllBalances } from './balance-tracker.js';
import { getBlockTimestamp } from './rpc.js';
import type { BalanceChangeRecord, TokenGap } from './balance-tracker.js';
import type { GapSampler } from './fastnear-transfers-api.js';

/** Reads the on-chain balance of one owned token (FT / intents / NEAR) at a block. */
export type BalanceAt = (token: string, block: number) => Promise<string>;
type BlockTime = (block: number) => Promise<number | null>;

/** Default BalanceAt backed by getAllBalances (one RPC view per call). */
export function rpcBalanceAt(accountId: string): BalanceAt {
    return async (token, block) => {
        if (token === 'near') {
            return (await getAllBalances(accountId, block, null, null, true, null)).near;
        }
        if (token.startsWith('nep141:') || token.startsWith('nep245:')) {
            const snap = await getAllBalances(accountId, block, null, [token], false, null);
            return snap.intentsTokens[token] ?? '0';
        }
        // bare FT contract
        const snap = await getAllBalances(accountId, block, [token], null, false, null);
        return snap.fungibleTokens[token] ?? '0';
    };
}

export interface RpcGapSamplerOptions {
    balanceAt?: BalanceAt;       // injectable for tests
    blockTimestamp?: BlockTime;  // injectable for tests
    maxBisectSteps?: number;     // safety cap on RPC per gap
}

/**
 * Build a GapSampler that resolves a non-transfer balance gap to a real record
 * via bounded binary search. Returns [] if it can't pin the change down (the gap
 * is then left rather than guessed).
 */
export function makeRpcGapSampler(accountId: string, opts: RpcGapSamplerOptions = {}): GapSampler {
    const balanceAt = opts.balanceAt ?? rpcBalanceAt(accountId);
    const blockTime = opts.blockTimestamp ?? getBlockTimestamp;
    const maxSteps = opts.maxBisectSteps ?? 32;

    return async (gap: TokenGap): Promise<BalanceChangeRecord[]> => {
        const expected = gap.expected_balance; // balance at/after from_block
        const actual = gap.actual_balance;     // balance at/before to_block
        let lo = gap.from_block;                // balance(lo) === expected
        let hi = gap.to_block;                  // balance(hi) === actual

        // Bisect to the first block whose balance is no longer `expected`.
        let steps = 0;
        while (hi - lo > 1 && steps < maxSteps) {
            steps++;
            const mid = Math.floor((lo + hi) / 2);
            const bal = await balanceAt(gap.token_id, mid);
            if (bal === expected) lo = mid; else hi = mid;
        }
        if (hi - lo !== 1) return []; // couldn't isolate a single change block

        const ts = await blockTime(hi);
        return [{
            block_height: hi,
            block_timestamp: ts != null ? new Date(Math.floor(ts / 1_000_000)).toISOString() : null,
            tx_hash: null,
            tx_block: null,
            signer_id: null,
            receiver_id: null,
            predecessor_id: null,
            token_id: gap.token_id,
            receipt_id: null,
            counterparty: null,
            amount: (BigInt(actual) - BigInt(expected)).toString(),
            balance_before: expected,
            balance_after: actual,
        }];
    };
}
