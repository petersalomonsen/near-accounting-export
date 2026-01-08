#!/usr/bin/env node
// API Server for NEAR Accounting Export
// Provides REST endpoints for account registration, data collection jobs, and downloads

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import type { CorsOptions } from 'cors';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

import { getAccountHistory, verifyHistoryFile, reEnrichFTBalances } from './get-account-history.js';
import type { TransactionEntry } from './get-account-history.js';
import { convertJsonToCsv } from './json-to-csv.js';
import { getClient } from './rpc.js';
import { detectGaps } from './gap-detection.js';
import type { GapAnalysis, Gap } from './gap-detection.js';

// Payment verification configuration
const PAYMENT_CONFIG = {
    requiredAmount: process.env.REGISTRATION_FEE_AMOUNT || '100000', // 0.1 ARIZ (6 decimals = 100000)
    recipientAccount: process.env.REGISTRATION_FEE_RECIPIENT || 'arizcredits.near',
    ftContractId: process.env.REGISTRATION_FEE_TOKEN || 'arizcredits.near', // Default to ARIZ
    maxAge: parseInt(process.env.REGISTRATION_TX_MAX_AGE_MS || String(30 * 24 * 60 * 60 * 1000), 10), // Default 30 days
    exemptAccounts: process.env.REGISTRATION_FEE_EXEMPT_ACCOUNTS
        ? process.env.REGISTRATION_FEE_EXEMPT_ACCOUNTS.split(',').map(acc => acc.trim().toLowerCase())
        : [] // Accounts that don't need to pay (e.g., for testing or special partnerships)
};

// Continuous sync configuration
const SYNC_CONFIG = {
    batchSize: parseInt(process.env.BATCH_SIZE || '10', 10),
    cycleDelayMs: parseInt(process.env.CYCLE_DELAY_MS || '30000', 10),
    maxEpochsPerCycle: parseInt(process.env.MAX_EPOCHS_PER_CYCLE || '50', 10),
    accountTimeoutMs: parseInt(process.env.ACCOUNT_TIMEOUT_MS || '300000', 10) // 5 minutes default
};

// CORS configuration
const CORS_CONFIG = {
    allowedOrigins: process.env.CORS_ALLOWED_ORIGINS
        ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(origin => origin.trim())
        : ['*'] // Default to allow all origins if not configured
};

// Types
interface RegisteredAccount {
    accountId: string;
    registeredAt: string;
    paymentTransactionHash?: string;
    paymentTransactionDate?: string;
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

// Storage paths
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize storage
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
    return path.join(DATA_DIR, `${accountId}.json`);
}

function getAccountCsvFile(accountId: string): string {
    return path.join(DATA_DIR, `${accountId}.csv`);
}

// Background job processor - tracks running jobs per account
const runningJobs = new Map<string, Promise<void>>();

async function processJob(jobId: string): Promise<void> {
    const jobsDb = loadJobs();
    const job = jobsDb.jobs[jobId];
    
    if (!job) {
        console.error(`Job ${jobId} not found`);
        return;
    }
    
    try {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        saveJobs(jobsDb);
        
        const outputFile = getAccountOutputFile(job.accountId);
        
        // Run the data collection - this will append/continue from existing file
        await getAccountHistory({
            accountId: job.accountId,
            outputFile,
            direction: job.options.direction || 'backward',
            maxTransactions: job.options.maxTransactions || 100,
            startBlock: job.options.startBlock,
            endBlock: job.options.endBlock
        });
        
        // Mark as completed
        const updatedJobsDb = loadJobs();
        const completedJob = updatedJobsDb.jobs[jobId];
        if (completedJob) {
            completedJob.status = 'completed';
            completedJob.completedAt = new Date().toISOString();
            saveJobs(updatedJobsDb);
        }
        
        console.log(`Job ${jobId} completed successfully`);
    } catch (error) {
        // Mark as failed
        const updatedJobsDb = loadJobs();
        const failedJob = updatedJobsDb.jobs[jobId];
        if (failedJob) {
            failedJob.status = 'failed';
            failedJob.error = error instanceof Error ? error.message : String(error);
            failedJob.completedAt = new Date().toISOString();
            saveJobs(updatedJobsDb);
        }
        
        console.error(`Job ${jobId} failed:`, error);
    } finally {
        runningJobs.delete(job.accountId);
    }
}

// Continuous sync state
// Note: These module-level variables are intentional for a single-instance server.
// The fly.toml configuration limits the server to a single instance (scale count 1)
// to prevent data conflicts and ensure job tracking consistency.
let continuousSyncRunning = false;
let continuousSyncShuttingDown = false;

/**
 * Check if an account is exempt from payment
 */
function isAccountExempt(accountId: string): boolean {
    return PAYMENT_CONFIG.exemptAccounts.includes(accountId.toLowerCase());
}

/**
 * Check if an account has a valid (non-expired) payment
 */
function isPaymentValid(account: RegisteredAccount): boolean {
    // If payment verification is disabled, all accounts are valid
    if (PAYMENT_CONFIG.requiredAmount === '0') {
        return true;
    }
    
    // If account is exempt from payment, it's always valid
    if (isAccountExempt(account.accountId)) {
        return true;
    }
    
    // If no payment date, account is invalid (for payment-required mode)
    if (!account.paymentTransactionDate) {
        return false;
    }
    
    const paymentDate = new Date(account.paymentTransactionDate).getTime();
    const now = Date.now();
    const age = now - paymentDate;
    
    return age <= PAYMENT_CONFIG.maxAge;
}

/**
 * Load account history file and check if history is complete
 */
interface AccountHistoryMetadata {
    historyComplete?: boolean;
    firstBlock: number | null;
    lastBlock: number | null;
    totalTransactions: number;
}

interface AccountHistoryFile {
    accountId: string;
    metadata: AccountHistoryMetadata;
    transactions: any[];
}

function loadAccountHistoryFile(accountId: string): AccountHistoryFile | null {
    const outputFile = getAccountOutputFile(accountId);
    if (!fs.existsSync(outputFile)) {
        return null;
    }
    try {
        return JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    } catch (error) {
        console.error(`Error loading account history file for ${accountId}:`, error);
        return null;
    }
}

/**
 * Process a single account in the continuous sync loop
 */
export async function processAccountCycle(accountId: string): Promise<{ backward: boolean; forward: boolean }> {
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
    
    const outputFile = getAccountOutputFile(accountId);
    const historyFile = loadAccountHistoryFile(accountId);
    
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
export async function startContinuousLoop(): Promise<void> {
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
    console.log(`  Max epochs/cycle: ${SYNC_CONFIG.maxEpochsPerCycle}`);
    console.log(`  Account timeout: ${SYNC_CONFIG.accountTimeoutMs}ms`);
    
    while (!continuousSyncShuttingDown) {
        try {
            const accountsDb = loadAccounts();
            const accounts = Object.values(accountsDb.accounts);
            
            console.log(`\n=== Starting sync cycle for ${accounts.length} registered account(s) ===`);
            
            let processedCount = 0;
            let skippedCount = 0;
            
            for (const account of accounts) {
                if (continuousSyncShuttingDown) {
                    console.log('Shutdown signal received, stopping sync loop');
                    break;
                }
                
                // Check payment validity
                if (!isPaymentValid(account)) {
                    console.log(`Skipping ${account.accountId} - payment expired or missing`);
                    skippedCount++;
                    continue;
                }

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
                        console.log(`[${account.accountId}] ⏱️  Timeout reached (${SYNC_CONFIG.accountTimeoutMs}ms), moving to next account`);
                        processedCount++;
                    } else {
                        console.error(`[${account.accountId}] Error in sync cycle:`, error);
                        skippedCount++;
                    }
                }
            }
            
            console.log(`=== Sync cycle complete: ${processedCount} processed, ${skippedCount} skipped ===\n`);
            
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
export function stopContinuousLoop(): void {
    console.log('Stopping continuous sync loop...');
    continuousSyncShuttingDown = true;
}

/**
 * Check if continuous sync is running
 */
export function isContinuousSyncRunning(): boolean {
    return continuousSyncRunning;
}

// Validation helpers
function isValidNearAccountId(accountId: string): boolean {
    return /^([a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(accountId);
}

// Payment verification
interface PaymentVerificationResult {
    valid: boolean;
    senderAccountId?: string;
    transactionTimestamp?: string;
    error?: string;
}

async function verifyPaymentTransaction(txHash: string): Promise<PaymentVerificationResult> {
    try {
        const endpoint = process.env.NEAR_RPC_ENDPOINT || 'https://archival-rpc.mainnet.fastnear.com';
        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        const apiKey = process.env.FASTNEAR_API_KEY;
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        
        // Fetch transaction details using EXPERIMENTAL_tx_status
        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'dontcare',
                method: 'EXPERIMENTAL_tx_status',
                params: {
                    tx_hash: txHash,
                    sender_account_id: 'dontcare'
                }
            })
        });
        
        if (!response.ok) {
            return { valid: false, error: `RPC request failed: ${response.statusText}` };
        }
        
        const data: any = await response.json();
        
        if (data.error) {
            return { valid: false, error: `RPC error: ${data.error.message || JSON.stringify(data.error)}` };
        }
        
        const txResult = data.result;
        
        if (!txResult || !txResult.transaction) {
            return { valid: false, error: 'Transaction not found' };
        }
        
        const transaction = txResult.transaction;
        const senderAccountId = transaction.signer_id;
        
        // Get block hash from transaction outcome
        const blockHash = txResult.transaction_outcome?.block_hash;
        if (!blockHash) {
            return { valid: false, error: 'Block hash not found in transaction outcome' };
        }
        
        // Fetch block to get timestamp
        const blockResponse = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'dontcare',
                method: 'block',
                params: {
                    block_id: blockHash
                }
            })
        });
        
        if (!blockResponse.ok) {
            return { valid: false, error: `Failed to fetch block: ${blockResponse.statusText}` };
        }
        
        const blockData: any = await blockResponse.json();
        
        if (blockData.error) {
            return { valid: false, error: `Block fetch error: ${blockData.error.message || JSON.stringify(blockData.error)}` };
        }
        
        const txTimestamp = blockData.result?.header?.timestamp || 0;
        if (txTimestamp === 0) {
            return { valid: false, error: 'Block timestamp not found' };
        }
        
        // Check transaction age
        const txAge = Date.now() * 1_000_000 - txTimestamp; // Convert to nanoseconds
        if (txAge > PAYMENT_CONFIG.maxAge * 1_000_000) {
            return { 
                valid: false, 
                error: `Transaction is too old (age: ${Math.floor(txAge / (1_000_000 * 1000))}ms, max: ${PAYMENT_CONFIG.maxAge}ms)` 
            };
        }
        
        // Check if transaction has FT transfer action (direct transfer)
        const actions = transaction.actions || [];
        let ftTransferFound = false;
        let transferAmount = '0';
        let actualSenderAccountId = senderAccountId; // May be updated if transfer is in receipts
        let receiverId = transaction.receiver_id;
        
        for (const action of actions) {
            if (action.FunctionCall) {
                const methodName = action.FunctionCall.method_name;
                
                // Check if it's an FT transfer
                if (methodName === 'ft_transfer' || methodName === 'ft_transfer_call') {
                    // Check if receiver_id is the FT contract
                    if (receiverId !== PAYMENT_CONFIG.ftContractId) {
                        continue;
                    }
                    
                    ftTransferFound = true;
                    
                    // Parse args to get receiver_id and amount
                    const argsBase64 = action.FunctionCall.args;
                    const argsStr = Buffer.from(argsBase64, 'base64').toString('utf8');
                    const args = JSON.parse(argsStr);
                    
                    // Verify recipient
                    if (args.receiver_id !== PAYMENT_CONFIG.recipientAccount) {
                        return { 
                            valid: false, 
                            error: `Incorrect recipient. Expected: ${PAYMENT_CONFIG.recipientAccount}, Got: ${args.receiver_id}` 
                        };
                    }
                    
                    transferAmount = args.amount || '0';
                    break;
                }
            }
        }
        
        // If not found in transaction actions, check receipts (e.g., DAO proposals, other cross-contract calls)
        if (!ftTransferFound && txResult.receipts) {
            for (const receipt of txResult.receipts) {
                // Skip receipts not directed to the FT contract
                if (receipt.receiver_id !== PAYMENT_CONFIG.ftContractId) {
                    continue;
                }
                
                const receiptActions = receipt.receipt?.Action?.actions || [];
                for (const action of receiptActions) {
                    if (action.FunctionCall) {
                        const methodName = action.FunctionCall.method_name;
                        
                        if (methodName === 'ft_transfer' || methodName === 'ft_transfer_call') {
                            try {
                                // Parse args to get receiver_id and amount
                                const argsBase64 = action.FunctionCall.args;
                                const argsStr = Buffer.from(argsBase64, 'base64').toString('utf8');
                                const args = JSON.parse(argsStr);
                                
                                // Verify recipient
                                if (args.receiver_id !== PAYMENT_CONFIG.recipientAccount) {
                                    continue;
                                }
                                
                                ftTransferFound = true;
                                transferAmount = args.amount || '0';
                                // The actual sender is the predecessor_id (the account that initiated the receipt)
                                // This could be a DAO, multisig, or other contract acting on behalf of the user
                                actualSenderAccountId = receipt.predecessor_id;
                                break;
                            } catch (e) {
                                // Skip receipts with invalid args
                                continue;
                            }
                        }
                    }
                }
                
                if (ftTransferFound) break;
            }
        }
        
        if (!ftTransferFound) {
            return { valid: false, error: 'No FT transfer found in transaction' };
        }
        
        // Verify amount
        if (BigInt(transferAmount) < BigInt(PAYMENT_CONFIG.requiredAmount)) {
            return { 
                valid: false, 
                error: `Insufficient amount. Required: ${PAYMENT_CONFIG.requiredAmount}, Got: ${transferAmount}` 
            };
        }
        
        // Check transaction status - SuccessValue can be empty string "", which is valid
        const status = txResult.status;
        if (!status || (status.SuccessValue === undefined && !status.SuccessReceiptId)) {
            return { valid: false, error: 'Transaction failed' };
        }
        
        // Convert nanoseconds to ISO string
        const txDate = new Date(txTimestamp / 1_000_000).toISOString();
        
        return { 
            valid: true, 
            senderAccountId: actualSenderAccountId,
            transactionTimestamp: txDate
        };
        
    } catch (error) {
        console.error('Error verifying transaction:', error);
        return { 
            valid: false, 
            error: `Failed to fetch transaction: ${error instanceof Error ? error.message : String(error)}` 
        };
    }
}

// Express app
const app = express();
app.use(express.json());

// Configure CORS
const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
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

// Middleware to log requests
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// NOTE: For production use, consider adding:
// - Rate limiting middleware (e.g., express-rate-limit) to prevent abuse
// - Authentication middleware to protect endpoints
// - Configure CORS_ALLOWED_ORIGINS environment variable to restrict origins
// - Input sanitization and validation middleware

// POST /api/accounts - Register an account
app.post('/api/accounts', async (req: Request, res: Response) => {
    const { transactionHash, accountId: providedAccountId } = req.body;
    
    // Check if payment verification is disabled (for testing)
    const paymentRequired = PAYMENT_CONFIG.requiredAmount !== '0';
    
    let accountId: string;
    let verificationResult: PaymentVerificationResult | undefined;
    
    // Check if this is an exempt account (can register without payment)
    const isExemptAccount = providedAccountId && isAccountExempt(providedAccountId);
    
    if (paymentRequired && !isExemptAccount) {
        // Payment verification mode
        if (!transactionHash || typeof transactionHash !== 'string') {
            return res.status(400).json({ error: 'transactionHash is required and must be a string' });
        }
        
        try {
            // Verify the payment transaction
            verificationResult = await verifyPaymentTransaction(transactionHash);
            
            if (!verificationResult.valid) {
                return res.status(400).json({ 
                    error: 'Payment verification failed', 
                    details: verificationResult.error 
                });
            }
            
            accountId = verificationResult.senderAccountId!;
        } catch (error) {
            console.error('Error verifying payment transaction:', error);
            return res.status(500).json({ 
                error: 'Failed to verify payment transaction',
                details: error instanceof Error ? error.message : String(error)
            });
        }
    } else {
        // No payment required (testing mode) or exempt account - accept accountId directly
        if (!providedAccountId || typeof providedAccountId !== 'string') {
            return res.status(400).json({ error: 'accountId is required and must be a string' });
        }
        
        // Validate NEAR account ID format
        const accountIdRegex = /^[a-z0-9][a-z0-9_-]*[a-z0-9](\.[a-z0-9][a-z0-9_-]*[a-z0-9])*\.near$/;
        const implicitAccountRegex = /^[a-f0-9]{64}$/;
        if (!accountIdRegex.test(providedAccountId) && !implicitAccountRegex.test(providedAccountId)) {
            return res.status(400).json({ error: 'Invalid NEAR account ID format' });
        }
        
        accountId = providedAccountId;
    }
    
    const accountsDb = loadAccounts();
    
    // Check if account already exists
    const existingAccount = accountsDb.accounts[accountId];
    if (existingAccount) {
        // If payment verification is required and transaction hash is provided,
        // allow subscription renewal
        if (paymentRequired && transactionHash && verificationResult) {
            // Update payment info for subscription renewal
            existingAccount.paymentTransactionHash = transactionHash;
            existingAccount.paymentTransactionDate = verificationResult.transactionTimestamp!;
            saveAccounts(accountsDb);
            
            return res.status(200).json({
                message: 'Subscription renewed successfully',
                account: existingAccount
            });
        }
        
        return res.status(200).json({
            message: 'Account already registered',
            account: existingAccount
        });
    }
    
    // Create new account with payment info if payment was required
    const newAccount: RegisteredAccount = {
        accountId,
        registeredAt: new Date().toISOString()
    };
    
    if (paymentRequired && transactionHash && verificationResult) {
        newAccount.paymentTransactionHash = transactionHash;
        newAccount.paymentTransactionDate = verificationResult.transactionTimestamp!;
    }
    
    accountsDb.accounts[accountId] = newAccount;
    saveAccounts(accountsDb);
    
    res.status(201).json({
        message: 'Account registered successfully',
        account: accountsDb.accounts[accountId]
    });
});

// GET /api/accounts - List registered accounts
app.get('/api/accounts', (req: Request, res: Response) => {
    const accountsDb = loadAccounts();
    res.json({
        accounts: Object.values(accountsDb.accounts)
    });
});

// POST /api/jobs - REMOVED - Jobs are now automatic via continuous sync
// Kept as explicit 404 for backward compatibility with clients
app.post('/api/jobs', (req: Request, res: Response) => {
    return res.status(404).json({ 
        error: 'POST /api/jobs has been removed. Jobs are now processed automatically for registered accounts with valid payment.' 
    });
});

// GET /api/jobs/:jobId - Get job status
app.get('/api/jobs/:jobId', (req: Request, res: Response) => {
    const jobId = req.params.jobId;
    
    if (!jobId) {
        return res.status(400).json({ error: 'Job ID is required' });
    }
    
    const jobsDb = loadJobs();
    const job = jobsDb.jobs[jobId];
    
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }
    
    res.json({ job });
});

// GET /api/jobs - List all jobs (now using in-memory tracking)
app.get('/api/jobs', (req: Request, res: Response) => {
    const { accountId } = req.query;

    // Build jobs list from in-memory running jobs
    const jobs: any[] = Array.from(runningJobs.keys()).map(accountId => ({
        accountId,
        status: 'running',
        startedAt: new Date().toISOString() // We don't track start time, so use current time as placeholder
    }));

    // Filter by accountId if provided
    if (accountId && typeof accountId === 'string') {
        const filtered = jobs.filter(job => job.accountId === accountId);
        return res.json({ jobs: filtered });
    }

    res.json({ jobs });
});

// GET /api/accounts/:accountId/status - Get account data collection status
app.get('/api/accounts/:accountId/status', (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    
    if (!accountId) {
        return res.status(400).json({ error: 'Account ID is required' });
    }
    
    // Check if account is registered
    const accountsDb = loadAccounts();
    if (!accountsDb.accounts[accountId]) {
        return res.status(404).json({ error: 'Account not registered' });
    }
    
    // Check for running job (use in-memory Map, not jobs.json)
    const isRunning = runningJobs.has(accountId);

    // Check if data file exists and get metadata
    const outputFile = getAccountOutputFile(accountId);
    let dataRange = null;
    let hasData = false;
    
    if (fs.existsSync(outputFile)) {
        try {
            const fileContent = fs.readFileSync(outputFile, 'utf8');
            const accountHistory = JSON.parse(fileContent);
            hasData = true;
            dataRange = {
                firstBlock: accountHistory.metadata?.firstBlock || null,
                lastBlock: accountHistory.metadata?.lastBlock || null,
                totalTransactions: accountHistory.metadata?.totalTransactions || 0,
                updatedAt: accountHistory.updatedAt || null
            };
        } catch (error) {
            console.error('Error reading account data file:', error);
        }
    }
    
    res.json({
        accountId,
        hasData,
        dataRange,
        isRunning
    });
});

// GET /api/accounts/:accountId/download/json - Download account data as JSON
app.get('/api/accounts/:accountId/download/json', (req: Request, res: Response) => {
    const accountId = req.params.accountId;
    
    if (!accountId) {
        return res.status(400).json({ error: 'Account ID is required' });
    }
    
    // Check if account is registered
    const accountsDb = loadAccounts();
    if (!accountsDb.accounts[accountId]) {
        return res.status(404).json({ error: 'Account not registered' });
    }
    
    const outputFile = getAccountOutputFile(accountId);
    
    if (!fs.existsSync(outputFile)) {
        return res.status(404).json({ error: 'No data file found for this account yet' });
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${accountId}.json"`);
    
    const fileStream = fs.createReadStream(outputFile);
    fileStream.pipe(res);
});

// GET /api/accounts/:accountId/download/csv - Download account data as CSV
app.get('/api/accounts/:accountId/download/csv', async (req: Request, res: Response) => {
    try {
        const accountId = req.params.accountId;
        
        if (!accountId) {
            return res.status(400).json({ error: 'Account ID is required' });
        }
        
        // Check if account is registered
        const accountsDb = loadAccounts();
        if (!accountsDb.accounts[accountId]) {
            return res.status(404).json({ error: 'Account not registered' });
        }
        
        const outputFile = getAccountOutputFile(accountId);
        
        if (!fs.existsSync(outputFile)) {
            return res.status(404).json({ error: 'No data file found for this account yet' });
        }
        
        const csvFile = getAccountCsvFile(accountId);
        
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

// GET /api/accounts/:accountId/gap-analysis - Get gap analysis report
app.get('/api/accounts/:accountId/gap-analysis', (req: Request, res: Response) => {
    try {
        const accountId = req.params.accountId;

        if (!accountId) {
            return res.status(400).json({ error: 'Account ID is required' });
        }

        // Check if account is registered
        const accountsDb = loadAccounts();
        if (!accountsDb.accounts[accountId]) {
            return res.status(404).json({ error: 'Account not registered' });
        }

        const outputFile = getAccountOutputFile(accountId);

        if (!fs.existsSync(outputFile)) {
            return res.status(404).json({ error: 'No data file found for this account yet' });
        }

        // Read and parse the account history file
        const fileContent = fs.readFileSync(outputFile, 'utf-8');
        const history = JSON.parse(fileContent);

        if (!history.accountId || !Array.isArray(history.transactions)) {
            return res.status(500).json({ error: 'Invalid account history file format' });
        }

        // Run gap detection
        const gapAnalysis: GapAnalysis = detectGaps(history.transactions);

        // Format the response
        const response = {
            accountId: history.accountId,
            analyzedAt: new Date().toISOString(),
            summary: {
                totalGaps: gapAnalysis.totalGaps,
                internalGaps: gapAnalysis.internalGaps.length,
                hasGapToCreation: gapAnalysis.gapToCreation !== null,
                hasGapToPresent: gapAnalysis.gapToPresent !== null,
                isComplete: gapAnalysis.isComplete
            },
            metadata: {
                totalTransactions: history.transactions.length,
                firstBlock: history.metadata?.firstBlock || null,
                lastBlock: history.metadata?.lastBlock || null
            },
            gaps: [
                // Include gap to creation if it exists
                ...(gapAnalysis.gapToCreation ? [{
                    type: 'gap_to_creation',
                    startBlock: gapAnalysis.gapToCreation.startBlock,
                    endBlock: gapAnalysis.gapToCreation.endBlock,
                    mismatches: gapAnalysis.gapToCreation.verification.errors.map(err => ({
                        type: err.type,
                        token: err.token,
                        pool: err.pool,
                        expected: err.expected,
                        actual: err.actual,
                        message: err.message
                    }))
                }] : []),
                // Include all internal gaps
                ...gapAnalysis.internalGaps.map((gap: Gap) => ({
                    type: 'internal_gap',
                    startBlock: gap.startBlock,
                    endBlock: gap.endBlock,
                    mismatches: gap.verification.errors.map(err => ({
                        type: err.type,
                        token: err.token,
                        pool: err.pool,
                        expected: err.expected,
                        actual: err.actual,
                        message: err.message
                    }))
                })),
                // Include gap to present if it exists
                ...(gapAnalysis.gapToPresent ? [{
                    type: 'gap_to_present',
                    startBlock: gapAnalysis.gapToPresent.startBlock,
                    endBlock: gapAnalysis.gapToPresent.endBlock,
                    mismatches: gapAnalysis.gapToPresent.verification.errors.map(err => ({
                        type: err.type,
                        token: err.token,
                        pool: err.pool,
                        expected: err.expected,
                        actual: err.actual,
                        message: err.message
                    }))
                }] : [])
            ]
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

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Only start server when run directly (not when imported for testing)
if (import.meta.url === `file://${process.argv[1]}`) {
    const PORT = process.env.PORT || 3000;
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
        console.log('  POST   /api/accounts - Register an account (or renew subscription)');
        console.log('  GET    /api/accounts - List registered accounts');
        console.log('  GET    /api/accounts/:accountId/status - Get account status and data range');
        console.log('  GET    /api/accounts/:accountId/download/json - Download account data as JSON');
        console.log('  GET    /api/accounts/:accountId/download/csv - Download account data as CSV');
        console.log('  GET    /api/accounts/:accountId/gap-analysis - Get gap analysis report');
        console.log('  GET    /api/jobs - List all jobs');
        console.log('  GET    /api/jobs/:jobId - Get job status');
        console.log('  GET    /health - Health check');
        console.log('');
        console.log('Note: POST /api/jobs has been removed. Jobs run automatically.');

        // Start continuous sync loop
        startContinuousLoop();
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
        console.log('SIGTERM received, shutting down gracefully...');
        stopContinuousLoop();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });

    process.on('SIGINT', () => {
        console.log('SIGINT received, shutting down gracefully...');
        stopContinuousLoop();
        server.close(() => {
            console.log('Server closed');
            process.exit(0);
        });
    });
}

export { app };
