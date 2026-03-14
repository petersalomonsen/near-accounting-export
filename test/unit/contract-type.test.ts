import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import { classifyContract } from '../../scripts/contract-type.js';

describe('Contract Type Classification', () => {
    describe('classifyContract', () => {
        it('should detect staking pool by required methods', () => {
            const result = classifyContract([
                'get_account_total_balance',
                'get_account_staked_balance',
                'get_account_unstaked_balance',
                'deposit_and_stake',
                'unstake',
                'withdraw',
            ]);
            assert.equal(result.isStakingPool, true);
            assert.equal(result.isFungibleToken, false);
            assert.equal(result.isMultiToken, false);
        });

        it('should detect NEP-141 fungible token by required methods', () => {
            const result = classifyContract([
                'ft_balance_of',
                'ft_transfer',
                'ft_transfer_call',
                'ft_total_supply',
                'ft_metadata',
            ]);
            assert.equal(result.isFungibleToken, true);
            assert.equal(result.isStakingPool, false);
            assert.equal(result.isMultiToken, false);
        });

        it('should detect NEP-245 multi-token by required methods', () => {
            const result = classifyContract([
                'mt_balance_of',
                'mt_transfer',
                'mt_transfer_call',
                'mt_batch_balance_of',
            ]);
            assert.equal(result.isMultiToken, true);
            assert.equal(result.isStakingPool, false);
            assert.equal(result.isFungibleToken, false);
        });

        it('should detect dual-interface contract (staking + FT)', () => {
            const result = classifyContract([
                // Staking methods
                'get_account_total_balance',
                'get_account_staked_balance',
                'get_account_unstaked_balance',
                'deposit_and_stake',
                'unstake',
                // FT methods
                'ft_balance_of',
                'ft_transfer',
                'ft_transfer_call',
                'ft_metadata',
            ]);
            assert.equal(result.isStakingPool, true);
            assert.equal(result.isFungibleToken, true);
            assert.equal(result.isMultiToken, false);
        });

        it('should return all false for unrelated methods', () => {
            const result = classifyContract([
                'some_random_method',
                'another_method',
            ]);
            assert.equal(result.isStakingPool, false);
            assert.equal(result.isFungibleToken, false);
            assert.equal(result.isMultiToken, false);
        });

        it('should return all false for empty method list', () => {
            const result = classifyContract([]);
            assert.equal(result.isStakingPool, false);
            assert.equal(result.isFungibleToken, false);
            assert.equal(result.isMultiToken, false);
        });

        it('should not detect staking pool with only one required method', () => {
            const result = classifyContract(['get_account_total_balance']);
            assert.equal(result.isStakingPool, false);
        });

        it('should not detect FT with only one required method', () => {
            const result = classifyContract(['ft_balance_of']);
            assert.equal(result.isFungibleToken, false);
        });

        it('should preserve the full methods list in the result', () => {
            const methods = ['ft_balance_of', 'ft_transfer', 'other_method'];
            const result = classifyContract(methods);
            assert.deepEqual(result.methods, methods);
        });
    });
});
