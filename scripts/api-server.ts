#!/usr/bin/env node
// API Server for NEAR Accounting Export
// Provides REST endpoints for account data collection and downloads

import express from 'express';
import type { Request, Response, NextFunction, Router } from 'express';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

import { getAccountHistory, reEnrichFTBalances, repairMissingStakingRecordsV2, repairInvalidStakingRewards, repairStakingDepositsWithoutTxHash, repairNullTimestamps } from './get-account-history.js';
import { convertJsonToCsv } from './json-to-csv.js';
import { callViewFunction } from './rpc.js';
import { detectGapsV2 } from './gap-detection.js';
import { migrateToV2 } from './migrate-to-flat-format.js';
import { isStakingPool } from './balance-tracker.js';
import { syncFtTransfersForAccount } from './transfers-sync.js';
import type { GapAnalysisV2 } from './gap-detection.js';
import type { BalanceChangeRecord } from './balance-tracker.js';

// Continuous sync configuration
const SYNC_CONFIG = {
    batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
    cycleDelayMs: parseInt(process.env.CYCLE_DELAY_MS || '60000', 10),  // 1 minute loop check interval
    maxEpochsPerCycle: parseInt(process.env.MAX_EPOCHS_PER_CYCLE || '50', 10),
    accountTimeoutMs: parseInt(process.env.ACCOUNT_TIMEOUT_MS || '300000', 10), // 5 minutes default
    completeAccountIntervalMs: parseInt(process.env.COMPLETE_ACCOUNT_INTERVAL_MS || '28800000', 10),    // 8 hours for complete accounts
    incompleteAccountIntervalMs: parseInt(process.env.INCOMPLETE_ACCOUNT_INTERVAL_MS || '300000', 10),  // 5 min for accounts with gaps
};

// Types
interface RegisteredAccount {
    accountId: string;
    registeredAt: string;
}

interface Job {
    jobId: string;
    accountId: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    error?: string;
    options: {
        direction?: 'forward' | 'backward';
        maxTransactions?: number;
        startBlock?: number;
        endBlock?: number;
    };
}

interface JobsDb {
    jobs: Record<string, Job>;
}

interface AccountsDb {
    accounts: Record<string, RegisteredAccount>;
}

interface AccountHistoryMetadata {
    historyComplete?: boolean;
    firstBlock: number | null;
    lastBlock: number | null;
    totalRecords: number;
}

interface AccountHistoryFile {
    version: 2;
    accountId: string;
    metadata: AccountHistoryMetadata;
    records: BalanceChangeRecord[];
}

// Router configuration options
export interface RouterConfig {
    /**
     * Hook function that extracts the authenticated account ID from the request.
     * Should throw an error if the request is not authenticated.
     */
    getAccountId: (req: Request) => string;

    /**
     * Data directory path for storing account data and metadata.
     * Defaults to process.env.DATA_DIR || './data'
     */
    dataDir?: string;
}

// Worker configuration options
export interface WorkerConfig {
    /**
     * Data directory path for storing account data and metadata.
     * Defaults to process.env.DATA_DIR || './data'
     */
    dataDir?: string;
}

// Worker control handle
export interface WorkerHandle {
    /** Stop the background sync worker */
    stop(): Promise<void>;
}

function isV2Format(data: any): data is AccountHistoryFile {
    return data.version === 2 && Array.isArray(data.records);
}

/**
 * Create storage access functions for a specific data directory
 */
function createStorage(dataDir: string) {
    const ACCOUNTS_FILE = path.join(dataDir, 'accounts.json');
    const JOBS_FILE = path.join(dataDir, 'jobs.json');

    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    function loadAccounts(): AccountsDb {
        if (!fs.existsSync(ACCOUNTS_FILE)) {
            return { accounts: {} };
        }
        return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }

    function saveAccounts(db: AccountsDb): void {
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(db, null, 2));
    }

    function loadJobs(): JobsDb {
        if (!fs.existsSync(JOBS_FILE)) {
            return { jobs: {} };
        }
        return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
    }

    function saveJobs(db: JobsDb): void {
        fs.writeFileSync(JOBS_FILE, JSON.stringify(db, null, 2));
    }

    function getAccountOutputFile(accountId: string): string {
        return path.join(dataDir, `${accountId}.json`);
    }

    function getAccountCsvFile(accountId: string): string {
        return path.join(dataDir, `${accountId}.csv`);
    }

    return {
        loadAccounts,
        saveAccounts,
        loadJobs,
        saveJobs,
        getAccountOutputFile,
        getAccountCsvFile
    };
}

/**
 * Lazy enrollment: Register an account if not already registered
 */
function ensureAccountRegistered(accountId: string, storage: ReturnType<typeof createStorage>): void {
    const accountsDb = storage.loadAccounts();

    if (!accountsDb.accounts[accountId]) {
        console.log(`[Lazy Enrollment] Registering new account: ${accountId}`);
        accountsDb.accounts[accountId] = {
            accountId,
            registeredAt: new Date().toISOString()
        };
        storage.saveAccounts(accountsDb);
    }
}

/**
 * Validation helpers
 */
function isValidNearAccountId(accountId: string): boolean {
    return /^([a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(accountId);
}

/**
 * Load account history file and check if history is complete
 * V2 format only
 */
function loadAccountHistoryFile(accountId: string, storage: ReturnType<typeof createStorage>): AccountHistoryFile | null {
    const outputFile = storage.getAccountOutputFile(accountId);
    if (!fs.existsSync(outputFile)) {
        return null;
    }
    try {
        const data = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
        if (!isV2Format(data)) {
            console.warn(`Account ${accountId} has legacy V1 format, needs migration`);
            return null;
        }
        return data;
    } catch (error) {
        console.error(`Error loading account history file for ${accountId}:`, error);
        return null;
    }
}

/**
 * Migrate all V1 format files in the data directory to V2 format
 * This runs on startup before the sync loop begins
 */
function migrateAllV1Files(dataDir: string): { migrated: number; skipped: number; errors: string[] } {
    const result = { migrated: 0, skipped: 0, errors: [] as string[] };

    if (!fs.existsSync(dataDir)) {
        return result;
    }

    // Find all .json files that look like account history files (*.near.json)
    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.near.json'));

    if (files.length === 0) {
        return result;
    }

    console.log(`\n=== Checking ${files.length} account file(s) for V1 -> V2 migration ===`);

    for (const filename of files) {
        const filePath = path.join(dataDir, filename);

        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

            // Skip if already V2 format
            if (isV2Format(data)) {
                result.skipped++;
                continue;
            }

            // Check if it's a V1 format file (has transactions array)
            if (!data.accountId || !Array.isArray(data.transactions)) {
                result.skipped++;
                continue;
            }

            console.log(`  Migrating ${filename}...`);

            // Create backup
            const backupPath = filePath.replace('.json', '.v1-backup.json');
            fs.copyFileSync(filePath, backupPath);

            // Migrate to V2
            const v2History = migrateToV2(data);

            // Write migrated file
            fs.writeFileSync(filePath, JSON.stringify(v2History, null, 2));

            console.log(`    ✓ Migrated: ${data.transactions.length} transactions -> ${v2History.records.length} records`);
            result.migrated++;
        } catch (error) {
            const errorMsg = `Failed to migrate ${filename}: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`    ✗ ${errorMsg}`);
            result.errors.push(errorMsg);
        }
    }

    if (result.migrated > 0 || result.errors.length > 0) {
        console.log(`\nMigration complete: ${result.migrated} migrated, ${result.skipped} already V2, ${result.errors.length} errors\n`);
    }

    return result;
}

/**
 * Query staking pool balance at a specific block
 */
async function queryStakingBalanceAtBlock(
    accountId: string,
    poolId: string,
    blockHeight: number
): Promise<string | null> {
    try {
        const result = await callViewFunction(
            poolId,
            'get_account_total_balance',
            { account_id: accountId },
            blockHeight
        );
        // Result is returned as a quoted string like "1000000000000000000000000000"
        return typeof result === 'string' ? result.replace(/"/g, '') : String(result || '0');
    } catch (error) {
        console.warn(`    Could not query ${poolId} at block ${blockHeight}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

/**
 * Iterate all V2 account history files and apply a repair function to each.
 * Returns summary of files processed, total changes, and errors.
 */
async function forEachV2AccountFile(
    dataDir: string,
    description: string,
    repairFn: (accountId: string, data: AccountHistoryFile, filePath: string) => Promise<number> | number
): Promise<{ filesProcessed: number; totalChanges: number; errors: string[] }> {
    const result = { filesProcessed: 0, totalChanges: 0, errors: [] as string[] };

    if (!fs.existsSync(dataDir)) return result;

    const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.near.json'));
    if (files.length === 0) return result;

    console.log(`\n=== ${description}: checking ${files.length} account file(s) ===`);

    for (const filename of files) {
        const filePath = path.join(dataDir, filename);
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!isV2Format(data)) continue;

            const changes = await repairFn(data.accountId, data, filePath);
            if (changes > 0) {
                result.filesProcessed++;
                result.totalChanges += changes;
            }
        } catch (error) {
            const errorMsg = `Failed to process ${filename}: ${error instanceof Error ? error.message : String(error)}`;
            console.error(`    ${errorMsg}`);
            result.errors.push(errorMsg);
        }
    }

    if (result.filesProcessed > 0 || result.errors.length > 0) {
        console.log(`\n${description} complete: ${result.filesProcessed} file(s), ${result.totalChanges} changes, ${result.errors.length} errors\n`);
    }

    return result;
}

/**
 * Repair staking records with incorrect balance_before: "0" values.
 * Queries the actual balance at block_height - 1 and recalculates the amount.
 */
async function repairStakingBalanceBefore(
    accountId: string,
    data: AccountHistoryFile,
    _filePath: string
): Promise<number> {
    const buggyRecords = data.records.filter((r: BalanceChangeRecord) =>
        isStakingPool(r.token_id) &&
        r.balance_before === '0' &&
        r.balance_after !== '0'
    );

    if (buggyRecords.length === 0) return 0;

    console.log(`  ${accountId}: ${buggyRecords.length} staking records with balance_before=0 to fix`);
    let fixedCount = 0;

    for (const record of buggyRecords) {
        const actualBalanceBefore = await queryStakingBalanceAtBlock(
            accountId, record.token_id, record.block_height - 1
        );
        if (actualBalanceBefore === null) continue;

        const oldBalanceBefore = record.balance_before;
        record.balance_before = actualBalanceBefore;
        record.amount = (BigInt(record.balance_after) - BigInt(actualBalanceBefore)).toString();

        console.log(`    Fixed ${record.token_id} at block ${record.block_height}: balance_before ${oldBalanceBefore} -> ${actualBalanceBefore}`);
        fixedCount++;
    }

    if (fixedCount > 0) {
        (data as any).updatedAt = new Date().toISOString();
        fs.writeFileSync(_filePath, JSON.stringify(data, null, 2));
    }

    return fixedCount;
}

/**
 * Create Express router with account data endpoints
 *
 * @param config - Configuration including getAccountId hook and optional dataDir
 * @returns Express Router instance with all /api/accounting/* endpoints
 *
 * @example
 * // In ariz-gateway:
 * const router = createRouter({
 *   getAccountId: (req) => req.accountId, // Set by gateway's auth middleware
 *   dataDir: '/data/accounting'
 * });
 * app.use('/api/accounting', router);
 *
 * @example
 * // Standalone server with fixed account (local dev):
 * const router = createRouter({
 *   getAccountId: () => 'testaccount.near',
 *   dataDir: './data'
 * });
 */
export function createRouter(config: RouterConfig): Router {
    const router = express.Router();
    const dataDir = config.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    const storage = createStorage(dataDir);

    // Middleware to parse JSON bodies (router-level)
    router.use(express.json());

    // Middleware to log requests
    router.use((req: Request, res: Response, next: NextFunction) => {
        console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
        next();
    });

    // Middleware to extract and validate accountId, plus lazy enrollment
    router.use((req: Request, res: Response, next: NextFunction) => {
        try {
            const accountId = config.getAccountId(req);

            if (!accountId || typeof accountId !== 'string') {
                return res.status(401).json({ error: 'Unauthorized: account ID not found' });
            }

            if (!isValidNearAccountId(accountId)) {
                return res.status(400).json({ error: 'Invalid NEAR account ID format' });
            }

            // Lazy enrollment: register account on first sight
            ensureAccountRegistered(accountId, storage);

            // Attach accountId to request for downstream handlers
            (req as any).accountId = accountId;
            next();
        } catch (error) {
            console.error('Authentication error:', error);
            return res.status(401).json({
                error: 'Unauthorized',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // GET /status - Get account data collection status
    router.get('/status', (req: Request, res: Response) => {
        const accountId = (req as any).accountId;

        // Check for running job (use in-memory Map from worker)
        const isRunning = false; // Worker manages this separately

        // Check if data file exists and get metadata
        const outputFile = storage.getAccountOutputFile(accountId);
        let dataRange = null;
        let hasData = false;
        let format: 'v1' | 'v2' | null = null;

        if (fs.existsSync(outputFile)) {
            try {
                const fileContent = fs.readFileSync(outputFile, 'utf8');
                const accountHistory = JSON.parse(fileContent);
                hasData = true;
                format = isV2Format(accountHistory) ? 'v2' : 'v1';
                dataRange = {
                    firstBlock: accountHistory.metadata?.firstBlock || null,
                    lastBlock: accountHistory.metadata?.lastBlock || null,
                    totalTransactions: accountHistory.metadata?.totalTransactions || accountHistory.metadata?.totalRecords || 0,
                    updatedAt: accountHistory.updatedAt || null
                };
            } catch (error) {
                console.error('Error reading account data file:', error);
            }
        }

        res.json({
            accountId,
            hasData,
            format,
            dataRange,
            isRunning
        });
    });

    // GET /download/json - Download account data as JSON
    router.get('/download/json', (req: Request, res: Response) => {
        const accountId = (req as any).accountId;
        const outputFile = storage.getAccountOutputFile(accountId);

        if (!fs.existsSync(outputFile)) {
            return res.status(404).json({ error: 'No data file found for this account yet' });
        }

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${accountId}.json"`);

        const fileStream = fs.createReadStream(outputFile);
        fileStream.pipe(res);
    });

    // GET /download/csv - Download account data as CSV
    router.get('/download/csv', async (req: Request, res: Response) => {
        try {
            const accountId = (req as any).accountId;
            const outputFile = storage.getAccountOutputFile(accountId);

            if (!fs.existsSync(outputFile)) {
                return res.status(404).json({ error: 'No data file found for this account yet' });
            }

            const csvFile = storage.getAccountCsvFile(accountId);

            // Generate CSV if it doesn't exist or if JSON is newer
            const jsonStat = fs.statSync(outputFile);
            const csvExists = fs.existsSync(csvFile);
            const csvNeedsUpdate = !csvExists || (csvExists && fs.statSync(csvFile).mtime < jsonStat.mtime);

            if (csvNeedsUpdate) {
                try {
                    await convertJsonToCsv(outputFile, csvFile);
                } catch (error) {
                    console.error('Error converting to CSV:', error);
                    return res.status(500).json({
                        error: 'Failed to convert data to CSV',
                        details: error instanceof Error ? error.message : String(error)
                    });
                }
            }

            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename="${accountId}.csv"`);

            const fileStream = fs.createReadStream(csvFile);
            fileStream.pipe(res);
        } catch (error) {
            console.error('Unexpected error in CSV download:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // GET /gap-analysis - Get gap analysis report
    router.get('/gap-analysis', (req: Request, res: Response) => {
        try {
            const accountId = (req as any).accountId;
            const outputFile = storage.getAccountOutputFile(accountId);

            if (!fs.existsSync(outputFile)) {
                return res.status(404).json({ error: 'No data file found for this account yet' });
            }

            // Read and parse the account history file
            const fileContent = fs.readFileSync(outputFile, 'utf-8');
            const history = JSON.parse(fileContent);

            if (!history.accountId) {
                return res.status(500).json({ error: 'Invalid account history file format - missing accountId' });
            }

            // V2 format only
            if (!isV2Format(history)) {
                return res.status(400).json({
                    error: 'Only V2 format is supported. Run migration script to convert.',
                    hint: 'npx tsx scripts/migrate-to-flat-format.ts ' + outputFile
                });
            }

            // Run per-token gap detection
            const gapAnalysis: GapAnalysisV2 = detectGapsV2(history.records);

            const response = {
                accountId: history.accountId,
                analyzedAt: new Date().toISOString(),
                summary: {
                    totalGaps: gapAnalysis.totalGaps,
                    tokensWithGaps: gapAnalysis.tokensWithGaps,
                    isComplete: gapAnalysis.isComplete
                },
                metadata: {
                    totalRecords: history.records.length,
                    firstBlock: history.metadata?.firstBlock || null,
                    lastBlock: history.metadata?.lastBlock || null
                },
                gaps: gapAnalysis.tokenGaps.map(gap => ({
                    type: 'token_gap',
                    tokenId: gap.token_id,
                    fromBlock: gap.from_block,
                    toBlock: gap.to_block,
                    expectedBalance: gap.expected_balance,
                    actualBalance: gap.actual_balance,
                    diff: gap.diff
                }))
            };

            res.json(response);
        } catch (error) {
            console.error('Unexpected error in gap analysis:', error);
            res.status(500).json({
                error: 'Internal server error',
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    // Error handler
    router.use((err: Error, req: Request, res: Response, next: NextFunction) => {
        console.error('Unhandled error:', err);
        res.status(500).json({ error: 'Internal server error', message: err.message });
    });

    return router;
}

/**
 * Start the background sync worker
 *
 * @param config - Configuration including optional dataDir
 * @returns WorkerHandle with stop() method for graceful shutdown
 *
 * @example
 * const worker = await startWorker({ dataDir: '/data/accounting' });
 * // Later, for graceful shutdown:
 * await worker.stop();
 */
export async function startWorker(config: WorkerConfig = {}): Promise<WorkerHandle> {
    const dataDir = config.dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');
    const storage = createStorage(dataDir);

    // Background job processor - tracks running jobs per account
    const runningJobs = new Map<string, Promise<void>>();

    // Continuous sync state
    let continuousSyncRunning = false;
    let continuousSyncShuttingDown = false;

    // Track last sync time per account to implement different polling intervals
    const lastSyncTime = new Map<string, number>();

    /**
     * Process a single account in the continuous sync loop
     */
    async function processAccountCycle(accountId: string): Promise<{ backward: boolean; forward: boolean }> {
        const result = { backward: false, forward: false };

        // Skip if shutting down
        if (continuousSyncShuttingDown) {
            return result;
        }

        // Skip if there's already a running job for this account
        if (runningJobs.has(accountId)) {
            console.log(`Skipping ${accountId} - job already running`);
            return result;
        }

        const outputFile = storage.getAccountOutputFile(accountId);
        const historyFile = loadAccountHistoryFile(accountId, storage);

        // Check if history is complete (backward search done)
        const historyComplete = historyFile?.metadata?.historyComplete === true;

        // Wrap entire sync operation in a single promise that stays in runningJobs
        const syncPromise = (async () => {
            try {
                // ALWAYS search forward FIRST to get latest data (priority: freshness over completeness)
                console.log(`[${accountId}] Searching forward (checking for new transactions)`);
                result.forward = true;

                try {
                    await getAccountHistory({
                        accountId,
                        outputFile,
                        direction: 'forward',
                        maxTransactions: SYNC_CONFIG.batchSize,
                        maxEpochsToCheck: SYNC_CONFIG.maxEpochsPerCycle
                    });
                } catch (error) {
                    console.error(`[${accountId}] Forward search failed:`, error);
                }

                // Authoritative FT records from the FastNear Transfers API.
                // Runs every cycle: it reports each FT transfer at its real
                // settlement block with start/end-of-block balances, capturing
                // multi-hop claims the block-sampling path misses (see
                // transfers-sync.ts). Incremental after the latest stored FT block.
                try {
                    const ftSync = await syncFtTransfersForAccount(accountId, outputFile);
                    if (ftSync.changed) {
                        console.log(`[${accountId}] FT transfers sync: +${ftSync.fetched} fetched, ${ftSync.gaps.length} gap(s), ${ftSync.filled} reconciled`);
                    }
                } catch (error) {
                    console.error(`[${accountId}] FT transfers sync failed:`, error);
                }

                // Skip backward search if shutting down
                if (continuousSyncShuttingDown) {
                    return;
                }

                // Then do incremental backward search if history is not complete
                if (!historyComplete) {
                    console.log(`[${accountId}] Searching backward (incremental - history incomplete)`);
                    result.backward = true;

                    try {
                        await getAccountHistory({
                            accountId,
                            outputFile,
                            direction: 'backward',
                            maxTransactions: SYNC_CONFIG.batchSize,
                            maxEpochsToCheck: SYNC_CONFIG.maxEpochsPerCycle
                        });
                    } catch (error) {
                        console.error(`[${accountId}] Backward search failed:`, error);
                    }
                }

                // Skip FT re-enrichment if shutting down
                if (continuousSyncShuttingDown) {
                    return;
                }

                // Re-enrich FT balances for entries that have FT transfers but missing FT balance snapshots
                // This fixes entries created before FT balance enrichment was implemented
                try {
                    await reEnrichFTBalances(accountId, outputFile, SYNC_CONFIG.batchSize);
                } catch (error) {
                    console.error(`[${accountId}] FT re-enrichment failed:`, error);
                }

            } catch (error) {
                console.error(`[${accountId}] Error processing account cycle:`, error);
            } finally {
                // Only remove from runningJobs after ALL phases complete (including staking sync)
                runningJobs.delete(accountId);
            }
        })();

        runningJobs.set(accountId, syncPromise);
        await syncPromise;

        return result;
    }

    /**
     * Start the continuous sync loop
     */
    async function startContinuousLoop(): Promise<void> {
        if (continuousSyncRunning) {
            console.log('Continuous sync loop is already running');
            return;
        }

        continuousSyncRunning = true;
        continuousSyncShuttingDown = false;
        console.log(`Starting continuous sync loop`);
        console.log(`  Priority: Forward sync first (latest data), then backward sync (historical data)`);
        console.log(`  Batch size: ${SYNC_CONFIG.batchSize} transactions`);
        console.log(`  Cycle delay: ${SYNC_CONFIG.cycleDelayMs}ms`);
        console.log(`  Complete account interval: ${SYNC_CONFIG.completeAccountIntervalMs}ms (${(SYNC_CONFIG.completeAccountIntervalMs / 3600000).toFixed(1)}h)`);
        console.log(`  Incomplete account interval: ${SYNC_CONFIG.incompleteAccountIntervalMs}ms (${(SYNC_CONFIG.incompleteAccountIntervalMs / 60000).toFixed(1)}min)`);
        console.log(`  Max epochs/cycle: ${SYNC_CONFIG.maxEpochsPerCycle}`);
        console.log(`  Account timeout: ${SYNC_CONFIG.accountTimeoutMs}ms`);

        while (!continuousSyncShuttingDown) {
            try {
                const accountsDb = storage.loadAccounts();
                const accounts = Object.values(accountsDb.accounts);
                const now = Date.now();

                let processedCount = 0;
                let skippedCount = 0;
                let deferredCount = 0;

                for (const account of accounts) {
                    if (continuousSyncShuttingDown) {
                        console.log('Shutdown signal received, stopping sync loop');
                        break;
                    }

                    // Determine sync interval based on history completeness
                    const historyFile = loadAccountHistoryFile(account.accountId, storage);
                    const historyComplete = historyFile?.metadata?.historyComplete === true;
                    const interval = historyComplete
                        ? SYNC_CONFIG.completeAccountIntervalMs
                        : SYNC_CONFIG.incompleteAccountIntervalMs;

                    const lastSync = lastSyncTime.get(account.accountId) || 0;
                    if (now - lastSync < interval) {
                        deferredCount++;
                        continue;
                    }

                    console.log(`[${account.accountId}] Syncing (${historyComplete ? 'complete, checking for new' : 'incomplete, filling gaps'})`);

                    // Process account with timeout to prevent one account from blocking others
                    try {
                        const timeoutPromise = new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('Account timeout')), SYNC_CONFIG.accountTimeoutMs)
                        );

                        await Promise.race([
                            processAccountCycle(account.accountId),
                            timeoutPromise
                        ]);
                        processedCount++;
                    } catch (error) {
                        if (error instanceof Error && error.message === 'Account timeout') {
                            console.log(`[${account.accountId}] Timeout reached (${SYNC_CONFIG.accountTimeoutMs}ms), moving to next account`);
                            processedCount++;
                        } else {
                            console.error(`[${account.accountId}] Error in sync cycle:`, error);
                            skippedCount++;
                        }
                    }

                    lastSyncTime.set(account.accountId, Date.now());
                }

                if (processedCount > 0 || skippedCount > 0) {
                    console.log(`=== Sync cycle: ${processedCount} processed, ${skippedCount} skipped, ${deferredCount} deferred (not due yet) ===\n`);
                }

                // Wait before next cycle (unless shutting down)
                if (!continuousSyncShuttingDown) {
                    await new Promise(resolve => setTimeout(resolve, SYNC_CONFIG.cycleDelayMs));
                }
            } catch (error) {
                console.error('Error in continuous sync loop:', error);
                // Wait a bit before retrying
                if (!continuousSyncShuttingDown) {
                    await new Promise(resolve => setTimeout(resolve, SYNC_CONFIG.cycleDelayMs));
                }
            }
        }

        continuousSyncRunning = false;
        console.log('Continuous sync loop stopped');
    }

    /**
     * Stop the continuous sync loop
     */
    function stopContinuousLoop(): void {
        console.log('Stopping continuous sync loop...');
        continuousSyncShuttingDown = true;
    }

    // Migrate any V1 format files before starting sync
    migrateAllV1Files(dataDir);

    // Run startup repairs
    (async () => {
        await forEachV2AccountFile(dataDir, 'Staking balance_before repair', repairStakingBalanceBefore);
        await forEachV2AccountFile(dataDir, 'Missing staking transfer repair',
            (accountId, data, filePath) => repairMissingStakingRecordsV2(accountId, data as any, filePath));
        await forEachV2AccountFile(dataDir, 'Invalid staking rewards repair',
            (_accountId, data, filePath) => repairInvalidStakingRewards(data as any, filePath));
        await forEachV2AccountFile(dataDir, 'Staking deposits without tx_hash repair',
            (accountId, data, filePath) => repairStakingDepositsWithoutTxHash(accountId, data as any, filePath));
        await forEachV2AccountFile(dataDir, 'Null timestamp repair',
            (_accountId, data, filePath) => repairNullTimestamps(data as any, filePath));
    })().catch(err => {
        console.error('Error during startup repairs:', err);
    });

    // Start continuous sync loop
    const loopPromise = startContinuousLoop();

    return {
        async stop() {
            stopContinuousLoop();
            await loopPromise;
        }
    };
}

// Only start standalone server when run directly (not when imported for testing or by gateway)
if (import.meta.url === `file://${process.argv[1]}`) {
    const PORT = process.env.PORT || 3000;
    const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');

    // Create standalone app with CORS for backward compatibility
    const app = express();

    // CORS configuration for standalone mode
    const CORS_CONFIG = {
        allowedOrigins: process.env.CORS_ALLOWED_ORIGINS
            ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
            : ['*'] // Default to allow all origins if not configured
    };

    // Apply CORS middleware
    const cors = await import('cors').then(m => m.default);
    const corsOptions = {
        origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
            // Allow requests with no origin (like mobile apps or curl requests)
            if (!origin) {
                return callback(null, true);
            }

            // Check if origin is allowed
            if (CORS_CONFIG.allowedOrigins.includes('*') || CORS_CONFIG.allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
            }
        },
        credentials: true, // Allow cookies and authorization headers
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    };

    app.use(cors(corsOptions));

    // For standalone mode, use a simple getAccountId hook that reads from header or URL
    // This is for backward compatibility with existing clients
    const router = createRouter({
        getAccountId: (req: Request): string => {
            // Try to get account from X-Account-Id header first (for testing)
            const headerAccountId = req.headers['x-account-id'];
            if (headerAccountId && typeof headerAccountId === 'string') {
                return headerAccountId;
            }

            // Extract from URL path
            // req.path is relative to router mount point (e.g., /testaccount.near/status or /testaccount/status)
            // Match NEAR account ID at start of path: /accountId/...
            const pathMatch = req.path.match(/^\/([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)/);
            if (pathMatch && pathMatch[1]) {
                return pathMatch[1];
            }

            throw new Error('Account ID not provided. Use X-Account-Id header or include accountId in URL path (e.g., /api/accounting/account.near/status)');
        },
        dataDir: DATA_DIR
    });

    // Mount router at /api/accounting
    app.use('/api/accounting', router);

    // Legacy endpoints for backward compatibility
    // GET /api/accounts - List registered accounts
    app.get('/api/accounts', (req: Request, res: Response) => {
        const storage = createStorage(DATA_DIR);
        const accountsDb = storage.loadAccounts();
        res.json({
            accounts: Object.values(accountsDb.accounts)
        });
    });

    // Health check endpoint
    app.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    const server = app.listen(PORT, () => {
        console.log(`API Server running on port ${PORT}`);
        console.log(`Data directory: ${DATA_DIR}`);
        console.log(`Batch size: ${SYNC_CONFIG.batchSize}`);
        console.log(`Cycle delay: ${SYNC_CONFIG.cycleDelayMs}ms`);
        console.log(`Max epochs per cycle: ${SYNC_CONFIG.maxEpochsPerCycle}`);
        console.log(`Account timeout: ${SYNC_CONFIG.accountTimeoutMs}ms`);
        console.log(`CORS allowed origins: ${CORS_CONFIG.allowedOrigins.join(', ')}`);
        console.log('');
        console.log('Available endpoints:');
        console.log('  GET    /api/accounts - List registered accounts');
        console.log('  GET    /api/accounting/:accountId/status - Get account status and data range');
        console.log('  GET    /api/accounting/:accountId/download/json - Download account data as JSON');
        console.log('  GET    /api/accounting/:accountId/download/csv - Download account data as CSV');
        console.log('  GET    /api/accounting/:accountId/gap-analysis - Get gap analysis report');
        console.log('  GET    /health - Health check');
        console.log('');
        console.log('Note: Accounts are auto-registered on first request (lazy enrollment)');
    });

    // Start worker
    const worker = await startWorker({ dataDir: DATA_DIR });

    // Graceful shutdown
    const shutdown = () => {
        console.log('Shutdown signal received, shutting down gracefully...');
        server.close(async () => {
            await worker.stop();
            console.log('Server closed');
            process.exit(0);
        });
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
