// Test case for staking pool balance inclusion in balanceBefore/balanceAfter
// Tests that when a transaction touches a staking pool (deposit_and_stake, withdraw_all, etc.),
// the staking pool balance is included in both balanceBefore and balanceAfter

import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { findBalanceChangingTransaction } from '../../scripts/balance-tracker.js';
import { enrichWithStakingPoolBalances } from '../../scripts/get-account-history.js';
import type { TransactionEntry } from '../../scripts/get-account-history.js';

describe('Staking Pool Balance in Transactions', () => {
    /**
     * Test case for petermusic.near deposit_and_stake transaction
     *
     * Transaction: ADRV4zdG7fPXQE6dSYwTkzGsueEnitznKecp89CjaAsm
     * Account: petermusic.near
     * Staking pool: astro-stakers.poolv1.near
     * Amount: 1000 NEAR
     * Block: 161869264
     *
     * Previous epoch (block 161827200):
     * - stakingPools: { "astro-stakers.poolv1.near": "442813251789670864000720706" }
     *
     * Transaction block (161869264):
     * - deposit_and_stake: 1000 NEAR to astro-stakers.poolv1.near
     * - NEAR balance drops from ~1008.5 to ~8.5 NEAR
     * - Staking pool receipt executes at block 161869265
     * - Expected balanceBefore.stakingPools (at block): { "astro-stakers.poolv1.near": "442848977056627936899944429" }
     * - Expected balanceAfter.stakingPools (at block+1): { "astro-stakers.poolv1.near": "1442848977056627936899944430" }
     *
     * Next epoch (block 161870400):
     * - stakingPools: { "astro-stakers.poolv1.near": "1442967093064936394199457858" }
     */
    describe('enrichWithStakingPoolBalances for deposit_and_stake transaction', () => {
        const accountId = 'petermusic.near';
        const stakingPool = 'astro-stakers.poolv1.near';
        const depositBlock = 161869264;

        it('should populate both balanceBefore.stakingPools and balanceAfter.stakingPools with real blockchain data', async () => {
            // First, get the real transaction data from the blockchain
            const txInfo = await findBalanceChangingTransaction(accountId, depositBlock);

            // Verify we found the expected transaction
            assert.ok(txInfo.transactionHashes.includes('ADRV4zdG7fPXQE6dSYwTkzGsueEnitznKecp89CjaAsm'),
                'Should find the deposit_and_stake transaction');

            // Find the staking transfer
            const stakingTransfer = txInfo.transfers.find(t =>
                t.counterparty === stakingPool &&
                t.memo === 'deposit_and_stake'
            );
            assert.ok(stakingTransfer, 'Should find deposit_and_stake transfer');
            assert.equal(stakingTransfer!.amount, '1000000000000000000000000000', 'Should be 1000 NEAR deposit');

            // Create a transaction entry from the real data
            const entry: TransactionEntry = {
                block: depositBlock,
                timestamp: null,
                transactionHashes: txInfo.transactionHashes,
                transactions: txInfo.transactions,
                transfers: txInfo.transfers,
                balanceBefore: {
                    near: '1008506877444837788000000001',
                    fungibleTokens: {},
                    intentsTokens: {},
                    stakingPools: {}
                },
                balanceAfter: {
                    near: '8501757738090454900000001',
                    fungibleTokens: {},
                    intentsTokens: {},
                    stakingPools: {}
                },
                changes: {
                    nearChanged: true,
                    nearDiff: '-1000005119706747333100000000',
                    tokensChanged: {},
                    intentsChanged: {}
                }
            };

            // Call the enrichment function - this is what we're testing
            await enrichWithStakingPoolBalances(accountId, entry);

            // Verify balanceBefore.stakingPools is populated
            assert.ok(entry.balanceBefore?.stakingPools, 'balanceBefore.stakingPools should exist');
            assert.ok(entry.balanceBefore!.stakingPools![stakingPool],
                `balanceBefore.stakingPools should have ${stakingPool}`);

            // Verify exact balanceBefore value (blockchain data is immutable)
            assert.equal(entry.balanceBefore!.stakingPools![stakingPool], '442848977056627936899944429',
                'balanceBefore should have exact staking balance at block');

            // Verify balanceAfter.stakingPools is populated
            assert.ok(entry.balanceAfter?.stakingPools, 'balanceAfter.stakingPools should exist');
            assert.ok(entry.balanceAfter!.stakingPools![stakingPool],
                `balanceAfter.stakingPools should have ${stakingPool}`);

            // Verify exact balanceAfter value (blockchain data is immutable)
            assert.equal(entry.balanceAfter!.stakingPools![stakingPool], '1442848977056627936899944430',
                'balanceAfter should have exact staking balance at block+1');

            // Verify the difference is exactly 1000 NEAR plus 1 yoctoNEAR (deposit + tiny reward)
            const balanceBefore = BigInt(entry.balanceBefore!.stakingPools![stakingPool]);
            const balanceAfter = BigInt(entry.balanceAfter!.stakingPools![stakingPool]);
            const diff = balanceAfter - balanceBefore;
            assert.equal(diff.toString(), '1000000000000000000000000001',
                'Difference should be 1000 NEAR + 1 yoctoNEAR');
        });
    });
});
