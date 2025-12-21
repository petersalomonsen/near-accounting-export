// Test cases for staking balance tracking
// Tests the cross-contract call scenario where balance changes at a different block than receipt execution
import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { findBalanceChangingTransaction, getAllBalances, getStakingPoolBalances, findStakingBalanceChanges } from '../../scripts/balance-tracker.js';

describe('Staking Balance Tracking', () => {
    /**
     * Test case for DAO staking transaction via act_proposal
     * 
     * Transaction: 7oSsqUsFmrQsQcomd6Tk5V4SghLdZ4FHW9ceFpGGXimU
     * Account: webassemblymusic-treasury.sputnik-dao.near
     * Staking pool: astro-stakers.poolv1.near
     * Amount: 1000 NEAR
     * 
     * This tests a cross-contract call scenario where:
     * - Block 161048664: act_proposal executes on DAO, creates outgoing receipt with deposit
     *   Balance is immediately deducted (1026 NEAR -> 26 NEAR)
     * - Block 161048665: deposit_and_stake receipt executes on staking pool
     * 
     * The balance change is detected at block 161048664, but the receipt with
     * the deposit details (counterparty, amount) is in block 161048665.
     * This is because NEAR deducts the deposit when the outgoing receipt is CREATED,
     * not when it EXECUTES.
     */
    describe('DAO staking via act_proposal', () => {
        it('should detect balance change at block 161048664', async () => {
            // Verify balance at blocks around the transaction
            const balanceBefore = await getAllBalances(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048663,
                null, null, true
            );
            const balanceAtChange = await getAllBalances(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048664,
                null, null, true
            );
            const balanceAfter = await getAllBalances(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048665,
                null, null, true
            );

            // Balance should drop ~1000 NEAR at block 161048664
            const beforeNear = BigInt(balanceBefore.near);
            const atChangeNear = BigInt(balanceAtChange.near);
            const afterNear = BigInt(balanceAfter.near);

            // ~1000 NEAR difference between 161048663 and 161048664
            const diff = beforeNear - atChangeNear;
            assert.ok(diff > BigInt('999000000000000000000000000'), 'Should have > 999 NEAR difference');
            assert.ok(diff < BigInt('1001000000000000000000000000'), 'Should have < 1001 NEAR difference');

            // No change between 161048664 and 161048665 (receipt executes but balance already changed)
            assert.equal(atChangeNear, afterNear, 'Balance should be same at 161048664 and 161048665');
            
            console.log('Balance before (161048663):', balanceBefore.near);
            console.log('Balance at change (161048664):', balanceAtChange.near);
            console.log('Balance after (161048665):', balanceAfter.near);
            console.log('Difference:', diff.toString());
        });

        it('should find staking transfer details by checking subsequent blocks', async () => {
            // findBalanceChangingTransaction should find the deposit_and_stake transfer
            // even though the balance change is at 161048664 and the receipt is at 161048665
            const txInfo = await findBalanceChangingTransaction(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048664
            );

            console.log('Transaction hashes:', txInfo.transactionHashes);
            console.log('Transfers found:', txInfo.transfers.length);

            // Should find the staking transfer
            assert.ok(txInfo.transfers.length > 0, 'Should find at least one transfer');

            const stakingTransfer = txInfo.transfers.find(t => 
                t.counterparty === 'astro-stakers.poolv1.near' &&
                t.memo === 'deposit_and_stake'
            );

            assert.ok(stakingTransfer, 'Should find staking transfer to astro-stakers.poolv1.near');
            assert.equal(stakingTransfer!.type, 'near');
            assert.equal(stakingTransfer!.direction, 'out');
            assert.equal(stakingTransfer!.amount, '1000000000000000000000000000'); // 1000 NEAR
            assert.equal(stakingTransfer!.counterparty, 'astro-stakers.poolv1.near');
            assert.equal(stakingTransfer!.memo, 'deposit_and_stake');

            console.log('Staking transfer found:', stakingTransfer);
        });

        it('should include correct transaction hash', async () => {
            const txInfo = await findBalanceChangingTransaction(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048664
            );

            // The transaction hash should be the act_proposal transaction
            assert.ok(
                txInfo.transactionHashes.includes('7oSsqUsFmrQsQcomd6Tk5V4SghLdZ4FHW9ceFpGGXimU'),
                'Should include the act_proposal transaction hash'
            );
        });
    });

    describe('Staking pool balance queries', () => {
        it('should get staking pool balance at specific block', async () => {
            // After the staking transaction at block 161048665, the account should have ~1000 NEAR staked
            const balances = await getStakingPoolBalances(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048665,
                ['astro-stakers.poolv1.near']
            );

            console.log('Staking pool balances at 161048665:', balances);

            // Should have ~1000 NEAR staked (1000000000000000000000000000 yoctoNEAR)
            const stakedBalance = BigInt(balances['astro-stakers.poolv1.near'] || '0');
            assert.ok(stakedBalance >= BigInt('999000000000000000000000000'), 'Should have >= 999 NEAR staked');
            assert.ok(stakedBalance <= BigInt('1001000000000000000000000000'), 'Should have <= 1001 NEAR staked');
        });

        it('should return 0 for pool with no stake', async () => {
            const balances = await getStakingPoolBalances(
                'webassemblymusic-treasury.sputnik-dao.near',
                161048660, // Before the staking transaction
                ['astro-stakers.poolv1.near']
            );

            console.log('Staking pool balances at 161048660 (before staking):', balances);

            // Should have 0 staked before the transaction
            assert.equal(balances['astro-stakers.poolv1.near'], '0');
        });

        it('should find staking balance changes at epoch boundaries', async () => {
            // Test a range that spans at least one epoch after staking
            // Block 161048665 is when staking happened
            // Epoch length is 43200 blocks, so next epoch boundary after 161048665
            // is at 161049600 (161049600 / 43200 = 3727.5... -> next is 3728 * 43200 = 161049600)
            
            // Let's check a smaller range first - just detect the initial stake
            const startBlock = 161048660; // Before staking
            const endBlock = 161048670; // After staking
            
            const changes = await findStakingBalanceChanges(
                'webassemblymusic-treasury.sputnik-dao.near',
                startBlock,
                endBlock,
                ['astro-stakers.poolv1.near']
            );

            console.log('Staking changes between', startBlock, 'and', endBlock, ':', changes);

            // Should detect the stake at the end of range (since there's no epoch boundary in between)
            assert.ok(changes.length > 0, 'Should find at least one staking change');
            
            const stakingChange = changes.find(c => c.pool === 'astro-stakers.poolv1.near');
            assert.ok(stakingChange, 'Should have change for astro-stakers.poolv1.near');
            
            // Start balance should be 0, end balance should be ~1000 NEAR
            assert.equal(stakingChange!.startBalance, '0');
            assert.ok(BigInt(stakingChange!.endBalance) > BigInt('999000000000000000000000000'));
        });
    });
});
