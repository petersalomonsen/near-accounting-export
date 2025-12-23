// Integration test for binary search with intents token changes
// Tests the specific scenario where binary search must find intents token balance changes
import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import {
    getAllBalances,
    findLatestBalanceChangingBlock,
    clearBalanceCache
} from '../../scripts/balance-tracker.js';
import { setStopSignal } from '../../scripts/rpc.js';

describe('Binary Search - Intents Token Detection', function() {
    // These tests make real RPC calls and may take time
    this.timeout(120000);

    beforeEach(function() {
        setStopSignal(false);
        clearBalanceCache();
    });

    describe('Known intents token change', function() {
        const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
        const changeBlock = 148_439_687;
        const intentsToken = 'nep141:eth.omft.near';
        const expectedBalanceBefore = '0';
        const expectedBalanceAfter = '5000000000000000';

        it('should detect intents token change at specific block', async function() {
            // Verify the change exists at the known block
            const balanceBefore = await getAllBalances(
                accountId,
                changeBlock - 1,
                null, // no FTs
                [intentsToken], // specific intents token
                false // don't check NEAR
            );

            const balanceAfter = await getAllBalances(
                accountId,
                changeBlock,
                null,
                [intentsToken],
                false
            );

            const balanceBeforeToken = balanceBefore.intentsTokens?.[intentsToken] || '0';
            const balanceAfterToken = balanceAfter.intentsTokens?.[intentsToken] || '0';

            assert.equal(
                balanceBeforeToken,
                expectedBalanceBefore,
                `Balance before should be ${expectedBalanceBefore}`
            );
            assert.equal(
                balanceAfterToken,
                expectedBalanceAfter,
                `Balance after should be ${expectedBalanceAfter}`
            );
        });

        it('should find intents token change using binary search', async function() {
            // Test binary search over a range containing the change
            const firstBlock = 139_109_383;
            const lastBlock = 150_553_579;

            // Verify there's a change in this range
            const startBalance = await getAllBalances(
                accountId,
                firstBlock,
                null,
                [intentsToken],
                false
            );

            const endBalance = await getAllBalances(
                accountId,
                lastBlock,
                null,
                [intentsToken],
                false
            );

            const startToken = startBalance.intentsTokens?.[intentsToken] || '0';
            const endToken = endBalance.intentsTokens?.[intentsToken] || '0';

            assert.notEqual(
                startToken,
                endToken,
                'Should have a change in the range'
            );

            // Run binary search
            const result = await findLatestBalanceChangingBlock(
                accountId,
                firstBlock,
                lastBlock,
                null, // no FTs
                [intentsToken], // specific intents token
                false // don't check NEAR
            );

            // Verify the search found the change
            assert.ok(result, 'Should return a result');
            assert.equal(
                result.hasChanges,
                true,
                'Should detect that changes exist'
            );
            assert.equal(
                result.block,
                changeBlock,
                `Should find the change at block ${changeBlock}`
            );

            // Verify intents changes are properly reported
            assert.ok(
                result.intentsChanged,
                'Should have intentsChanged object'
            );
            assert.ok(
                result.intentsChanged[intentsToken],
                `Should report change for ${intentsToken}`
            );
            assert.equal(
                result.intentsChanged[intentsToken].start,
                expectedBalanceBefore,
                'Start balance should match'
            );
            assert.equal(
                result.intentsChanged[intentsToken].end,
                expectedBalanceAfter,
                'End balance should match'
            );
        });

        it('should handle deep recursion correctly', async function() {
            // This test exercises the deep recursion scenario that previously failed
            // The change is at block 148,439,687
            // The binary search will recurse ~24 levels deep to find it

            const firstBlock = 148_407_793; // Range that requires deep recursion
            const lastBlock = 148_586_609;

            // Verify this range contains the change
            const startBalance = await getAllBalances(
                accountId,
                firstBlock,
                null,
                [intentsToken],
                false
            );

            const endBalance = await getAllBalances(
                accountId,
                lastBlock,
                null,
                [intentsToken],
                false
            );

            const startToken = startBalance.intentsTokens?.[intentsToken] || '0';
            const endToken = endBalance.intentsTokens?.[intentsToken] || '0';

            assert.notEqual(startToken, endToken, 'Range should contain the change');

            // Run binary search - this will recurse deeply
            const result = await findLatestBalanceChangingBlock(
                accountId,
                firstBlock,
                lastBlock,
                null,
                [intentsToken],
                false
            );

            // The key test: despite deep recursion, the token list should be
            // preserved all the way down to the leaf case (numBlocks === 1)
            assert.equal(result.hasChanges, true, 'Should find the change');
            assert.equal(result.block, changeBlock, 'Should find the exact block');
            assert.ok(
                result.intentsChanged?.[intentsToken],
                'Should report the intents token change'
            );
        });

        it('should properly pass token parameters to leaf cases', async function() {
            // Test the specific fix: token parameters must be passed through
            // to getAllBalances calls in the leaf cases (numBlocks <= 0 and numBlocks === 1)
            
            // Use a very narrow range that will hit the leaf case quickly
            const result = await findLatestBalanceChangingBlock(
                accountId,
                changeBlock - 1,
                changeBlock,
                null,
                [intentsToken],
                false
            );

            assert.equal(result.hasChanges, true, 'Should detect change in 1-block range');
            assert.equal(result.block, changeBlock, 'Should identify the correct block');
            
            // Verify the result has complete balance snapshots with the token
            assert.ok(result.startBalance, 'Should have startBalance');
            assert.ok(result.endBalance, 'Should have endBalance');
            assert.ok(
                result.startBalance.intentsTokens,
                'startBalance should have intentsTokens'
            );
            assert.ok(
                result.endBalance.intentsTokens,
                'endBalance should have intentsTokens'
            );
            
            // The token should be present in the snapshots
            assert.equal(
                result.startBalance.intentsTokens[intentsToken],
                expectedBalanceBefore,
                'Start snapshot should have the token'
            );
            assert.equal(
                result.endBalance.intentsTokens[intentsToken],
                expectedBalanceAfter,
                'End snapshot should have the token'
            );
        });
    });

    describe('Multiple intents changes in narrow range', function() {
        // Test case from real data: blocks 158500927-158500955
        // This range contains multiple intents token changes
        const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
        const startBlock = 158_500_927;
        const endBlock = 158_500_955;

        it('should find all intents changes in the range', async function() {
            // Known data from the actual blockchain:
            // Block 158500927: has various intents tokens
            // Block 158500928: nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 changes from 119000000 to 89000000
            // Block 158500955: nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near changes from 12286263 to 42286203

            const intentsTokens = [
                'nep141:eth.omft.near',
                'nep141:wrap.near',
                'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
                'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'
            ];

            // Verify expected balances at block 158500927
            const balance927 = await getAllBalances(accountId, startBlock, null, intentsTokens, false);
            assert.equal(
                balance927.intentsTokens['nep141:eth.omft.near'],
                '5000000000000000',
                'Should have correct eth.omft.near balance at 158500927'
            );
            assert.equal(
                balance927.intentsTokens['nep141:wrap.near'],
                '800000000000000000000000',
                'Should have correct wrap.near balance at 158500927'
            );
            assert.equal(
                balance927.intentsTokens['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'],
                '12286263',
                'Should have correct USDC balance at 158500927'
            );
            assert.equal(
                balance927.intentsTokens['nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'],
                '119000000',
                'Should have correct USDC balance at 158500927'
            );

            // Verify expected balances at block 158500955
            const balance955 = await getAllBalances(accountId, endBlock, null, intentsTokens, false);
            assert.equal(
                balance955.intentsTokens['nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'],
                '42286203',
                'Should have correct USDC balance at 158500955'
            );
            assert.equal(
                balance955.intentsTokens['nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1'],
                '89000000',
                'Should have correct USDC balance at 158500955'
            );

            // Binary search should find the latest change (block 158500955)
            const result = await findLatestBalanceChangingBlock(
                accountId,
                startBlock,
                endBlock,
                null,
                intentsTokens,
                false
            );

            assert.equal(result.hasChanges, true, 'Should detect changes in range');
            assert.ok(
                result.block === 158_500_928 || result.block === 158_500_955,
                `Should find one of the change blocks (got ${result.block})`
            );
            assert.ok(result.intentsChanged, 'Should have intentsChanged object');
            assert.ok(
                Object.keys(result.intentsChanged).length > 0,
                'Should report at least one intents token change'
            );
        });

        it('should correctly detect change at block 158500928', async function() {
            // Test the specific change at block 158500928
            const intentsToken = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

            const balanceBefore = await getAllBalances(
                accountId,
                158_500_927,
                null,
                [intentsToken],
                false
            );

            const balanceAfter = await getAllBalances(
                accountId,
                158_500_928,
                null,
                [intentsToken],
                false
            );

            assert.equal(
                balanceBefore.intentsTokens[intentsToken],
                '119000000',
                'Balance before should be 119000000'
            );
            assert.equal(
                balanceAfter.intentsTokens[intentsToken],
                '89000000',
                'Balance after should be 89000000'
            );

            // Binary search in narrow range should find this change
            const result = await findLatestBalanceChangingBlock(
                accountId,
                158_500_927,
                158_500_928,
                null,
                [intentsToken],
                false
            );

            assert.equal(result.hasChanges, true, 'Should detect change');
            assert.equal(result.block, 158_500_928, 'Should find change at block 158500928');
            assert.ok(result.intentsChanged, 'Should have intentsChanged');
            assert.ok(result.intentsChanged[intentsToken], 'Should have change for token');
            assert.equal(
                result.intentsChanged[intentsToken].start,
                '119000000',
                'Should report correct start balance'
            );
            assert.equal(
                result.intentsChanged[intentsToken].end,
                '89000000',
                'Should report correct end balance'
            );
            assert.equal(
                result.intentsChanged[intentsToken].diff,
                '-30000000',
                'Should report correct diff'
            );
        });

        it('should correctly detect change at block 158500955', async function() {
            // Test the specific change at block 158500955
            const intentsToken = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';

            const balanceBefore = await getAllBalances(
                accountId,
                158_500_928,
                null,
                [intentsToken],
                false
            );

            const balanceAfter = await getAllBalances(
                accountId,
                158_500_955,
                null,
                [intentsToken],
                false
            );

            assert.equal(
                balanceBefore.intentsTokens[intentsToken],
                '12286263',
                'Balance before should be 12286263'
            );
            assert.equal(
                balanceAfter.intentsTokens[intentsToken],
                '42286203',
                'Balance after should be 42286203'
            );

            // Binary search in narrow range should find this change
            const result = await findLatestBalanceChangingBlock(
                accountId,
                158_500_928,
                158_500_955,
                null,
                [intentsToken],
                false
            );

            assert.equal(result.hasChanges, true, 'Should detect change');
            assert.equal(result.block, 158_500_955, 'Should find change at block 158500955');
            assert.ok(result.intentsChanged, 'Should have intentsChanged');
            assert.ok(result.intentsChanged[intentsToken], 'Should have change for token');
            assert.equal(
                result.intentsChanged[intentsToken].start,
                '12286263',
                'Should report correct start balance'
            );
            assert.equal(
                result.intentsChanged[intentsToken].end,
                '42286203',
                'Should report correct end balance'
            );
            assert.equal(
                result.intentsChanged[intentsToken].diff,
                '29999940',
                'Should report correct diff'
            );
        });
    });

    describe('Intents token discovery', function() {
        it('should find intents tokens when not specified', async function() {
            // Test that when intentsTokens is undefined, we discover tokens
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const blockHeight = 148_439_687;

            const balance = await getAllBalances(
                accountId,
                blockHeight,
                null, // no FTs
                undefined, // discover intents tokens
                false
            );

            // Should have discovered at least one intents token
            assert.ok(balance.intentsTokens, 'Should have intentsTokens object');
            const tokenCount = Object.keys(balance.intentsTokens).length;
            assert.ok(tokenCount > 0, 'Should discover at least one intents token');
        });

        it('should track specific intents tokens when specified', async function() {
            // Test that when intentsTokens is specified as an array, we only query those
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const blockHeight = 148_439_687;
            const specificTokens = ['nep141:eth.omft.near', 'nep141:wrap.near'];

            const balance = await getAllBalances(
                accountId,
                blockHeight,
                null,
                specificTokens,
                false
            );

            assert.ok(balance.intentsTokens, 'Should have intentsTokens object');
            
            // Should have exactly the tokens we requested (even if balance is 0)
            for (const token of specificTokens) {
                assert.ok(
                    token in balance.intentsTokens,
                    `Should have balance for ${token}`
                );
            }
        });

        it('should handle empty intents token list', async function() {
            // Test that when intentsTokens is an empty array, we get an empty result
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const blockHeight = 148_439_687;

            const balance = await getAllBalances(
                accountId,
                blockHeight,
                null,
                [], // empty array - query no tokens
                false
            );

            assert.ok(balance.intentsTokens, 'Should have intentsTokens object');
            assert.equal(
                Object.keys(balance.intentsTokens).length,
                0,
                'Should have no tokens'
            );
        });
    });
});
