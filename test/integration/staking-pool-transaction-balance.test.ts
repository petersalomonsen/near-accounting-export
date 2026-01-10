// Test case for staking pool balance inclusion in balanceBefore/balanceAfter
// Tests that when a transaction touches a staking pool (deposit_and_stake, withdraw_all, etc.),
// the staking pool balance is included in both balanceBefore and balanceAfter

import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { findBalanceChangingTransaction, getStakingPoolBalances } from '../../scripts/balance-tracker.js';

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
     * - Expected balanceBefore.stakingPools: { "astro-stakers.poolv1.near": "~442.8 NEAR" }
     * - Expected balanceAfter.stakingPools: { "astro-stakers.poolv1.near": "~1442.8 NEAR" }
     * 
     * Next epoch (block 161870400):
     * - stakingPools: { "astro-stakers.poolv1.near": "1442967093064936394199457858" }
     */
    describe('deposit_and_stake transaction for petermusic.near', () => {
        const accountId = 'petermusic.near';
        const stakingPool = 'astro-stakers.poolv1.near';
        const depositBlock = 161869264;
        
        it('should find deposit_and_stake transaction with correct transfers', async () => {
            const txInfo = await findBalanceChangingTransaction(accountId, depositBlock);
            
            // Should find the transaction
            assert.ok(txInfo.transactionHashes.length > 0, 'Should find transaction hashes');
            assert.ok(txInfo.transactions.length > 0, 'Should find transactions');
            
            // Should have transfers
            assert.ok(txInfo.transfers.length > 0, 'Should find transfers');
            
            // Should find NEAR transfer to staking pool with deposit_and_stake memo
            const stakingTransfer = txInfo.transfers.find(t => 
                t.counterparty === stakingPool &&
                t.memo === 'deposit_and_stake'
            );
            
            assert.ok(stakingTransfer, 'Should find staking transfer to astro-stakers.poolv1.near');
            assert.equal(stakingTransfer!.type, 'near');
            assert.equal(stakingTransfer!.direction, 'out');
            assert.equal(stakingTransfer!.amount, '1000000000000000000000000000'); // 1000 NEAR
            
            console.log('Transaction info:', {
                hashes: txInfo.transactionHashes,
                block: txInfo.transactionBlock,
                transfers: txInfo.transfers.length
            });
        });
        
        it('should have staking pool balance at block-1 (balanceBefore)', async () => {
            // Query staking pool balance at block-1 (this should be what balanceBefore contains)
            const balanceAtBlockBefore = await getStakingPoolBalances(
                accountId,
                depositBlock - 1,
                [stakingPool]
            );
            
            console.log('Staking balance at block-1:', balanceAtBlockBefore);
            
            // Should have ~442.8 NEAR staked before the deposit
            const stakedBalance = BigInt(balanceAtBlockBefore[stakingPool] || '0');
            assert.ok(stakedBalance > 0n, 'Should have existing stake before deposit');
            assert.ok(stakedBalance >= BigInt('442000000000000000000000000'), 'Should have >= 442 NEAR staked');
            assert.ok(stakedBalance <= BigInt('443000000000000000000000000'), 'Should have <= 443 NEAR staked');
        });
        
        it('should have staking pool balance at block (balanceAfter)', async () => {
            // Query staking pool balance at block (this should be what balanceAfter contains)
            const balanceAtBlock = await getStakingPoolBalances(
                accountId,
                depositBlock,
                [stakingPool]
            );
            
            console.log('Staking balance at block:', balanceAtBlock);
            
            // Should have ~1442.8 NEAR staked after the deposit
            const stakedBalance = BigInt(balanceAtBlock[stakingPool] || '0');
            assert.ok(stakedBalance > BigInt('1442000000000000000000000000'), 'Should have >= 1442 NEAR staked');
            assert.ok(stakedBalance <= BigInt('1443000000000000000000000000'), 'Should have <= 1443 NEAR staked');
        });
        
        it('should verify the 1000 NEAR deposit by comparing balances', async () => {
            // Get balance before and after
            const balanceBefore = await getStakingPoolBalances(accountId, depositBlock - 1, [stakingPool]);
            const balanceAfter = await getStakingPoolBalances(accountId, depositBlock, [stakingPool]);
            
            const before = BigInt(balanceBefore[stakingPool] || '0');
            const after = BigInt(balanceAfter[stakingPool] || '0');
            const diff = after - before;
            
            console.log('Balance change:', {
                before: before.toString(),
                after: after.toString(),
                diff: diff.toString()
            });
            
            // The difference should be ~1000 NEAR (allowing for small rounding/rewards)
            assert.ok(diff >= BigInt('999000000000000000000000000'), 'Diff should be >= 999 NEAR');
            assert.ok(diff <= BigInt('1001000000000000000000000000'), 'Diff should be <= 1001 NEAR');
        });
    });
});
