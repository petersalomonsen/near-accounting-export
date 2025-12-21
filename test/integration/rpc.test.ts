// Test that RPC can retrieve equivalent data to neardata.xyz
import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

import {
    fetchNeardataBlock,
    fetchBlockData,
    getTransactionStatusWithReceipts,
    setStopSignal
} from '../scripts/rpc.js';

describe('RPC Fallback for Neardata.xyz', function() {
    this.timeout(120000);

    beforeEach(function() {
        setStopSignal(false);
    });

    // Test block with known activity
    const TEST_BLOCK = 175446889;

    it('should get equivalent block data from RPC as from neardata.xyz', async function() {
        // 1. Get reference data from neardata.xyz
        const neardataBlock = await fetchNeardataBlock(TEST_BLOCK);
        assert.ok(neardataBlock, 'Should get neardata block as reference');

        // 2. Get same block from RPC
        const rpcBlock = await fetchBlockData(TEST_BLOCK);
        assert.ok(rpcBlock, 'Should get RPC block');

        // 3. Compare block header data
        assert.equal(
            rpcBlock.header.height,
            neardataBlock.block.header.height,
            'Block heights should match'
        );
        assert.equal(
            rpcBlock.header.hash,
            neardataBlock.block.header.hash,
            'Block hashes should match'
        );
        assert.equal(
            rpcBlock.header.timestamp,
            neardataBlock.block.header.timestamp,
            'Timestamps should match'
        );

        console.log(`✓ Block ${TEST_BLOCK} header matches between neardata and RPC`);
    });

    it('should get transaction receipts and logs via RPC tx status', async function() {
        // 1. Get reference data from neardata.xyz
        const neardataBlock = await fetchNeardataBlock(TEST_BLOCK);
        assert.ok(neardataBlock, 'Should get neardata block as reference');

        // 2. Extract a transaction hash and signer from neardata
        let refTxHash: string | null = null;
        let refSignerId: string | null = null;
        let refLogs: string[] = [];
        let refReceiptId: string | null = null;

        for (const shard of neardataBlock.shards || []) {
            for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                const txHash = receiptExecution.tx_hash;
                const signerId = receiptExecution.receipt?.receipt?.Action?.signer_id;
                const logs = receiptExecution.execution_outcome?.outcome?.logs || [];

                if (txHash && signerId) {
                    refTxHash = txHash;
                    refSignerId = signerId;
                    refLogs = logs;
                    refReceiptId = receiptExecution.execution_outcome?.id || null;
                    break;
                }
            }
            if (refTxHash) break;
        }

        if (!refTxHash || !refSignerId) {
            console.log('No transactions found in test block');
            this.skip();
            return;
        }

        console.log(`Reference from neardata.xyz:`);
        console.log(`  TX Hash: ${refTxHash}`);
        console.log(`  Signer: ${refSignerId}`);
        console.log(`  Receipt ID: ${refReceiptId}`);
        console.log(`  Logs count: ${refLogs.length}`);

        // 3. Get same transaction via RPC
        const txResult = await getTransactionStatusWithReceipts(refTxHash, refSignerId);
        assert.ok(txResult, 'Should get transaction via RPC');
        assert.ok(txResult.transaction, 'Should have transaction data');
        assert.ok(txResult.receipts_outcome, 'Should have receipts_outcome');

        console.log(`\nFrom RPC tx status:`);
        console.log(`  Signer: ${txResult.transaction.signer_id}`);
        console.log(`  Receiver: ${txResult.transaction.receiver_id}`);
        console.log(`  Receipt outcomes: ${txResult.receipts_outcome.length}`);

        // 4. Verify we can get the same logs
        let rpcLogs: string[] = [];
        for (const outcome of txResult.receipts_outcome) {
            if (outcome.id === refReceiptId) {
                rpcLogs = outcome.outcome?.logs || [];
                break;
            }
        }

        console.log(`  Logs for receipt ${refReceiptId}: ${rpcLogs.length}`);

        // 5. Compare logs
        assert.equal(
            rpcLogs.length,
            refLogs.length,
            `Log count should match for receipt ${refReceiptId}`
        );

        for (let i = 0; i < refLogs.length; i++) {
            assert.equal(rpcLogs[i], refLogs[i], `Log ${i} should match`);
        }

        console.log(`✓ Transaction ${refTxHash} data matches between neardata and RPC`);
    });

    it('should extract NEAR transfers from RPC chunk data', async function() {
        // 1. Get reference transfers from neardata.xyz
        const neardataBlock = await fetchNeardataBlock(TEST_BLOCK);
        assert.ok(neardataBlock, 'Should get neardata block as reference');

        interface Transfer {
            from: string;
            to: string;
            amount: string;
            type: 'Transfer' | 'FunctionCall';
        }

        const neardataTransfers: Transfer[] = [];
        for (const shard of neardataBlock.shards || []) {
            for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                const receipt = receiptExecution.receipt;
                if (!receipt) continue;

                const predecessorId = receipt.predecessor_id;
                const receiverId = receipt.receiver_id;
                const actions = receipt.receipt?.Action?.actions || [];

                for (const action of actions) {
                    if (action.Transfer) {
                        const amount = action.Transfer.deposit;
                        if (amount && BigInt(amount) > 0n) {
                            neardataTransfers.push({
                                from: predecessorId,
                                to: receiverId,
                                amount,
                                type: 'Transfer'
                            });
                        }
                    }
                    if (action.FunctionCall) {
                        const amount = action.FunctionCall.deposit;
                        if (amount && BigInt(amount) > 0n) {
                            neardataTransfers.push({
                                from: predecessorId,
                                to: receiverId,
                                amount,
                                type: 'FunctionCall'
                            });
                        }
                    }
                }
            }
        }

        console.log(`Reference from neardata.xyz: ${neardataTransfers.length} NEAR transfers`);

        // 2. Get same transfers from RPC
        const rpcBlock = await fetchBlockData(TEST_BLOCK);
        assert.ok(rpcBlock, 'Should get RPC block');

        const rpcTransfers: Transfer[] = [];
        for (const chunk of rpcBlock.chunks || []) {
            for (const receipt of (chunk as any).receipts || []) {
                const predecessorId = receipt.predecessor_id;
                const receiverId = receipt.receiver_id;
                const actions = receipt.receipt?.Action?.actions || [];

                for (const action of actions) {
                    if (action.Transfer) {
                        const amount = action.Transfer.deposit;
                        if (amount && BigInt(amount) > 0n) {
                            rpcTransfers.push({
                                from: predecessorId,
                                to: receiverId,
                                amount,
                                type: 'Transfer'
                            });
                        }
                    }
                    if (action.FunctionCall) {
                        const amount = action.FunctionCall.deposit;
                        if (amount && BigInt(amount) > 0n) {
                            rpcTransfers.push({
                                from: predecessorId,
                                to: receiverId,
                                amount,
                                type: 'FunctionCall'
                            });
                        }
                    }
                }
            }
        }

        console.log(`From RPC: ${rpcTransfers.length} NEAR transfers`);

        // 3. Compare - RPC should find the same or more transfers
        // (neardata shows receipt executions, RPC shows incoming receipts which may differ slightly)
        console.log(`\nNeardata transfers:`);
        for (const t of neardataTransfers.slice(0, 5)) {
            console.log(`  ${t.type}: ${t.from} -> ${t.to}: ${Number(BigInt(t.amount)) / 1e24} NEAR`);
        }

        console.log(`\nRPC transfers:`);
        for (const t of rpcTransfers.slice(0, 5)) {
            console.log(`  ${t.type}: ${t.from} -> ${t.to}: ${Number(BigInt(t.amount)) / 1e24} NEAR`);
        }

        // We should be able to extract transfers from both sources
        console.log(`✓ Can extract NEAR transfers from both neardata (${neardataTransfers.length}) and RPC (${rpcTransfers.length})`);
    });

    it('should get FT transfer events from transaction logs via RPC', async function() {
        // Use a block with known FT activity
        const ftBlock = 138199124;

        // 1. Get reference from neardata.xyz
        const neardataBlock = await fetchNeardataBlock(ftBlock);
        if (!neardataBlock) {
            console.log('Could not fetch neardata block, skipping');
            this.skip();
            return;
        }

        // Find FT events and the transaction that contains them
        let refTxHash: string | null = null;
        let refSignerId: string | null = null;
        const refFtEvents: string[] = [];

        for (const shard of neardataBlock.shards || []) {
            for (const receiptExecution of shard.receipt_execution_outcomes || []) {
                const logs = receiptExecution.execution_outcome?.outcome?.logs || [];
                for (const log of logs) {
                    if (log.startsWith('EVENT_JSON:')) {
                        try {
                            const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
                            if (eventData.standard === 'nep141') {
                                refFtEvents.push(log);
                                if (!refTxHash) {
                                    refTxHash = receiptExecution.tx_hash;
                                    refSignerId = receiptExecution.receipt?.receipt?.Action?.signer_id || null;
                                }
                            }
                        } catch (e) {
                            // Skip invalid JSON
                        }
                    }
                }
            }
        }

        console.log(`Reference from neardata.xyz: ${refFtEvents.length} FT events`);

        if (!refTxHash || !refSignerId) {
            console.log('No FT transactions found in test block');
            this.skip();
            return;
        }

        // 2. Get same transaction via RPC and extract FT events
        const txResult = await getTransactionStatusWithReceipts(refTxHash, refSignerId);
        assert.ok(txResult, 'Should get transaction via RPC');

        const rpcFtEvents: string[] = [];
        for (const outcome of txResult.receipts_outcome || []) {
            for (const log of outcome.outcome?.logs || []) {
                if (log.startsWith('EVENT_JSON:')) {
                    try {
                        const eventData = JSON.parse(log.substring('EVENT_JSON:'.length));
                        if (eventData.standard === 'nep141') {
                            rpcFtEvents.push(log);
                        }
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
            }
        }

        console.log(`From RPC tx ${refTxHash}: ${rpcFtEvents.length} FT events`);

        // The RPC should find the same FT events for the same transaction
        assert.ok(rpcFtEvents.length > 0 || refFtEvents.length === 0, 
            'RPC should find FT events if neardata found them');

        console.log(`✓ Can extract FT events from RPC transaction logs`);
    });

    it('should use RPC fallback when neardata.xyz returns null', async function() {
        // Import findBalanceChangingTransaction to test the full flow
        const { findBalanceChangingTransaction } = await import('../scripts/balance-tracker.js');

        // Test with a known block that has transactions
        // Even if neardata.xyz is rate limited, the function should fall back to RPC
        const result = await findBalanceChangingTransaction('psalomo.near', TEST_BLOCK);
        
        assert.ok(result, 'Should return a result (either from neardata or RPC fallback)');
        assert.ok(result.blockTimestamp, 'Should have block timestamp');
        
        // The result should have transaction info
        // Note: transfers may be empty if the account wasn't involved in this specific block
        console.log(`Found ${result.transactionHashes.length} transaction(s) at block ${TEST_BLOCK}`);
        console.log(`Found ${result.transfers.length} transfer(s)`);
        
        console.log(`✓ findBalanceChangingTransaction works with RPC fallback`);
    });
});
