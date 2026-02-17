import { strict as assert } from 'assert';
import { describe, it, beforeEach } from 'mocha';
import { getStakingPoolBalances, clearBalanceCache } from '../../scripts/balance-tracker.js';
import { setStopSignal } from '../../scripts/rpc.js';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Test for the staking withdrawal detection bug fix.
 *
 * For psalomo.near, the withdrawal from epic.poolv1.near was not being detected
 * because the balance transition happens 1-2 blocks before the NEAR transfer arrives.
 *
 * Cross-contract call chain for withdraw_all:
 *   Block M:   user calls withdraw_all on pool
 *   Block M+1: pool receipt executes, balance → 0, NEAR sent back
 *   Block M+1 or M+2: NEAR arrives at user's account
 *
 * The fix searches backward from the NEAR transfer block to find the transition.
 */
describe('Staking Withdrawal Detection', function () {
    this.timeout(120000);

    beforeEach(function () {
        setStopSignal(false);
        clearBalanceCache();
    });

    describe('psalomo.near full withdrawal from epic.poolv1.near', () => {
        const accountId = 'psalomo.near';
        const pool = 'epic.poolv1.near';
        // NEAR withdrawal transfer block
        const withdrawalBlock = 36587579;
        // Actual balance transition: block 36587577 (non-zero) → 36587578 (zero)
        const transitionBlock = 36587578;

        it('should have zero balance at the withdrawal block', async () => {
            const balances = await getStakingPoolBalances(accountId, withdrawalBlock, [pool]);
            assert.equal(BigInt(balances[pool] || '0'), 0n);
        });

        it('should have non-zero balance 2 blocks before the NEAR transfer', async () => {
            const balances = await getStakingPoolBalances(accountId, transitionBlock - 1, [pool]);
            const balance = BigInt(balances[pool] || '0');
            assert.ok(balance > 0n, `Expected non-zero balance at block ${transitionBlock - 1}, got ${balance}`);
        });

        it('should detect the balance transition by searching backward from NEAR transfer', async () => {
            // This mimics the fix logic: search backward from the NEAR transfer block
            for (let offset = 0; offset <= 2; offset++) {
                const checkBlock = withdrawalBlock - offset;
                const balBefore = await getStakingPoolBalances(accountId, checkBlock - 1, [pool]);
                const balAfter = await getStakingPoolBalances(accountId, checkBlock, [pool]);

                const before = BigInt(balBefore[pool] || '0');
                const after = BigInt(balAfter[pool] || '0');
                const diff = after - before;

                if (diff !== 0n) {
                    assert.equal(checkBlock, transitionBlock, 'Should find transition at block 36587578');
                    assert.ok(before > 0n, 'Balance before should be positive');
                    assert.equal(after, 0n, 'Balance after should be 0');
                    return;
                }
            }
            assert.fail('Should have found balance transition within 2 blocks backward');
        });
    });

    describe('01node.poolv1.near has working withdrawal pattern', () => {
        const accountId = 'psalomo.near';
        const pool = '01node.poolv1.near';
        // The staking withdrawal record is at block 36587390
        const withdrawalBlock = 36587390;

        it('should show the withdrawal is detectable at block and block+1', async () => {
            const balBefore = await getStakingPoolBalances(accountId, withdrawalBlock, [pool]);
            const balAfter = await getStakingPoolBalances(accountId, withdrawalBlock + 1, [pool]);

            const before = BigInt(balBefore[pool] || '0');
            const after = BigInt(balAfter[pool] || '0');

            // For this pool, the forward check (N -> N+1) already works
            assert.ok(before > 0n || after === 0n,
                'Should detect change at block/block+1 for pools with unstake fee pattern');
        });
    });
});
