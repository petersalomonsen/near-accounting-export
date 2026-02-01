#!/usr/bin/env npx tsx
/**
 * Generate a markdown report from account history JSON
 */

import fs from 'fs';
import path from 'path';

interface BalanceChangeRecord {
    block_height: number;
    block_timestamp: string | null;
    tx_hash: string | null;
    token_id: string;
    counterparty: string | null;
    amount: string;
    balance_before: string;
    balance_after: string;
}

interface AccountHistory {
    version: 2;
    accountId: string;
    records: BalanceChangeRecord[];
    metadata: {
        firstBlock: number | null;
        lastBlock: number | null;
        totalRecords: number;
        historyComplete?: boolean;
    };
}

// Format large numbers with NEAR decimals (24)
function formatNear(amount: string): string {
    const absAmount = amount.startsWith('-') ? amount.slice(1) : amount;
    const isNegative = amount.startsWith('-');

    // Pad with leading zeros if needed
    const padded = absAmount.padStart(25, '0');
    const whole = padded.slice(0, -24) || '0';
    const decimal = padded.slice(-24, -24 + 4); // 4 decimal places

    const formatted = `${whole}.${decimal}`;
    return isNegative ? `-${formatted}` : formatted;
}

// Format with custom decimals
function formatAmount(amount: string, decimals: number): string {
    const absAmount = amount.startsWith('-') ? amount.slice(1) : amount;
    const isNegative = amount.startsWith('-');

    if (decimals === 0) return isNegative ? `-${absAmount}` : absAmount;

    const padded = absAmount.padStart(decimals + 1, '0');
    const whole = padded.slice(0, -decimals) || '0';
    const decimal = padded.slice(-decimals, -decimals + 4).replace(/0+$/, '') || '0';

    const formatted = `${whole}.${decimal}`;
    return isNegative ? `-${formatted}` : formatted;
}

// Get token decimals
function getDecimals(tokenId: string): number {
    if (tokenId === 'near') return 24;
    if (tokenId.includes('.poolv1.near') || tokenId.includes('.pool.near')) return 24;
    if (tokenId === 'wrap.near' || tokenId.includes('nep141:wrap.near')) return 24;
    if (tokenId.includes('nep141:eth.omft.near')) return 18;
    if (tokenId.includes('nep141:btc.omft.near')) return 8;
    if (tokenId.includes('usdc') || tokenId.includes('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')) return 6;
    if (tokenId.includes('usdt')) return 6;
    return 18; // default
}

// Get human-readable token name
function getTokenName(tokenId: string): string {
    if (tokenId === 'near') return 'NEAR';
    if (tokenId === 'wrap.near') return 'wNEAR';
    if (tokenId === '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1') return 'USDC';
    if (tokenId.includes('nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')) return 'USDC (Intent)';
    if (tokenId === 'usdt.tether-token.near') return 'USDT';
    if (tokenId.includes('nep141:wrap.near')) return 'wNEAR (Intent)';
    if (tokenId.includes('nep141:eth.omft.near')) return 'ETH (Intent)';
    if (tokenId.includes('nep141:btc.omft.near')) return 'BTC (Intent)';
    if (tokenId === 'arizcredits.near') return 'ARIZ';
    if (tokenId.includes('poolv1.near')) return `STAKING:${tokenId.split('.')[0]}`;
    if (tokenId.includes('a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near')) return 'USDC (Bridge)';
    if (tokenId.includes('dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near')) return 'USDT (Bridge)';
    if (tokenId === 'richenear.tkn.near') return 'RICHE';
    if (tokenId === 'npro.nearmobile.near') return 'NPRO';
    return tokenId;
}

// Main report generation
function generateReport(inputFile: string): string {
    const data: AccountHistory = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));
    const { accountId, records, metadata } = data;

    // Group records by date
    const byDate = new Map<string, BalanceChangeRecord[]>();
    for (const record of records) {
        const date = record.block_timestamp
            ? record.block_timestamp.split('T')[0]
            : 'Unknown';
        if (!byDate.has(date!)) byDate.set(date!, []);
        byDate.get(date!)!.push(record);
    }

    // Sort dates
    const sortedDates = [...byDate.keys()].sort();

    // Calculate totals by token
    const tokenTotals = new Map<string, { received: bigint; sent: bigint; balance: string }>();
    for (const record of records) {
        if (!tokenTotals.has(record.token_id)) {
            tokenTotals.set(record.token_id, { received: 0n, sent: 0n, balance: '0' });
        }
        const totals = tokenTotals.get(record.token_id)!;
        const amount = BigInt(record.amount);
        if (amount > 0n) {
            totals.received += amount;
        } else {
            totals.sent += -amount;
        }
        totals.balance = record.balance_after;
    }

    // Calculate interactions by counterparty
    const counterpartyStats = new Map<string, { count: number; received: bigint; sent: bigint }>();
    for (const record of records) {
        if (record.token_id !== 'near') continue;
        const cp = record.counterparty || 'unknown';
        if (!counterpartyStats.has(cp)) {
            counterpartyStats.set(cp, { count: 0, received: 0n, sent: 0n });
        }
        const stats = counterpartyStats.get(cp)!;
        stats.count++;
        const amount = BigInt(record.amount);
        if (amount > 0n) {
            stats.received += amount;
        } else {
            stats.sent += -amount;
        }
    }

    // Staking pools summary
    const stakingPools = new Map<string, { deposits: bigint; withdrawals: bigint; rewards: bigint; balance: string }>();
    for (const record of records) {
        if (!record.token_id.includes('.pool')) continue;
        const pool = record.token_id;
        if (!stakingPools.has(pool)) {
            stakingPools.set(pool, { deposits: 0n, withdrawals: 0n, rewards: 0n, balance: '0' });
        }
        const stats = stakingPools.get(pool)!;
        const amount = BigInt(record.amount);
        // Staking rewards are positive amounts with pool as counterparty and no tx_hash
        if (amount > 0n && !record.tx_hash) {
            stats.rewards += amount;
        } else if (amount > 0n) {
            stats.deposits += amount;
        } else {
            stats.withdrawals += -amount;
        }
        stats.balance = record.balance_after;
    }

    // Build markdown report
    let md = `# Account History Report: ${accountId}\n\n`;
    md += `**Generated:** ${new Date().toISOString()}\n\n`;
    md += `**Period:** ${sortedDates[0]} to ${sortedDates[sortedDates.length - 1]}\n\n`;
    md += `**Total Records:** ${metadata.totalRecords}\n\n`;
    md += `**History Complete:** ${metadata.historyComplete ? 'Yes' : 'No'}\n\n`;

    // Current Balances Summary
    md += `## Current Balances\n\n`;
    md += `| Token | Balance |\n`;
    md += `|-------|--------|\n`;

    // Sort by balance value for NEAR first, then others
    const sortedTokens = [...tokenTotals.entries()].sort((a, b) => {
        if (a[0] === 'near') return -1;
        if (b[0] === 'near') return 1;
        return a[0].localeCompare(b[0]);
    });

    for (const [tokenId, totals] of sortedTokens) {
        if (BigInt(totals.balance) === 0n) continue;
        const decimals = getDecimals(tokenId);
        const name = getTokenName(tokenId);
        md += `| ${name} | ${formatAmount(totals.balance, decimals)} |\n`;
    }

    // Staking Summary
    md += `\n## Staking Pools Summary\n\n`;
    md += `| Pool | Current Balance | Total Rewards | Deposits | Withdrawals |\n`;
    md += `|------|-----------------|---------------|----------|-------------|\n`;

    let totalStakingRewards = 0n;
    for (const [pool, stats] of stakingPools) {
        const name = pool.split('.')[0];
        md += `| ${name} | ${formatNear(stats.balance)} | ${formatNear(stats.rewards.toString())} | ${formatNear(stats.deposits.toString())} | ${formatNear(stats.withdrawals.toString())} |\n`;
        totalStakingRewards += stats.rewards;
    }
    md += `| **TOTAL REWARDS** | - | **${formatNear(totalStakingRewards.toString())}** | - | - |\n`;

    // NEAR Flow Summary
    const nearTotals = tokenTotals.get('near');
    if (nearTotals) {
        md += `\n## NEAR Flow Summary\n\n`;
        md += `| Metric | Amount (NEAR) |\n`;
        md += `|--------|---------------|\n`;
        md += `| Total Received | ${formatNear(nearTotals.received.toString())} |\n`;
        md += `| Total Sent | ${formatNear(nearTotals.sent.toString())} |\n`;
        md += `| Net Flow | ${formatNear((nearTotals.received - nearTotals.sent).toString())} |\n`;
        md += `| Current Balance | ${formatNear(nearTotals.balance)} |\n`;
    }

    // Top Counterparties (NEAR only)
    md += `\n## Top Counterparties (NEAR)\n\n`;
    md += `| Account | Transactions | Received | Sent |\n`;
    md += `|---------|--------------|----------|------|\n`;

    const sortedCounterparties = [...counterpartyStats.entries()]
        .filter(([cp]) => !cp.includes('.pool') && cp !== 'system')
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 20);

    for (const [cp, stats] of sortedCounterparties) {
        md += `| ${cp} | ${stats.count} | ${formatNear(stats.received.toString())} | ${formatNear(stats.sent.toString())} |\n`;
    }

    // Daily Activity - compute end-of-day balances and daily flows
    md += `\n## Daily Activity\n\n`;
    md += `| Date | Total Balance | NEAR Balance | Staking Balance | Staking Rewards | Received | Sent |\n`;
    md += `|------|---------------|--------------|-----------------|-----------------|----------|------|\n`;

    // Sort records by block height to track running balances
    const sortedRecords = [...records].sort((a, b) => a.block_height - b.block_height);

    // Track end-of-day balances per token
    const dailyEndBalances = new Map<string, Map<string, bigint>>(); // date -> tokenId -> balance
    const dailyFlows = new Map<string, { received: bigint; sent: bigint; stakingRewards: bigint }>();

    for (const record of sortedRecords) {
        const date = record.block_timestamp?.split('T')[0] || 'Unknown';

        // Initialize date maps if needed
        if (!dailyEndBalances.has(date)) {
            dailyEndBalances.set(date, new Map());
        }
        if (!dailyFlows.has(date)) {
            dailyFlows.set(date, { received: 0n, sent: 0n, stakingRewards: 0n });
        }

        // Update end-of-day balance for this token
        dailyEndBalances.get(date)!.set(record.token_id, BigInt(record.balance_after));

        // Track flows
        const amount = BigInt(record.amount);
        const flows = dailyFlows.get(date)!;

        if (record.token_id === 'near') {
            // External transfers (not to/from staking pools)
            const isStakingCounterparty = record.counterparty?.includes('.pool') || false;
            if (!isStakingCounterparty) {
                if (amount > 0n) {
                    flows.received += amount;
                } else {
                    flows.sent += -amount;
                }
            }
        } else if (record.token_id.includes('.pool')) {
            // Staking rewards (positive amounts without tx_hash)
            if (amount > 0n && !record.tx_hash) {
                flows.stakingRewards += amount;
            }
        }
    }

    // Build running balance tracker (carry forward from previous days)
    const runningBalances = new Map<string, bigint>(); // tokenId -> balance

    for (const date of sortedDates) {
        const dayBalances = dailyEndBalances.get(date);
        const flows = dailyFlows.get(date) || { received: 0n, sent: 0n, stakingRewards: 0n };

        // Update running balances with today's end balances
        if (dayBalances) {
            for (const [tokenId, balance] of dayBalances) {
                runningBalances.set(tokenId, balance);
            }
        }

        // Calculate totals from running balances
        let nearBalance = 0n;
        let stakingBalance = 0n;

        for (const [tokenId, balance] of runningBalances) {
            if (tokenId === 'near') {
                nearBalance = balance;
            } else if (tokenId.includes('.pool')) {
                stakingBalance += balance;
            }
        }

        const totalBalance = nearBalance + stakingBalance;

        md += `| ${date} | ${formatNear(totalBalance.toString())} | ${formatNear(nearBalance.toString())} | ${formatNear(stakingBalance.toString())} | ${formatNear(flows.stakingRewards.toString())} | ${formatNear(flows.received.toString())} | ${formatNear(flows.sent.toString())} |\n`;
    }

    return md;
}

// Main
const inputFile = process.argv[2];
if (!inputFile) {
    console.error('Usage: npx tsx scripts/generate-account-report.ts <input.json>');
    process.exit(1);
}

const report = generateReport(inputFile);
const outputFile = inputFile.replace('.json', '-report.md');
fs.writeFileSync(outputFile, report);
console.log(`Report generated: ${outputFile}`);
