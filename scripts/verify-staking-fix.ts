#!/usr/bin/env tsx
// Manual verification script for staking pool balance fix
// Run this when RPC is available to verify the fix works correctly

import dotenv from 'dotenv';
dotenv.config();

import { findBalanceChangingTransaction, getStakingPoolBalances } from './balance-tracker.js';
import { enrichBalanceSnapshot } from './balance-tracker.js';

const accountId = 'petermusic.near';
const stakingPool = 'astro-stakers.poolv1.near';
const depositBlock = 161869264;

console.log('=== Verifying Staking Pool Balance Fix ===\n');
console.log(`Account: ${accountId}`);
console.log(`Staking Pool: ${stakingPool}`);
console.log(`Transaction Block: ${depositBlock}\n`);

// Test 1: Find the transaction and verify it has the deposit_and_stake transfer
console.log('Test 1: Finding deposit_and_stake transaction...');
try {
    const txInfo = await findBalanceChangingTransaction(accountId, depositBlock);
    
    console.log(`  Transaction hashes: ${txInfo.transactionHashes.length}`);
    console.log(`  Transfers found: ${txInfo.transfers.length}`);
    
    const stakingTransfer = txInfo.transfers.find(t => 
        t.counterparty === stakingPool &&
        t.memo === 'deposit_and_stake'
    );
    
    if (stakingTransfer) {
        console.log(`  ✓ Found deposit_and_stake transfer:`);
        console.log(`    Amount: ${stakingTransfer.amount} yoctoNEAR`);
        console.log(`    Counterparty: ${stakingTransfer.counterparty}`);
    } else {
        console.log(`  ✗ deposit_and_stake transfer NOT found`);
    }
} catch (error: any) {
    console.log(`  ✗ Error: ${error.message}`);
}

console.log('');

// Test 2: Query staking pool balance at block-1 (balanceBefore)
console.log('Test 2: Querying staking pool balance at block-1 (balanceBefore)...');
try {
    const balanceBefore = await getStakingPoolBalances(accountId, depositBlock - 1, [stakingPool]);
    const beforeAmount = BigInt(balanceBefore[stakingPool] || '0');
    
    console.log(`  Balance at block ${depositBlock - 1}:`);
    console.log(`    ${stakingPool}: ${beforeAmount} yoctoNEAR`);
    console.log(`    ~${Number(beforeAmount) / 1e24} NEAR`);
    
    if (beforeAmount > 0n) {
        console.log(`  ✓ Account has existing stake before deposit`);
    } else {
        console.log(`  ✗ Expected non-zero balance before deposit`);
    }
} catch (error: any) {
    console.log(`  ✗ Error: ${error.message}`);
}

console.log('');

// Test 3: Query staking pool balance at block (balanceAfter)
console.log('Test 3: Querying staking pool balance at block (balanceAfter)...');
try {
    const balanceAfter = await getStakingPoolBalances(accountId, depositBlock, [stakingPool]);
    const afterAmount = BigInt(balanceAfter[stakingPool] || '0');
    
    console.log(`  Balance at block ${depositBlock}:`);
    console.log(`    ${stakingPool}: ${afterAmount} yoctoNEAR`);
    console.log(`    ~${Number(afterAmount) / 1e24} NEAR`);
    
    if (afterAmount >= BigInt('1442000000000000000000000000')) {
        console.log(`  ✓ Balance increased after deposit (expected ~1442 NEAR)`);
    } else {
        console.log(`  ✗ Expected balance >= 1442 NEAR after deposit`);
    }
} catch (error: any) {
    console.log(`  ✗ Error: ${error.message}`);
}

console.log('');

// Test 4: Verify the 1000 NEAR deposit amount
console.log('Test 4: Verifying 1000 NEAR deposit by comparing balances...');
try {
    const balanceBefore = await getStakingPoolBalances(accountId, depositBlock - 1, [stakingPool]);
    const balanceAfter = await getStakingPoolBalances(accountId, depositBlock, [stakingPool]);
    
    const before = BigInt(balanceBefore[stakingPool] || '0');
    const after = BigInt(balanceAfter[stakingPool] || '0');
    const diff = after - before;
    
    console.log(`  Balance change:`);
    console.log(`    Before: ${before} yoctoNEAR (~${Number(before) / 1e24} NEAR)`);
    console.log(`    After: ${after} yoctoNEAR (~${Number(after) / 1e24} NEAR)`);
    console.log(`    Diff: ${diff} yoctoNEAR (~${Number(diff) / 1e24} NEAR)`);
    
    if (diff >= BigInt('999000000000000000000000000') && diff <= BigInt('1001000000000000000000000000')) {
        console.log(`  ✓ Deposit amount is ~1000 NEAR as expected`);
    } else {
        console.log(`  ✗ Expected deposit of ~1000 NEAR`);
    }
} catch (error: any) {
    console.log(`  ✗ Error: ${error.message}`);
}

console.log('\n=== Verification Complete ===');
