#!/usr/bin/env npx tsx
/**
 * Migration script to convert existing AccountHistory JSON files from the nested
 * TransactionEntry format to the flat BalanceChangeRecord format.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-flat-format.ts <input-file> [output-file]
 *   npx tsx scripts/migrate-to-flat-format.ts --all  # Convert all files in accounts/ directory
 *
 * The old format has nested balanceBefore/balanceAfter snapshots per transaction.
 * The new format has flat per-token records, one row per balance change.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    createBalanceChangeRecords,
    type BalanceChangeRecord,
    type BalanceChanges,
    type TransferDetail
} from './balance-tracker.js';

// Old format types (for parsing existing files)
interface OldBalanceSnapshot {
    near: string;
    fungibleTokens: Record<string, string>;
    intentsTokens: Record<string, string>;
    stakingPools?: Record<string, string>;
}

interface OldTransactionEntry {
    block: number;
    transactionBlock?: number | null;
    timestamp: number | null;
    transactionHashes: string[];
    transactions: any[];
    transfers?: TransferDetail[];
    balanceBefore?: OldBalanceSnapshot;
    balanceAfter?: OldBalanceSnapshot;
    changes: {
        nearChanged: boolean;
        nearDiff?: string;
        tokensChanged: Record<string, { start: string; end: string; diff: string }>;
        intentsChanged: Record<string, { start: string; end: string; diff: string }>;
        stakingChanged?: Record<string, { start: string; end: string; diff: string }>;
    };
}

interface OldAccountHistory {
    accountId: string;
    createdAt: string;
    updatedAt: string;
    transactions: OldTransactionEntry[];
    stakingPools?: string[];
    metadata: {
        firstBlock: number | null;
        lastBlock: number | null;
        totalTransactions: number;
        historyComplete?: boolean;
    };
}

// New format
export interface AccountHistoryV2 {
    version: 2;
    accountId: string;
    createdAt: string;
    updatedAt: string;
    migratedAt?: string;
    records: BalanceChangeRecord[];
    stakingPools?: string[];
    metadata: {
        firstBlock: number | null;
        lastBlock: number | null;
        totalRecords: number;
        historyComplete?: boolean;
    };
}

/**
 * Convert a single OldTransactionEntry to BalanceChangeRecord[]
 */
function convertEntry(entry: OldTransactionEntry): BalanceChangeRecord[] {
    // Build BalanceChanges from the old entry
    const changes: BalanceChanges = {
        hasChanges: entry.changes.nearChanged ||
            Object.keys(entry.changes.tokensChanged || {}).length > 0 ||
            Object.keys(entry.changes.intentsChanged || {}).length > 0 ||
            Object.keys(entry.changes.stakingChanged || {}).length > 0,
        nearChanged: entry.changes.nearChanged,
        nearDiff: entry.changes.nearDiff,
        tokensChanged: entry.changes.tokensChanged || {},
        intentsChanged: entry.changes.intentsChanged || {},
        stakingChanged: entry.changes.stakingChanged,
        startBalance: entry.balanceBefore ? {
            near: entry.balanceBefore.near,
            fungibleTokens: entry.balanceBefore.fungibleTokens || {},
            intentsTokens: entry.balanceBefore.intentsTokens || {},
            stakingPools: entry.balanceBefore.stakingPools || {}
        } : undefined,
        endBalance: entry.balanceAfter ? {
            near: entry.balanceAfter.near,
            fungibleTokens: entry.balanceAfter.fungibleTokens || {},
            intentsTokens: entry.balanceAfter.intentsTokens || {},
            stakingPools: entry.balanceAfter.stakingPools || {}
        } : undefined
    };

    return createBalanceChangeRecords(
        entry.block,
        entry.timestamp,
        changes,
        entry.transfers,
        entry.transactionHashes
    );
}

/**
 * Migrate an old AccountHistory to the new AccountHistoryV2 format
 */
export function migrateToV2(oldHistory: OldAccountHistory): AccountHistoryV2 {
    const allRecords: BalanceChangeRecord[] = [];

    for (const entry of oldHistory.transactions) {
        const records = convertEntry(entry);
        allRecords.push(...records);
    }

    // Sort by block height descending (most recent first), then by token_id
    allRecords.sort((a, b) => {
        if (b.block_height !== a.block_height) {
            return b.block_height - a.block_height;
        }
        return a.token_id.localeCompare(b.token_id);
    });

    // Calculate block range from records
    let firstBlock: number | null = null;
    let lastBlock: number | null = null;

    if (allRecords.length > 0) {
        const blocks = allRecords.map(r => r.block_height);
        firstBlock = Math.min(...blocks);
        lastBlock = Math.max(...blocks);
    }

    return {
        version: 2,
        accountId: oldHistory.accountId,
        createdAt: oldHistory.createdAt,
        updatedAt: oldHistory.updatedAt,
        migratedAt: new Date().toISOString(),
        records: allRecords,
        stakingPools: oldHistory.stakingPools,
        metadata: {
            firstBlock: firstBlock ?? oldHistory.metadata.firstBlock,
            lastBlock: lastBlock ?? oldHistory.metadata.lastBlock,
            totalRecords: allRecords.length,
            historyComplete: oldHistory.metadata.historyComplete
        }
    };
}

/**
 * Check if a file is already in V2 format
 */
function isV2Format(data: any): data is AccountHistoryV2 {
    return data.version === 2 && Array.isArray(data.records);
}

/**
 * Migrate a single file
 */
function migrateFile(inputPath: string, outputPath?: string): { success: boolean; recordCount: number; error?: string } {
    try {
        const inputData = fs.readFileSync(inputPath, 'utf-8');
        const parsed = JSON.parse(inputData);

        if (isV2Format(parsed)) {
            console.log(`  Skipping ${path.basename(inputPath)} - already in V2 format`);
            return { success: true, recordCount: parsed.records.length };
        }

        const oldHistory = parsed as OldAccountHistory;
        const newHistory = migrateToV2(oldHistory);

        const finalOutputPath = outputPath || inputPath;

        // Create backup before overwriting
        if (!outputPath && fs.existsSync(inputPath)) {
            const backupPath = inputPath.replace('.json', '.backup.json');
            fs.copyFileSync(inputPath, backupPath);
            console.log(`  Backup created: ${path.basename(backupPath)}`);
        }

        const dir = path.dirname(finalOutputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        fs.writeFileSync(finalOutputPath, JSON.stringify(newHistory, null, 2));

        return { success: true, recordCount: newHistory.records.length };
    } catch (error: any) {
        return { success: false, recordCount: 0, error: error.message };
    }
}

/**
 * Print migration summary
 */
function printSummary(inputPath: string, oldEntryCount: number, newRecordCount: number): void {
    console.log(`\nMigration Summary:`);
    console.log(`  Input:  ${oldEntryCount} TransactionEntry objects (nested format)`);
    console.log(`  Output: ${newRecordCount} BalanceChangeRecord objects (flat format)`);
    console.log(`  Expansion ratio: ${(newRecordCount / Math.max(oldEntryCount, 1)).toFixed(2)}x`);
}

// Main execution
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
        console.log(`
Usage:
  npx tsx scripts/migrate-to-flat-format.ts <input-file> [output-file]
  npx tsx scripts/migrate-to-flat-format.ts --all

Options:
  --all         Convert all JSON files in the accounts/ directory
  --help, -h    Show this help message

Examples:
  npx tsx scripts/migrate-to-flat-format.ts accounts/myaccount.near.json
  npx tsx scripts/migrate-to-flat-format.ts old.json new-v2.json
  npx tsx scripts/migrate-to-flat-format.ts --all
`);
        process.exit(0);
    }

    if (args.includes('--all')) {
        // Migrate all files in accounts/ directory
        const accountsDir = path.join(process.cwd(), 'accounts');

        if (!fs.existsSync(accountsDir)) {
            console.error(`Error: accounts/ directory not found`);
            process.exit(1);
        }

        const files = fs.readdirSync(accountsDir)
            .filter(f => f.endsWith('.json') && !f.endsWith('.backup.json'));

        if (files.length === 0) {
            console.log('No JSON files found in accounts/ directory');
            process.exit(0);
        }

        console.log(`Migrating ${files.length} file(s) to V2 format...\n`);

        let successCount = 0;
        let skipCount = 0;
        let errorCount = 0;
        let totalRecords = 0;

        for (const file of files) {
            const filePath = path.join(accountsDir, file);
            console.log(`Processing ${file}...`);

            const result = migrateFile(filePath);

            if (result.success) {
                if (result.recordCount > 0) {
                    console.log(`  Converted to ${result.recordCount} records`);
                    successCount++;
                    totalRecords += result.recordCount;
                } else {
                    skipCount++;
                }
            } else {
                console.error(`  Error: ${result.error}`);
                errorCount++;
            }
        }

        console.log(`\nMigration complete:`);
        console.log(`  Success: ${successCount} file(s)`);
        console.log(`  Skipped: ${skipCount} file(s) (already V2)`);
        console.log(`  Errors:  ${errorCount} file(s)`);
        console.log(`  Total records: ${totalRecords}`);

        process.exit(errorCount > 0 ? 1 : 0);
    }

    // Single file migration
    const inputFile = args[0];
    const outputFile = args[1];

    if (!inputFile) {
        console.error('Error: Input file required');
        process.exit(1);
    }

    if (!fs.existsSync(inputFile)) {
        console.error(`Error: File not found: ${inputFile}`);
        process.exit(1);
    }

    console.log(`Migrating ${inputFile} to V2 format...`);

    // Get old entry count for summary
    const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf-8'));

    if (isV2Format(inputData)) {
        console.log('File is already in V2 format. Nothing to do.');
        process.exit(0);
    }

    const oldEntryCount = (inputData as OldAccountHistory).transactions?.length || 0;

    const result = migrateFile(inputFile, outputFile);

    if (result.success) {
        printSummary(inputFile, oldEntryCount, result.recordCount);
        console.log(`\nOutput written to: ${outputFile || inputFile}`);
    } else {
        console.error(`\nError: ${result.error}`);
        process.exit(1);
    }
}

// Only run main() when executed directly, not when imported
if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(console.error);
}
