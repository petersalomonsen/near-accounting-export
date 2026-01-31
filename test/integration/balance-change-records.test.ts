/**
 * End-to-End Integration Tests for Per-Token Balance Change Records
 *
 * These tests use REAL blockchain data with REAL RPC requests.
 * All expected values are from immutable blockchain state.
 *
 * Token types covered:
 * 1. NEAR - Native token balance changes
 * 2. FT - Fungible Token (NEP-141) balance changes
 * 3. MT - Multi-Token/Intents (NEP-245) balance changes
 * 4. Staking Pools - Delegated stake balance changes
 */
import { strict as assert } from 'assert';
import { describe, it } from 'mocha';
import {
    getAllBalances,
    getBalanceChangesAtBlock,
    getStakingPoolBalances,
    createBalanceChangeRecords,
    detectTokenGaps,
    findBalanceChangingTransaction,
    type BalanceChangeRecord
} from '../../scripts/balance-tracker.js';
import { enrichWithStakingPoolBalances } from '../../scripts/get-account-history.js';
import type { TransactionEntry } from '../../scripts/get-account-history.js';

describe('Per-Token Balance Change Records - End-to-End with Real RPC Data', function() {
    // Extend timeout for RPC calls
    this.timeout(120000);

    /**
     * ============================================
     * NEAR Balance Change Tests
     * ============================================
     *
     * Account: webassemblymusic-treasury.sputnik-dao.near
     * Block: 161048664
     * Event: DAO staking transaction (~1000 NEAR transferred out)
     *
     * This tests a cross-contract call where balance changes at a different
     * block than receipt execution.
     */
    describe('NEAR Balance Change', function() {
        const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
        const changeBlock = 161048664;

        it('should create BalanceChangeRecord for NEAR transfer with correct values', async function() {
            // Get real balance data from blockchain
            const balanceBefore = await getAllBalances(accountId, changeBlock - 1, null, null, true, null);
            const balanceAtChange = await getAllBalances(accountId, changeBlock, null, null, true, null);

            // Verify NEAR balance actually changed (blockchain data is immutable)
            const beforeNear = BigInt(balanceBefore.near);
            const afterNear = BigInt(balanceAtChange.near);
            const diff = beforeNear - afterNear;

            // ~1000 NEAR was transferred out
            assert.ok(diff > BigInt('999000000000000000000000000'), 'Should have > 999 NEAR difference');
            assert.ok(diff < BigInt('1001000000000000000000000000'), 'Should have < 1001 NEAR difference');

            // Get balance changes using the existing function
            const changes = await getBalanceChangesAtBlock(accountId, changeBlock, null, null, null);

            // Convert to flat BalanceChangeRecord format
            const records = createBalanceChangeRecords(changeBlock, null, changes);

            // Find the NEAR record
            const nearRecord = records.find(r => r.token_id === 'near');
            assert.ok(nearRecord, 'Should create a NEAR balance change record');

            // Verify record structure and values
            assert.strictEqual(nearRecord.block_height, changeBlock);
            assert.strictEqual(nearRecord.token_id, 'near');
            assert.strictEqual(nearRecord.balance_before, balanceBefore.near);
            assert.strictEqual(nearRecord.balance_after, balanceAtChange.near);

            // Verify amount is negative (transfer out)
            const recordDiff = BigInt(nearRecord.amount);
            assert.ok(recordDiff < 0n, 'Amount should be negative for transfer out');
            assert.strictEqual(nearRecord.amount, (afterNear - beforeNear).toString());

            console.log('NEAR Record:', {
                block_height: nearRecord.block_height,
                token_id: nearRecord.token_id,
                amount: nearRecord.amount,
                balance_before: nearRecord.balance_before.slice(0, 10) + '...',
                balance_after: nearRecord.balance_after.slice(0, 10) + '...'
            });
        });
    });

    /**
     * ============================================
     * Fungible Token (FT) Balance Change Tests
     * ============================================
     *
     * Account: webassemblymusic-treasury.sputnik-dao.near
     * Block: 168568481
     * Token: arizcredits.near
     * Event: Received 3,000,000 arizcredits
     */
    describe('FT (Fungible Token) Balance Change', function() {
        const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
        const changeBlock = 168568481;
        const ftContract = 'arizcredits.near';
        const expectedTransferAmount = '3000000';

        it('should create BalanceChangeRecord for FT transfer with exact values', async function() {
            // First discover what tokens are involved
            const txInfo = await findBalanceChangingTransaction(accountId, changeBlock);

            // Verify FT transfer was detected
            const ftTransfer = txInfo.transfers.find(t => t.type === 'ft' && t.tokenId === ftContract);
            assert.ok(ftTransfer, `Should detect ${ftContract} FT transfer`);
            assert.strictEqual(ftTransfer.amount, expectedTransferAmount, 'Transfer amount should be 3000000');
            assert.strictEqual(ftTransfer.direction, 'in', 'Transfer direction should be in');

            // Get balance changes with the FT contract specified
            const changes = await getBalanceChangesAtBlock(accountId, changeBlock, [ftContract], null, null);

            // Verify FT balance change was detected
            assert.ok(changes.tokensChanged[ftContract], `Should detect ${ftContract} change`);
            assert.strictEqual(changes.tokensChanged[ftContract].diff, expectedTransferAmount);

            // Convert to flat BalanceChangeRecord format
            const records = createBalanceChangeRecords(changeBlock, null, changes, txInfo.transfers);

            // Find the FT record
            const ftRecord = records.find(r => r.token_id === ftContract);
            assert.ok(ftRecord, `Should create a ${ftContract} balance change record`);

            // Verify record structure and values
            assert.strictEqual(ftRecord.block_height, changeBlock);
            assert.strictEqual(ftRecord.token_id, ftContract);
            assert.strictEqual(ftRecord.amount, expectedTransferAmount);

            // Verify balance_after - balance_before = amount
            const balanceBefore = BigInt(ftRecord.balance_before);
            const balanceAfter = BigInt(ftRecord.balance_after);
            assert.strictEqual((balanceAfter - balanceBefore).toString(), expectedTransferAmount);

            // Verify counterparty from transfer
            assert.ok(ftRecord.counterparty, 'Should have counterparty from transfer details');

            console.log('FT Record:', {
                block_height: ftRecord.block_height,
                token_id: ftRecord.token_id,
                amount: ftRecord.amount,
                balance_before: ftRecord.balance_before,
                balance_after: ftRecord.balance_after,
                counterparty: ftRecord.counterparty
            });
        });
    });

    /**
     * ============================================
     * Multi-Token (Intents) Balance Change Tests
     * ============================================
     *
     * Account: webassemblymusic-treasury.sputnik-dao.near
     * Token: nep141:eth.omft.near
     * Event: First receipt of 5,000,000,000,000,000 (0.005 ETH)
     *
     * Note: For FT/MT tokens, getBalanceChangesAtBlock queries:
     *   - balanceBefore at block N
     *   - balanceAfter at block N+1
     *
     * So to detect the change from 0 -> 5000000000000000 that appears at block 148439687,
     * we need to call getBalanceChangesAtBlock(148439686) which queries:
     *   - Before: block 148439686 = 0
     *   - After: block 148439687 = 5000000000000000
     */
    describe('MT (Intents/Multi-Token) Balance Change', function() {
        const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
        // The receipt block - use changeBlock-1 since FT/MT queries at (block, block+1)
        const changeBlock = 148439686;
        const intentsToken = 'nep141:eth.omft.near';
        const expectedBalanceBefore = '0';
        const expectedBalanceAfter = '5000000000000000';

        it('should create BalanceChangeRecord for intents token with exact values', async function() {
            // Verify the exact balances at the blocks getBalanceChangesAtBlock will query
            // For FT/MT: queries at (changeBlock, changeBlock+1)
            const balanceBefore = await getAllBalances(
                accountId,
                changeBlock,  // FT/MT "before" is queried at the change block itself
                null,
                [intentsToken],
                false,
                null
            );
            const balanceAfter = await getAllBalances(
                accountId,
                changeBlock + 1,  // FT/MT "after" is queried at change block + 1
                null,
                [intentsToken],
                false,
                null
            );

            // Verify exact blockchain values
            const beforeBalance = balanceBefore.intentsTokens?.[intentsToken] || '0';
            const afterBalance = balanceAfter.intentsTokens?.[intentsToken] || '0';

            assert.strictEqual(beforeBalance, expectedBalanceBefore,
                `Balance before should be exactly ${expectedBalanceBefore}`);
            assert.strictEqual(afterBalance, expectedBalanceAfter,
                `Balance after should be exactly ${expectedBalanceAfter}`);

            // Get balance changes - this queries at (changeBlock, changeBlock+1) for FT/MT
            const changes = await getBalanceChangesAtBlock(accountId, changeBlock, null, [intentsToken], null);

            // Verify intents change detected
            assert.ok(changes.intentsChanged[intentsToken], `Should detect ${intentsToken} change`);
            assert.strictEqual(changes.intentsChanged[intentsToken].start, expectedBalanceBefore);
            assert.strictEqual(changes.intentsChanged[intentsToken].end, expectedBalanceAfter);
            assert.strictEqual(changes.intentsChanged[intentsToken].diff, expectedBalanceAfter);

            // Convert to flat BalanceChangeRecord format
            const records = createBalanceChangeRecords(changeBlock, null, changes);

            // Find the intents record
            const mtRecord = records.find(r => r.token_id === intentsToken);
            assert.ok(mtRecord, `Should create a ${intentsToken} balance change record`);

            // Verify record structure and exact values
            assert.strictEqual(mtRecord.block_height, changeBlock);
            assert.strictEqual(mtRecord.token_id, intentsToken);
            assert.strictEqual(mtRecord.balance_before, expectedBalanceBefore);
            assert.strictEqual(mtRecord.balance_after, expectedBalanceAfter);
            assert.strictEqual(mtRecord.amount, expectedBalanceAfter);  // 0 -> 5000000000000000

            console.log('MT (Intents) Record:', {
                block_height: mtRecord.block_height,
                token_id: mtRecord.token_id,
                amount: mtRecord.amount,
                balance_before: mtRecord.balance_before,
                balance_after: mtRecord.balance_after
            });
        });
    });

    /**
     * ============================================
     * Staking Pool Balance Change Tests
     * ============================================
     *
     * Account: petermusic.near
     * Block: 161869264
     * Pool: astro-stakers.poolv1.near
     * Event: deposit_and_stake 1000 NEAR
     * Balance Before: 442848977056627936899944429
     * Balance After: 1442848977056627936899944430
     */
    describe('Staking Pool Balance Change', function() {
        const accountId = 'petermusic.near';
        const changeBlock = 161869264;
        const stakingPool = 'astro-stakers.poolv1.near';
        const expectedBalanceBefore = '442848977056627936899944429';
        const expectedBalanceAfter = '1442848977056627936899944430';

        it('should create BalanceChangeRecord for staking pool with exact values', async function() {
            // Query staking pool balances directly
            const balancesBefore = await getStakingPoolBalances(accountId, changeBlock, [stakingPool]);
            const balancesAfter = await getStakingPoolBalances(accountId, changeBlock + 1, [stakingPool]);

            // Verify exact blockchain values
            assert.strictEqual(balancesBefore[stakingPool], expectedBalanceBefore,
                `Staking balance before should be exactly ${expectedBalanceBefore}`);
            assert.strictEqual(balancesAfter[stakingPool], expectedBalanceAfter,
                `Staking balance after should be exactly ${expectedBalanceAfter}`);

            // Calculate expected diff (1000 NEAR + 1 yoctoNEAR reward)
            const diff = BigInt(expectedBalanceAfter) - BigInt(expectedBalanceBefore);
            assert.strictEqual(diff.toString(), '1000000000000000000000000001',
                'Difference should be 1000 NEAR + 1 yoctoNEAR');

            // Get transaction info and enrich with staking balances
            const txInfo = await findBalanceChangingTransaction(accountId, changeBlock);
            const entry: TransactionEntry = {
                block: changeBlock,
                timestamp: null,
                transactionHashes: txInfo.transactionHashes,
                transactions: txInfo.transactions,
                transfers: txInfo.transfers,
                balanceBefore: { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: {} },
                balanceAfter: { near: '0', fungibleTokens: {}, intentsTokens: {}, stakingPools: {} },
                changes: { nearChanged: false, tokensChanged: {}, intentsChanged: {}, stakingChanged: {} }
            };

            // Enrich with real staking pool balances
            await enrichWithStakingPoolBalances(accountId, entry);

            // Create balance changes with staking data
            const changes = {
                hasChanges: true,
                nearChanged: false,
                tokensChanged: {},
                intentsChanged: {},
                stakingChanged: {
                    [stakingPool]: {
                        start: entry.balanceBefore!.stakingPools![stakingPool] || '0',
                        end: entry.balanceAfter!.stakingPools![stakingPool] || '0',
                        diff: diff.toString()
                    }
                }
            };

            // Convert to flat BalanceChangeRecord format
            const records = createBalanceChangeRecords(changeBlock, null, changes, txInfo.transfers);

            // Find the staking record
            const stakingRecord = records.find(r => r.token_id === stakingPool);
            assert.ok(stakingRecord, `Should create a ${stakingPool} balance change record`);

            // Verify record structure and exact values
            assert.strictEqual(stakingRecord.block_height, changeBlock);
            assert.strictEqual(stakingRecord.token_id, stakingPool);
            assert.strictEqual(stakingRecord.balance_before, expectedBalanceBefore);
            assert.strictEqual(stakingRecord.balance_after, expectedBalanceAfter);
            assert.strictEqual(stakingRecord.amount, diff.toString());

            // Staking pool should be its own counterparty
            assert.strictEqual(stakingRecord.counterparty, stakingPool);

            console.log('Staking Pool Record:', {
                block_height: stakingRecord.block_height,
                token_id: stakingRecord.token_id,
                amount: stakingRecord.amount,
                balance_before: stakingRecord.balance_before.slice(0, 15) + '...',
                balance_after: stakingRecord.balance_after.slice(0, 15) + '...'
            });
        });
    });

    /**
     * ============================================
     * Gap Detection Tests with Real Data
     * ============================================
     *
     * Tests that detectTokenGaps correctly identifies gaps
     * between consecutive balance change records.
     */
    describe('Gap Detection with Real Records', function() {
        it('should detect no gaps when records are properly connected', async function() {
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const intentsToken = 'nep141:eth.omft.near';

            // Get real balances at two points
            const balance1 = await getAllBalances(accountId, 148439687, null, [intentsToken], false, null);
            const balance2 = await getAllBalances(accountId, 150553579, null, [intentsToken], false, null);

            // Create properly connected records
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 148439687,
                    block_timestamp: null,
                    tx_hash: null,
                    tx_block: null,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: intentsToken,
                    receipt_id: null,
                    counterparty: null,
                    amount: balance1.intentsTokens?.[intentsToken] || '0',
                    balance_before: '0',
                    balance_after: balance1.intentsTokens?.[intentsToken] || '0'
                },
                {
                    block_height: 150553579,
                    block_timestamp: null,
                    tx_hash: null,
                    tx_block: null,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: intentsToken,
                    receipt_id: null,
                    counterparty: null,
                    amount: '0', // No change if balances are same
                    balance_before: balance1.intentsTokens?.[intentsToken] || '0', // Connected!
                    balance_after: balance2.intentsTokens?.[intentsToken] || '0'
                }
            ];

            const gaps = detectTokenGaps(records);

            // Should have no gaps if balance_after[0] == balance_before[1]
            if (records[0]!.balance_after === records[1]!.balance_before) {
                assert.strictEqual(gaps.length, 0, 'Should have no gaps when properly connected');
            } else {
                // If there's a gap, it should be detected
                assert.strictEqual(gaps.length, 1, 'Should detect gap when balances mismatch');
                assert.strictEqual(gaps[0]!.token_id, intentsToken);
            }
        });

        it('should detect gap when balance_after does not match next balance_before', function() {
            // Create records with intentional gap (simulating missing transaction)
            const records: BalanceChangeRecord[] = [
                {
                    block_height: 100,
                    block_timestamp: null,
                    tx_hash: null,
                    tx_block: null,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'near',
                    receipt_id: null,
                    counterparty: null,
                    amount: '1000000000000000000000000',
                    balance_before: '5000000000000000000000000',
                    balance_after: '6000000000000000000000000'
                },
                {
                    block_height: 200,
                    block_timestamp: null,
                    tx_hash: null,
                    tx_block: null,
                    signer_id: null,
                    receiver_id: null,
                    predecessor_id: null,
                    token_id: 'near',
                    receipt_id: null,
                    counterparty: null,
                    amount: '-500000000000000000000000',
                    balance_before: '7000000000000000000000000',  // GAP: should be 6000...
                    balance_after: '6500000000000000000000000'
                }
            ];

            const gaps = detectTokenGaps(records);

            assert.strictEqual(gaps.length, 1, 'Should detect one gap');
            assert.strictEqual(gaps[0]!.token_id, 'near');
            assert.strictEqual(gaps[0]!.from_block, 100);
            assert.strictEqual(gaps[0]!.to_block, 200);
            assert.strictEqual(gaps[0]!.expected_balance, '6000000000000000000000000');
            assert.strictEqual(gaps[0]!.actual_balance, '7000000000000000000000000');
            assert.strictEqual(gaps[0]!.diff, '1000000000000000000000000'); // actual - expected
        });
    });

    /**
     * ============================================
     * Record Field Validation
     * ============================================
     */
    describe('BalanceChangeRecord Field Validation', function() {
        it('should have all required fields with correct types', async function() {
            const accountId = 'webassemblymusic-treasury.sputnik-dao.near';
            const changeBlock = 161048664;

            const changes = await getBalanceChangesAtBlock(accountId, changeBlock, null, null, null);
            const records = createBalanceChangeRecords(changeBlock, null, changes);

            for (const record of records) {
                // Block context
                assert.strictEqual(typeof record.block_height, 'number', 'block_height should be number');
                assert.ok(record.block_height > 0, 'block_height should be positive');

                // Token data
                assert.strictEqual(typeof record.token_id, 'string', 'token_id should be string');
                assert.ok(record.token_id.length > 0, 'token_id should not be empty');

                // Balance data
                assert.strictEqual(typeof record.amount, 'string', 'amount should be string');
                assert.strictEqual(typeof record.balance_before, 'string', 'balance_before should be string');
                assert.strictEqual(typeof record.balance_after, 'string', 'balance_after should be string');

                // Verify numeric strings
                assert.ok(/^-?\d+$/.test(record.amount), 'amount should be numeric string');
                assert.ok(/^\d+$/.test(record.balance_before), 'balance_before should be positive numeric');
                assert.ok(/^\d+$/.test(record.balance_after), 'balance_after should be positive numeric');

                // Verify amount = balance_after - balance_before
                const expectedAmount = BigInt(record.balance_after) - BigInt(record.balance_before);
                assert.strictEqual(record.amount, expectedAmount.toString(),
                    'amount should equal balance_after - balance_before');
            }
        });
    });
});
