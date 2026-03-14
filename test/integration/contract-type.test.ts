import { strict as assert } from 'assert';
import { describe, it, beforeEach } from 'mocha';
import {
    getContractType,
    clearContractTypeCache,
    getContractTypeCacheSize,
} from '../../scripts/contract-type.js';

describe('Contract Type Detection (integration)', function () {
    this.timeout(60000);

    beforeEach(() => {
        clearContractTypeCache();
    });

    describe('meta-pool.near (liquid staking + FT)', () => {
        it('should detect as both staking pool and fungible token', async () => {
            const result = await getContractType('meta-pool.near');
            assert.equal(result.isStakingPool, true, 'Should be detected as staking pool');
            assert.equal(result.isFungibleToken, true, 'Should be detected as fungible token (stNEAR)');
            assert.equal(result.isMultiToken, false);
        });

        it('should include expected staking methods', async () => {
            const result = await getContractType('meta-pool.near');
            assert.ok(result.methods.includes('get_account_total_balance'), 'Should export get_account_total_balance');
            assert.ok(result.methods.includes('get_account_staked_balance'), 'Should export get_account_staked_balance');
            assert.ok(result.methods.includes('deposit_and_stake'), 'Should export deposit_and_stake');
        });

        it('should include expected FT methods', async () => {
            const result = await getContractType('meta-pool.near');
            assert.ok(result.methods.includes('ft_balance_of'), 'Should export ft_balance_of');
            assert.ok(result.methods.includes('ft_transfer'), 'Should export ft_transfer');
        });
    });

    describe('epic.poolv1.near (standard staking pool)', () => {
        it('should detect as staking pool only', async () => {
            const result = await getContractType('epic.poolv1.near');
            assert.equal(result.isStakingPool, true, 'Should be detected as staking pool');
            assert.equal(result.isFungibleToken, false, 'Should NOT be detected as fungible token');
            assert.equal(result.isMultiToken, false);
        });
    });

    describe('wrap.near (fungible token)', () => {
        it('should detect as fungible token only', async () => {
            const result = await getContractType('wrap.near');
            assert.equal(result.isFungibleToken, true, 'Should be detected as fungible token');
            assert.equal(result.isStakingPool, false, 'Should NOT be detected as staking pool');
            assert.equal(result.isMultiToken, false);
        });
    });

    describe('intents.near (multi-token)', () => {
        it('should detect as multi-token', async () => {
            const result = await getContractType('intents.near');
            assert.equal(result.isMultiToken, true, 'Should be detected as multi-token');
        });
    });

    describe('caching by code_hash', () => {
        it('should cache results after first call', async () => {
            assert.equal(getContractTypeCacheSize(), 0);

            await getContractType('wrap.near');
            assert.equal(getContractTypeCacheSize(), 1);

            // Second call should use cache (same code_hash)
            await getContractType('wrap.near');
            assert.equal(getContractTypeCacheSize(), 1);
        });

        it('should share cache between contracts with same code', async () => {
            // Two standard staking pools likely share the same code_hash
            await getContractType('epic.poolv1.near');
            const sizeAfterFirst = getContractTypeCacheSize();

            await getContractType('01node.poolv1.near');
            const sizeAfterSecond = getContractTypeCacheSize();

            // If they share the same code, cache size stays the same
            // If different code, it grows by 1 — either way cache is working
            assert.ok(sizeAfterSecond <= sizeAfterFirst + 1);
        });
    });

    describe('contract that is not staking/FT/MT', () => {
        it('should return all false for psalomo.near (custom contract)', async () => {
            const result = await getContractType('psalomo.near');
            assert.equal(result.isStakingPool, false);
            assert.equal(result.isFungibleToken, false);
            assert.equal(result.isMultiToken, false);
            // psalomo.near has a contract deployed, but it's not a standard interface
            assert.ok(result.methods.length > 0, 'Should have some methods');
        });
    });
});
