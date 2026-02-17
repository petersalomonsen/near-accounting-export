// Test case for balance snapshot normalization
// Ensures balanceBefore and balanceAfter contain the same token keys for consistent comparison
import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { normalizeBalanceSnapshots, getStakingPoolBalances } from '../../scripts/balance-tracker.js';

describe('Balance Snapshot Normalization', function() {
    // Extend timeout for RPC calls
    this.timeout(120000);

    /**
     * Test case for petersalomonsen.near staking snapshot
     *
     * Account: petersalomonsen.near
     * Block: 182347200 (epoch boundary staking snapshot)
     *
     * This is a staking reward snapshot where the account has multiple staking pools.
     * Before normalization, only pools with changes appear in both snapshots.
     * After normalization, ALL pools should appear in BOTH snapshots.
     *
     * From the downloaded data at block 182347200:
     * - balanceBefore.stakingPools had 1 pool: binancenode1.poolv1.near
     * - balanceAfter.stakingPools had 5 pools: lunanova, zavodil, openshards, npro, binancenode1
     *
     * After normalization, both should have all 5 pools.
     */
    it('should normalize staking pool snapshots to have the same pool keys', async () => {
        const accountId = 'petersalomonsen.near';
        const testBlock = 182347200;

        // Known staking pools for this account from the downloaded data
        const knownPools = [
            'lunanova.poolv1.near',
            'zavodil.poolv1.near',
            'openshards.poolv1.near',
            'npro.poolv1.near',
            'binancenode1.poolv1.near'
        ];

        // Query staking pool balances at block (before) and block+1 (after)
        const stakingBalancesBefore = await getStakingPoolBalances(accountId, testBlock, knownPools);
        const stakingBalancesAfter = await getStakingPoolBalances(accountId, testBlock + 1, knownPools);

        // Create balance snapshots (simulating asymmetric data as seen in downloaded file)
        const before = {
            near: '0',
            fungibleTokens: {},
            intentsTokens: {},
            stakingPools: { 'binancenode1.poolv1.near': stakingBalancesBefore['binancenode1.poolv1.near'] || '0' }
        };

        const after = {
            near: '0',
            fungibleTokens: {},
            intentsTokens: {},
            stakingPools: stakingBalancesAfter
        };

        // Verify asymmetry before normalization
        assert.equal(Object.keys(before.stakingPools).length, 1, 'Before should have 1 pool');
        assert.equal(Object.keys(after.stakingPools).length, 5, 'After should have 5 pools');

        // Apply normalization
        const { before: normalizedBefore, after: normalizedAfter } = normalizeBalanceSnapshots(before, after);

        // Verify symmetry after normalization
        const beforeStakingKeys = Object.keys(normalizedBefore.stakingPools || {}).sort();
        const afterStakingKeys = Object.keys(normalizedAfter.stakingPools || {}).sort();

        assert.deepEqual(beforeStakingKeys, afterStakingKeys,
            'stakingPools should have the same keys in both snapshots');

        // Verify all 5 pools are present in both
        assert.equal(beforeStakingKeys.length, 5, 'normalizedBefore should have 5 pools');
        assert.equal(afterStakingKeys.length, 5, 'normalizedAfter should have 5 pools');

        for (const pool of knownPools) {
            assert.ok(pool in (normalizedBefore.stakingPools || {}),
                `Pool ${pool} should be in normalizedBefore.stakingPools`);
            assert.ok(pool in (normalizedAfter.stakingPools || {}),
                `Pool ${pool} should be in normalizedAfter.stakingPools`);
        }

        // Verify original binancenode1 value is preserved in before
        assert.equal(
            normalizedBefore.stakingPools?.['binancenode1.poolv1.near'],
            stakingBalancesBefore['binancenode1.poolv1.near'],
            'Original binancenode1 value should be preserved in before'
        );

        // Verify the 4 missing pools in before are now '0'
        const poolsMissingInBefore = ['lunanova.poolv1.near', 'zavodil.poolv1.near', 'openshards.poolv1.near', 'npro.poolv1.near'];
        for (const pool of poolsMissingInBefore) {
            assert.equal(
                normalizedBefore.stakingPools?.[pool],
                '0',
                `Pool ${pool} should be '0' in normalizedBefore (was missing)`
            );
        }

        // Verify all after values are preserved
        for (const pool of knownPools) {
            assert.equal(
                normalizedAfter.stakingPools?.[pool],
                stakingBalancesAfter[pool],
                `Pool ${pool} value should be preserved in normalizedAfter`
            );
        }
    });
});
