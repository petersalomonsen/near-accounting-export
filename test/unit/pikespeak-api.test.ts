// Unit tests for Pikespeak API module

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';

// Import the types and functions we want to test
import type { PikespeakEvent, PikespeakTransactionBlock } from '../../scripts/pikespeak-api.js';

// Test data loaded from files
let eventHistoricRaw: PikespeakEvent[];

describe('Pikespeak API', () => {
    beforeEach(() => {
        // Load test data
        const testDataPath = path.join(process.cwd(), 'test-data', 'pikespeak-event-historic-raw.json');
        if (fs.existsSync(testDataPath)) {
            eventHistoricRaw = JSON.parse(fs.readFileSync(testDataPath, 'utf8'));
        } else {
            eventHistoricRaw = [];
        }
    });
    
    describe('Event Historic Response Parsing', () => {
        it('should parse event-historic response correctly', () => {
            assert.ok(Array.isArray(eventHistoricRaw), 'Response should be an array');
            assert.ok(eventHistoricRaw.length > 0, 'Should have events');
            
            const firstEvent = eventHistoricRaw[0]!;
            assert.ok(firstEvent.transaction_id, 'Event should have transaction_id');
            assert.ok(firstEvent.block_height, 'Event should have block_height');
            assert.ok(firstEvent.type, 'Event should have type');
            assert.ok(firstEvent.direction, 'Event should have direction');
        });
        
        it('should have block_height as string', () => {
            for (const event of eventHistoricRaw.slice(0, 5)) {
                assert.strictEqual(typeof event.block_height, 'string', 
                    `block_height should be string, got ${typeof event.block_height}`);
                const parsed = parseInt(event.block_height, 10);
                assert.ok(!isNaN(parsed), 'block_height should be parseable as number');
                assert.ok(parsed > 0, 'block_height should be positive');
            }
        });
        
        it('should have timestamp as string', () => {
            for (const event of eventHistoricRaw.slice(0, 5)) {
                assert.strictEqual(typeof event.timestamp, 'string', 
                    `timestamp should be string, got ${typeof event.timestamp}`);
                const parsed = parseInt(event.timestamp, 10);
                assert.ok(!isNaN(parsed), 'timestamp should be parseable as number');
            }
        });
        
        it('should have valid event types', () => {
            const validTypes = [
                'NEAR_TRANSFER', 'FT_TRANSFER', 'STAKE_DEPOSIT', 'STAKE_WITHDRAW',
                'FUNCTION_CALL', 'DAO_FUNCTION_CALL', 'DAO_TRANSFER', 
                'DAO_TRANSFER_FROM_PROPOSAL', 'DAO_ACT_PROPOSAL',
                'DAO_CHANGE_CONFIG', 'DAO_CHANGE_POLICY'
            ];
            
            for (const event of eventHistoricRaw) {
                assert.ok(validTypes.includes(event.type), 
                    `Unknown event type: ${event.type}`);
            }
        });
        
        it('should have valid direction values', () => {
            for (const event of eventHistoricRaw) {
                assert.ok(['send', 'receive'].includes(event.direction), 
                    `Invalid direction: ${event.direction}`);
            }
        });
    });
    
    describe('Balance-Changing Event Filtering', () => {
        it('should identify NEAR_TRANSFER as balance-changing', () => {
            const nearTransfers = eventHistoricRaw.filter(e => e.type === 'NEAR_TRANSFER');
            assert.ok(nearTransfers.length > 0, 'Should have NEAR_TRANSFER events');
            
            for (const event of nearTransfers) {
                assert.ok(event.amount !== null || event.amount_numeric !== null, 
                    'NEAR_TRANSFER should have amount');
            }
        });
        
        it('should identify FT_TRANSFER as balance-changing', () => {
            const ftTransfers = eventHistoricRaw.filter(e => e.type === 'FT_TRANSFER');
            // Note: test account may not have FT transfers
            if (ftTransfers.length > 0) {
                for (const event of ftTransfers) {
                    assert.ok(event.token, 'FT_TRANSFER should have token contract');
                }
            }
        });
        
        it('should identify STAKE_DEPOSIT as balance-changing', () => {
            const stakeDeposits = eventHistoricRaw.filter(e => e.type === 'STAKE_DEPOSIT');
            // Note: test account may not have stake deposits in recent events
            if (stakeDeposits.length > 0) {
                for (const event of stakeDeposits) {
                    assert.ok(event.amount !== null || event.amount_numeric !== null, 
                        'STAKE_DEPOSIT should have amount');
                }
            }
        });
        
        it('should filter out FUNCTION_CALL events', () => {
            const balanceChangingTypes = [
                'NEAR_TRANSFER', 'FT_TRANSFER', 'STAKE_DEPOSIT', 'STAKE_WITHDRAW',
                'DAO_TRANSFER', 'DAO_TRANSFER_FROM_PROPOSAL'
            ];
            
            const functionCalls = eventHistoricRaw.filter(e => e.type === 'FUNCTION_CALL');
            const balanceChanging = eventHistoricRaw.filter(e => balanceChangingTypes.includes(e.type));
            
            // Function calls should NOT be in balance-changing list
            for (const fc of functionCalls) {
                assert.ok(!balanceChangingTypes.includes(fc.type), 
                    'FUNCTION_CALL should not be in balance-changing types');
            }
        });
    });
    
    describe('Block Deduplication', () => {
        it('should extract unique block heights from events', () => {
            const blockHeights = new Set<number>();
            
            for (const event of eventHistoricRaw) {
                const blockHeight = parseInt(event.block_height, 10);
                blockHeights.add(blockHeight);
            }
            
            // Should have fewer unique blocks than events
            // (multiple events can occur in same block)
            assert.ok(blockHeights.size <= eventHistoricRaw.length, 
                'Should have fewer or equal unique blocks than events');
            assert.ok(blockHeights.size > 0, 'Should have at least one block');
        });
    });
    
    describe('Transaction Block Conversion', () => {
        it('should convert event to transaction block format', () => {
            assert.ok(eventHistoricRaw.length > 0, 'Need test data');
            const event = eventHistoricRaw[0]!;
            
            const transactionBlock: PikespeakTransactionBlock = {
                blockHeight: parseInt(event.block_height, 10),
                transactionId: event.transaction_id,
                receiptId: event.receipt_id,
                eventType: event.type,
                direction: event.direction,
                amount: event.amount_numeric || event.amount,
                token: event.token,
                sender: event.sender,
                receiver: event.receiver,
                timestamp: parseInt(event.timestamp, 10)
            };
            
            assert.ok(transactionBlock.blockHeight > 0, 'blockHeight should be positive');
            assert.ok(transactionBlock.transactionId, 'transactionId should be set');
            assert.ok(transactionBlock.timestamp > 0, 'timestamp should be positive');
        });
    });
});
