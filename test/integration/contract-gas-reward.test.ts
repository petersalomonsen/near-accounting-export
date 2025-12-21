// Test to investigate contract gas rewards and balance changes
// This tests blocks 171176747 where we see a NEAR balance increase (~0.08 NEAR)
// that doesn't match any transfer in the transfers array

import { strict as assert } from 'assert';
import {
    getAllBalances,
    findLatestBalanceChangingBlock,
    findBalanceChangingTransaction,
    clearBalanceCache
} from '../../scripts/balance-tracker.js';
import { fetchNeardataBlock, setStopSignal } from '../../scripts/rpc.js';

const TEST_ACCOUNT = 'romakqatesting.sputnik-dao.near';

// Token contracts to track
const TOKEN_CONTRACTS = [
    '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    'wrap.near',
    'usdt.tether-token.near'
];

// Intents tokens to track
const INTENTS_TOKENS = ['nep141:wrap.near'];

describe('Contract Gas Reward Investigation', function() {
    this.timeout(120000);
    
    beforeEach(function() {
        setStopSignal(false);
        clearBalanceCache();
    });

    it('should detect balance change at block 171176747 with contract gas reward', async function() {
        // Block 171176747 has a NEAR balance increase that is entirely from contract gas reward
        // The only transfer recorded is 1 yoctoNEAR OUT, but the balance actually increases
        
        const blockHeight = 171176747;
        
        // Get balance before and after
        const balanceBefore = await getAllBalances(
            TEST_ACCOUNT,
            blockHeight - 1,
            TOKEN_CONTRACTS,
            INTENTS_TOKENS,
            true
        );
        
        const balanceAfter = await getAllBalances(
            TEST_ACCOUNT,
            blockHeight,
            TOKEN_CONTRACTS,
            INTENTS_TOKENS,
            true
        );
        
        const nearBefore = BigInt(balanceBefore.near);
        const nearAfter = BigInt(balanceAfter.near);
        const nearDiff = nearAfter - nearBefore;
        
        console.log('NEAR before:', nearBefore.toString());
        console.log('NEAR after:', nearAfter.toString());
        console.log('NEAR diff:', nearDiff.toString(), `(${Number(nearDiff) / 1e24} NEAR)`);
        
        // The balance increased (contract gas reward exceeds the 1 yoctoNEAR out)
        assert(nearDiff > 0n, 'NEAR balance should have increased');
        
        // Get transaction info
        const txInfo = await findBalanceChangingTransaction(TEST_ACCOUNT, blockHeight);
        
        console.log('\nTransaction hashes:', txInfo.transactionHashes);
        console.log('Transfers:', JSON.stringify(txInfo.transfers, null, 2));
        
        // Calculate the transfer total for NEAR
        let nearTransferTotal = 0n;
        for (const transfer of txInfo.transfers) {
            if (transfer.type === 'near') {
                const amount = BigInt(transfer.amount);
                nearTransferTotal += transfer.direction === 'in' ? amount : -amount;
            }
        }
        
        console.log('\nNEAR transfer total:', nearTransferTotal.toString());
        console.log('Actual NEAR diff:', nearDiff.toString());
        console.log('Mismatch (contract gas reward):', (nearDiff - nearTransferTotal).toString());
        
        // The transfers array shows -1 yoctoNEAR, but balance increased
        // This proves the balance change includes contract gas reward
        assert(nearDiff !== nearTransferTotal, 'Balance diff should not match transfers (due to gas reward)');
        assert(nearDiff > nearTransferTotal, 'Actual balance change should be higher than transfers (gas reward is positive)');
        
        // Verify the gas reward amount from the receipt
        const block = await fetchNeardataBlock(blockHeight);
        assert(block, 'Block should be fetched');
        
        let totalContractReward = 0n;
        for (const shard of block.shards) {
            for (const outcome of shard.receipt_execution_outcomes) {
                if (outcome.receipt.receiver_id === TEST_ACCOUNT) {
                    const tokensBurnt = BigInt(outcome.execution_outcome.outcome.tokens_burnt);
                    // Contract reward is 30% of tokens burnt
                    totalContractReward += tokensBurnt * 30n / 100n;
                }
            }
        }
        
        console.log('\nCalculated contract reward (30% of tokens burnt):', totalContractReward.toString());
        
        // The mismatch between balance diff and transfers should be close to the contract reward
        // (may not be exact due to storage costs)
        const mismatch = nearDiff - nearTransferTotal;
        assert(mismatch > 0n, 'Mismatch should be positive (gas reward)');
        
        // Verify that an action_receipt_gas_reward transfer was found
        const gasRewardTransfer = txInfo.transfers.find(t => t.type === 'action_receipt_gas_reward');
        assert(gasRewardTransfer, 'Should find an action_receipt_gas_reward transfer');
        assert.equal(gasRewardTransfer.direction, 'in', 'Gas reward should be incoming');
        assert.equal(gasRewardTransfer.counterparty, 'maledress6270.near', 'Counterparty should be the caller');
        assert.equal(gasRewardTransfer.receiptId, 'Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5', 'Receipt ID should match the incoming call');
        
        // The gas reward amount should match the actual balance increase (since there's only gas reward, no other transfers)
        const gasRewardAmount = BigInt(gasRewardTransfer.amount);
        assert(gasRewardAmount > 0n, 'Gas reward amount should be positive');
        console.log('\nGas reward transfer amount:', gasRewardAmount.toString());
        
        // The receipt ID should be Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5 (the incoming call)
        // not JAYfW23byQWLVRCqmEqacnM9hLoZAuLimtQ2buW7FYpf (the outgoing cross-contract call)
        const incomingReceipt = 'Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5';
        
        // Check that the incoming receipt exists in this block
        let foundIncomingReceipt = false;
        for (const shard of block.shards) {
            for (const outcome of shard.receipt_execution_outcomes) {
                if (outcome.receipt.receipt_id === incomingReceipt) {
                    foundIncomingReceipt = true;
                    assert.equal(outcome.receipt.receiver_id, TEST_ACCOUNT);
                    console.log('\nIncoming receipt found:', incomingReceipt);
                    console.log('From:', outcome.receipt.predecessor_id);
                    console.log('Tx hash:', outcome.tx_hash);
                }
            }
        }
        
        assert(foundIncomingReceipt, `Incoming receipt ${incomingReceipt} should exist in block ${blockHeight}`);
    });

    it('should track the full transaction sequence across blocks 171176747-171176751', async function() {
        // This transaction spans multiple blocks:
        // 171176747: Contract executes, gets gas reward (+~0.00008 NEAR)
        // 171176748: Intent token withdrawn (goes to 0)
        // 171176750: Intent token refunded (goes back)
        // 171176751: NEAR sent out (-0.1 NEAR)
        
        // Block 171176747: Gas reward only
        const txInfo747 = await findBalanceChangingTransaction(TEST_ACCOUNT, 171176747);
        const gasReward747 = txInfo747.transfers.find(t => t.type === 'action_receipt_gas_reward');
        assert(gasReward747, 'Block 171176747 should have action_receipt_gas_reward transfer');
        assert.equal(gasReward747.direction, 'in');
        assert.equal(gasReward747.counterparty, 'maledress6270.near');
        assert.equal(gasReward747.receiptId, 'Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5');
        
        // Block 171176748: Intent token withdrawn
        const txInfo748 = await findBalanceChangingTransaction(TEST_ACCOUNT, 171176748);
        const mtOut748 = txInfo748.transfers.find(t => t.type === 'mt' && t.direction === 'out');
        assert(mtOut748, 'Block 171176748 should have mt out transfer');
        assert.equal(mtOut748.tokenId, 'nep141:wrap.near');
        assert.equal(mtOut748.amount, '100000000000000000000000');
        assert.equal(mtOut748.counterparty, 'intents.near');
        assert.equal(mtOut748.memo, 'withdraw');
        
        // Block 171176750: Intent token refunded
        const txInfo750 = await findBalanceChangingTransaction(TEST_ACCOUNT, 171176750);
        const mtIn750 = txInfo750.transfers.find(t => t.type === 'mt' && t.direction === 'in');
        assert(mtIn750, 'Block 171176750 should have mt in transfer (refund)');
        assert.equal(mtIn750.tokenId, 'nep141:wrap.near');
        assert.equal(mtIn750.amount, '100000000000000000000000');
        assert.equal(mtIn750.counterparty, 'intents.near');
        assert.equal(mtIn750.memo, 'refund');
        
        // Block 171176751: NEAR sent out + gas reward
        const txInfo751 = await findBalanceChangingTransaction(TEST_ACCOUNT, 171176751);
        const nearOut751 = txInfo751.transfers.find(t => t.type === 'near' && t.direction === 'out');
        assert(nearOut751, 'Block 171176751 should have near out transfer');
        assert.equal(nearOut751.amount, '100000000000000000000000');
        assert.equal(nearOut751.counterparty, 'maledress6270.near');
        
        // Block 171176751 also has a gas reward (from the refund callback execution)
        const gasReward751 = txInfo751.transfers.find(t => t.type === 'action_receipt_gas_reward');
        assert(gasReward751, 'Block 171176751 should have action_receipt_gas_reward transfer');
        assert.equal(gasReward751.direction, 'in');
        
        console.log('\n=== Full transaction sequence verified ===\n');
        console.log('Block 171176747: Gas reward from maledress6270.near');
        console.log('Block 171176748: wNEAR intent withdrawn to intents.near');
        console.log('Block 171176750: wNEAR intent refunded from intents.near');
        console.log('Block 171176751: NEAR sent to maledress6270.near + gas reward');
    });

    it('should examine the receipt execution outcomes for block 171176747', async function() {
        const blockHeight = 171176747;
        
        const block = await fetchNeardataBlock(blockHeight);
        assert(block, 'Block should be fetched');
        
        // Find the receipt that affects our account
        let foundReceipt = false;
        for (const shard of block.shards) {
            for (const outcome of shard.receipt_execution_outcomes) {
                if (outcome.receipt.receipt_id === 'Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5') {
                    foundReceipt = true;
                    const receipt = outcome.receipt;
                    const executionOutcome = outcome.execution_outcome;
                    
                    // Verify receipt details
                    assert.equal(receipt.predecessor_id, 'maledress6270.near', 'Predecessor should be maledress6270.near');
                    assert.equal(receipt.receiver_id, TEST_ACCOUNT, 'Receiver should be the test account');
                    assert.equal(outcome.tx_hash, 'F9BqPDCenfWHvmZrMxc8RgEC2soCrKRGedCvzwVVo63i', 'Tx hash should match');
                    
                    // Verify it's a FunctionCall action
                    const actions = receipt.receipt?.Action?.actions || [];
                    assert.equal(actions.length, 1, 'Should have exactly one action');
                    assert(actions[0].FunctionCall, 'Action should be FunctionCall');
                    assert.equal(actions[0].FunctionCall.method_name, 'act_proposal', 'Method should be act_proposal');
                    
                    // Verify gas burnt and tokens burnt
                    const outcomeData = executionOutcome.outcome;
                    assert(outcomeData.gas_burnt > 0, 'Gas burnt should be positive');
                    assert(BigInt(outcomeData.tokens_burnt) > 0n, 'Tokens burnt should be positive');
                    
                    // Verify spawned receipts
                    assert.equal(outcomeData.receipt_ids.length, 3, 'Should spawn 3 receipts');
                    assert(outcomeData.receipt_ids.includes('JAYfW23byQWLVRCqmEqacnM9hLoZAuLimtQ2buW7FYpf'), 'Should include the ft_withdraw receipt');
                    
                    // Verify the state change for gas reward exists
                    let foundGasRewardStateChange = false;
                    for (const stateChange of shard.state_changes || []) {
                        if (stateChange.type === 'account_update' &&
                            stateChange.cause?.type === 'action_receipt_gas_reward' &&
                            stateChange.cause?.receipt_hash === 'Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5' &&
                            stateChange.change?.account_id === TEST_ACCOUNT) {
                            foundGasRewardStateChange = true;
                            // Verify the balance after gas reward
                            assert.equal(stateChange.change.amount, '6320303078494178399999999', 'Balance after gas reward should match');
                        }
                    }
                    assert(foundGasRewardStateChange, 'Should find action_receipt_gas_reward state change');
                }
            }
        }
        
        assert(foundReceipt, 'Should find receipt Az63YBQFDTSbsHaFQ8vKGDFxqreG4Jby4qsU4PQ9P7v5');
    });

    it('should parse plain text FT transfer logs from wrap.near at block 171593921', async function() {
        // Block 171593921 has a wrap.near FT transfer that uses plain text log format
        // instead of EVENT_JSON. The log is: "Transfer 200000000000000000000000 from intents.near to romakqatesting.sputnik-dao.near"
        // This tests that we correctly parse this non-standard log format.
        
        const blockHeight = 171593921;
        
        // Get balance before and after to verify the change
        const balanceBefore = await getAllBalances(
            TEST_ACCOUNT,
            blockHeight - 1,
            TOKEN_CONTRACTS,
            INTENTS_TOKENS,
            true
        );
        
        const balanceAfter = await getAllBalances(
            TEST_ACCOUNT,
            blockHeight,
            TOKEN_CONTRACTS,
            INTENTS_TOKENS,
            true
        );
        
        // Verify wrap.near balance changed
        const wrapBefore = BigInt(balanceBefore.fungibleTokens['wrap.near'] || '0');
        const wrapAfter = BigInt(balanceAfter.fungibleTokens['wrap.near'] || '0');
        const wrapDiff = wrapAfter - wrapBefore;
        
        console.log(`\nwrap.near balance before: ${wrapBefore}`);
        console.log(`wrap.near balance after: ${wrapAfter}`);
        console.log(`wrap.near diff: ${wrapDiff} (${Number(wrapDiff) / 1e24} wNEAR)`);
        
        // The transfer is 0.2 wNEAR = 200000000000000000000000 yoctoNEAR
        assert.equal(wrapDiff.toString(), '200000000000000000000000', 'wrap.near balance should increase by 0.2 wNEAR');
        
        // Get transfer details
        const txInfo = await findBalanceChangingTransaction(TEST_ACCOUNT, blockHeight);
        
        console.log(`\nTransaction hashes: ${JSON.stringify(txInfo.transactionHashes)}`);
        console.log(`Transfers found: ${txInfo.transfers.length}`);
        console.log(`Transfers: ${JSON.stringify(txInfo.transfers, null, 2)}`);
        
        // Should find the FT transfer from wrap.near
        const ftTransfer = txInfo.transfers.find(t => 
            t.type === 'ft' && 
            t.tokenId === 'wrap.near' && 
            t.direction === 'in'
        );
        
        assert(ftTransfer, 'Should find FT transfer from wrap.near');
        assert.equal(ftTransfer.amount, '200000000000000000000000', 'FT transfer amount should be 0.2 wNEAR');
        assert.equal(ftTransfer.counterparty, 'intents.near', 'FT transfer counterparty should be intents.near');
        assert.equal(ftTransfer.receiptId, '3pcD1HKN721MebbBE1CpjVkFenVjUR7ChDUWGKxf2tRa', 'FT transfer receipt ID should match');
        
        // Also verify the block data has the plain text log
        const blockData = await fetchNeardataBlock(blockHeight);
        assert(blockData, 'Should fetch block data');
        
        let foundPlainTextLog = false;
        for (const shard of blockData.shards || []) {
            for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                if (receiptExecution.receipt?.receipt_id === '3pcD1HKN721MebbBE1CpjVkFenVjUR7ChDUWGKxf2tRa') {
                    const logs = receiptExecution.execution_outcome?.outcome?.logs || [];
                    for (const log of logs) {
                        if (log.startsWith('Transfer 200000000000000000000000 from intents.near to romakqatesting.sputnik-dao.near')) {
                            foundPlainTextLog = true;
                            console.log(`\nFound plain text log: "${log}"`);
                        }
                    }
                }
            }
        }
        
        assert(foundPlainTextLog, 'Should find plain text transfer log in block data');
    });
});
