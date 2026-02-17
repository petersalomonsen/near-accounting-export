import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { isStakingPool, EPOCH_LENGTH } from '../../scripts/balance-tracker.js';

describe('Staking Helpers', () => {
    describe('isStakingPool', () => {
        it('should match .poolv1.near pattern', () => {
            assert.ok(isStakingPool('epic.poolv1.near'));
            assert.ok(isStakingPool('astro-stakers.poolv1.near'));
            assert.ok(isStakingPool('01node.poolv1.near'));
        });

        it('should match .pool.near pattern', () => {
            assert.ok(isStakingPool('aurora.pool.near'));
        });

        it('should match .poolv2.near pattern', () => {
            assert.ok(isStakingPool('some.poolv2.near'));
        });

        it('should NOT match non-staking contracts', () => {
            assert.ok(!isStakingPool('near'));
            assert.ok(!isStakingPool('wrap.near'));
            assert.ok(!isStakingPool('usdt.tether-token.near'));
            assert.ok(!isStakingPool('poolparty.near'));
        });

        it('should handle empty string', () => {
            assert.ok(!isStakingPool(''));
        });
    });

    describe('EPOCH_LENGTH', () => {
        it('should be 43200', () => {
            assert.equal(EPOCH_LENGTH, 43200);
        });
    });
});
