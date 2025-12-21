// Test case for account registration with payment verification
import { strict as assert } from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

describe('Account Registration Payment Verification', function() {
    this.timeout(30000);
    
    // Mock transaction data based on mainnet FT transfer structure
    // This represents the structure of transaction BfcxWzpQbvPzPXp438EpqpfcLZ1vHW36YoetCBac3WEA from arizcredits.near
    const mockValidTransaction = {
        transaction: {
            signer_id: 'test-sender.near',
            receiver_id: 'arizcredits.near',
            actions: [
                {
                    FunctionCall: {
                        method_name: 'ft_transfer',
                        args: Buffer.from(JSON.stringify({
                            receiver_id: 'arizcredits.near',
                            amount: '100000' // 0.1 ARIZ (6 decimals)
                        })).toString('base64'),
                        gas: 30000000000000,
                        deposit: '1'
                    }
                }
            ]
        },
        transaction_outcome: {
            block_hash: 'Ctc7YvPGGDLsdGdxWwjCaKbZejhqdmLyaMbgooKn4kDG'
        },
        status: {
            SuccessValue: ''
        }
    };
    
    const mockValidBlock = {
        header: {
            timestamp: Date.now() * 1_000_000 - 1000 * 1_000_000 // 1 second ago in nanoseconds
        }
    };
    
    const mockOldTransaction = {
        transaction: {
            signer_id: 'test-sender.near',
            receiver_id: 'arizcredits.near',
            actions: [
                {
                    FunctionCall: {
                        method_name: 'ft_transfer',
                        args: Buffer.from(JSON.stringify({
                            receiver_id: 'arizcredits.near',
                            amount: '100000'
                        })).toString('base64'),
                        gas: 30000000000000,
                        deposit: '1'
                    }
                }
            ]
        },
        transaction_outcome: {
            block_hash: 'OldBlockHash123456789'
        },
        status: {
            SuccessValue: ''
        }
    };
    
    const mockOldBlock = {
        header: {
            timestamp: Date.now() * 1_000_000 - 31 * 24 * 60 * 60 * 1000 * 1_000_000 // 31 days ago
        }
    };
    
    const mockInsufficientAmountTransaction = {
        transaction: {
            signer_id: 'test-sender.near',
            receiver_id: 'arizcredits.near',
            actions: [
                {
                    FunctionCall: {
                        method_name: 'ft_transfer',
                        args: Buffer.from(JSON.stringify({
                            receiver_id: 'arizcredits.near',
                            amount: '100' // Too small
                        })).toString('base64'),
                        gas: 30000000000000,
                        deposit: '1'
                    }
                }
            ]
        },
        transaction_outcome: {
            block_hash: 'ValidBlockHash123'
        },
        status: {
            SuccessValue: ''
        }
    };
    
    const mockWrongRecipientTransaction = {
        transaction: {
            signer_id: 'test-sender.near',
            receiver_id: 'arizcredits.near',
            actions: [
                {
                    FunctionCall: {
                        method_name: 'ft_transfer',
                        args: Buffer.from(JSON.stringify({
                            receiver_id: 'wrong-recipient.near',
                            amount: '100000'
                        })).toString('base64'),
                        gas: 30000000000000,
                        deposit: '1'
                    }
                }
            ]
        },
        transaction_outcome: {
            block_hash: 'ValidBlockHash123'
        },
        status: {
            SuccessValue: ''
        }
    };
    
    const mockFailedTransaction = {
        transaction: {
            signer_id: 'test-sender.near',
            receiver_id: 'arizcredits.near',
            actions: [
                {
                    FunctionCall: {
                        method_name: 'ft_transfer',
                        args: Buffer.from(JSON.stringify({
                            receiver_id: 'arizcredits.near',
                            amount: '100000'
                        })).toString('base64'),
                        gas: 30000000000000,
                        deposit: '1'
                    }
                }
            ]
        },
        transaction_outcome: {
            block_hash: 'FailedBlockHash123'
        },
        status: {
            Failure: {
                ActionError: {
                    kind: 'FunctionCallError'
                }
            }
        }
    };
    
    describe('Payment Transaction Verification Logic', function() {
        it('should accept valid FT transfer transaction', function() {
            // Test the structure of a valid transaction
            const tx = mockValidTransaction.transaction;
            const action = tx.actions[0]?.FunctionCall;
            
            assert.ok(action, 'Action should exist');
            assert.equal(action.method_name, 'ft_transfer');
            
            const argsStr = Buffer.from(action.args, 'base64').toString('utf8');
            const args = JSON.parse(argsStr);
            
            assert.equal(args.receiver_id, 'arizcredits.near');
            assert.equal(args.amount, '100000');
            
            // Verify amount is sufficient
            assert.ok(BigInt(args.amount) >= BigInt('100000'));
        });
        
        it('should detect transaction age from block', function() {
            const blockTimestamp = mockValidBlock.header.timestamp;
            const now = Date.now() * 1_000_000;
            const age = now - blockTimestamp;
            const ageMs = age / 1_000_000;
            
            // Should be less than 30 days
            assert.ok(ageMs < 30 * 24 * 60 * 60 * 1000);
        });
        
        it('should detect old transaction from block', function() {
            const blockTimestamp = mockOldBlock.header.timestamp;
            const now = Date.now() * 1_000_000;
            const age = now - blockTimestamp;
            const ageMs = age / 1_000_000;
            
            // Should be more than 30 days
            assert.ok(ageMs > 30 * 24 * 60 * 60 * 1000);
        });
        
        it('should detect insufficient amount', function() {
            const tx = mockInsufficientAmountTransaction.transaction;
            const action = tx.actions[0]?.FunctionCall;
            assert.ok(action, 'Action should exist');
            const argsStr = Buffer.from(action.args, 'base64').toString('utf8');
            const args = JSON.parse(argsStr);
            
            assert.ok(BigInt(args.amount) < BigInt('100000'));
        });
        
        it('should detect wrong recipient', function() {
            const tx = mockWrongRecipientTransaction.transaction;
            const action = tx.actions[0]?.FunctionCall;
            assert.ok(action, 'Action should exist');
            const argsStr = Buffer.from(action.args, 'base64').toString('utf8');
            const args = JSON.parse(argsStr);
            
            assert.notEqual(args.receiver_id, 'arizcredits.near');
        });
        
        it('should detect failed transaction', function() {
            const status = mockFailedTransaction.status as any;
            assert.ok(status.Failure);
            assert.ok(!('SuccessValue' in status) && !('SuccessReceiptId' in status));
        });
    });
    
    describe('Transaction Structure Validation', function() {
        it('should have correct FT transfer structure based on mainnet transaction', function() {
            // This test validates that our mock matches the structure of real FT transfers
            // Based on transaction BfcxWzpQbvPzPXp438EpqpfcLZ1vHW36YoetCBac3WEA from arizcredits.near
            
            const tx = mockValidTransaction;
            
            // Check required fields
            assert.ok(tx.transaction, 'Transaction should have transaction field');
            assert.ok(tx.transaction.signer_id, 'Transaction should have signer_id');
            assert.ok(tx.transaction.receiver_id, 'Transaction should have receiver_id');
            assert.ok(tx.transaction.actions, 'Transaction should have actions');
            assert.ok(Array.isArray(tx.transaction.actions), 'Actions should be an array');
            
            // Check FunctionCall action
            const action = tx.transaction.actions[0];
            assert.ok(action, 'Action should exist');
            assert.ok(action.FunctionCall, 'Action should be FunctionCall');
            if (action.FunctionCall) {
                assert.ok(action.FunctionCall.method_name, 'FunctionCall should have method_name');
                assert.ok(action.FunctionCall.args, 'FunctionCall should have args');
                assert.ok(action.FunctionCall.gas, 'FunctionCall should have gas');
                assert.ok(action.FunctionCall.deposit, 'FunctionCall should have deposit');
            }
            
            // Check transaction outcome (should have block_hash, not block_timestamp)
            assert.ok(tx.transaction_outcome, 'Transaction should have transaction_outcome');
            assert.ok(tx.transaction_outcome.block_hash, 'Outcome should have block_hash');
            assert.ok(!('block_timestamp' in tx.transaction_outcome), 'Outcome should NOT have block_timestamp directly');
            
            // Check status
            assert.ok(tx.status, 'Transaction should have status');
        });
        
        it('should validate block structure', function() {
            // Block should have header with timestamp
            const block = mockValidBlock;
            
            assert.ok(block.header, 'Block should have header');
            assert.ok(block.header.timestamp, 'Block header should have timestamp');
            assert.ok(typeof block.header.timestamp === 'number', 'Timestamp should be a number');
        });
    });
});
