#!/usr/bin/env node
// API Server for NEAR Accounting Export
// Provides REST endpoints for account registration, data collection jobs, and downloads

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

import { getAccountHistory, verifyHistoryFile } from './get-account-history.js';
import type { TransactionEntry } from './get-account-history.js';
import { convertJsonToCsv } from './json-to-csv.js';
import { getClient } from './rpc.js';

// Payment verification configuration
const PAYMENT_CONFIG = {
    requiredAmount: process.env.REGISTRATION_FEE_AMOUNT || '100000', // 0.1 ARIZ (6 decimals = 100000)
    recipientAccount: process.env.REGISTRATION_FEE_RECIPIENT || 'arizcredits.near',
    ftContractId: process.env.REGISTRATION_FEE_TOKEN || 'arizcredits.near', // Default to ARIZ
    maxAge: parseInt(process.env.REGISTRATION_TX_MAX_AGE_MS || String(30 * 24 * 60 * 60 * 1000), 10) // Default 30 days
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

// Validation helpers
function isValidNearAccountId(accountId: string): boolean {
    return /^([a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(accountId);
}

// Payment verification
interface PaymentVerificationResult {
    valid: boolean;
    senderAccountId?: string;
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
        
        // Check if transaction has FT transfer action
        const actions = transaction.actions || [];
        let ftTransferFound = false;
        let transferAmount = '0';
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
        
        // Check transaction status
        const status = txResult.status;
        if (!status || !status.SuccessValue !== undefined && !status.SuccessReceiptId) {
            return { valid: false, error: 'Transaction failed' };
        }
        
        return { 
            valid: true, 
            senderAccountId 
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

// Middleware to log requests
app.use((req: Request, res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
});

// NOTE: For production use, consider adding:
// - Rate limiting middleware (e.g., express-rate-limit) to prevent abuse
// - Authentication middleware to protect endpoints
// - CORS configuration based on your needs
// - Input sanitization and validation middleware

// POST /api/accounts - Register an account
app.post('/api/accounts', async (req: Request, res: Response) => {
    const { transactionHash } = req.body;
    
    if (!transactionHash || typeof transactionHash !== 'string') {
        return res.status(400).json({ error: 'transactionHash is required and must be a string' });
    }
    
    try {
        // Verify the payment transaction
        const verificationResult = await verifyPaymentTransaction(transactionHash);
        
        if (!verificationResult.valid) {
            return res.status(400).json({ 
                error: 'Payment verification failed', 
                details: verificationResult.error 
            });
        }
        
        const accountId = verificationResult.senderAccountId!;
        const accountsDb = loadAccounts();
        
        if (accountsDb.accounts[accountId]) {
            return res.status(200).json({
                message: 'Account already registered',
                account: accountsDb.accounts[accountId]
            });
        }
        
        accountsDb.accounts[accountId] = {
            accountId,
            registeredAt: new Date().toISOString()
        };
        
        saveAccounts(accountsDb);
        
        res.status(201).json({
            message: 'Account registered successfully',
            account: accountsDb.accounts[accountId]
        });
    } catch (error) {
        console.error('Error verifying payment transaction:', error);
        res.status(500).json({ 
            error: 'Failed to verify payment transaction',
            details: error instanceof Error ? error.message : String(error)
        });
    }
});

// GET /api/accounts - List registered accounts
app.get('/api/accounts', (req: Request, res: Response) => {
    const accountsDb = loadAccounts();
    res.json({
        accounts: Object.values(accountsDb.accounts)
    });
});

// POST /api/jobs - Start a data collection job
app.post('/api/jobs', (req: Request, res: Response) => {
    const { accountId, options = {} } = req.body;
    
    if (!accountId || typeof accountId !== 'string') {
        return res.status(400).json({ error: 'accountId is required and must be a string' });
    }
    
    // Check if account is registered
    const accountsDb = loadAccounts();
    if (!accountsDb.accounts[accountId]) {
        return res.status(403).json({ 
            error: 'Account not registered. Please register the account first using POST /api/accounts' 
        });
    }
    
    // Check if there's already a running job for this account
    if (runningJobs.has(accountId)) {
        return res.status(409).json({ 
            error: 'A job is already running for this account. Only one job per account can run at a time.' 
        });
    }
    
    // Validate options
    if (options.direction && !['forward', 'backward'].includes(options.direction)) {
        return res.status(400).json({ error: 'direction must be "forward" or "backward"' });
    }
    
    if (options.maxTransactions !== undefined && (typeof options.maxTransactions !== 'number' || options.maxTransactions <= 0)) {
        return res.status(400).json({ error: 'maxTransactions must be a positive number' });
    }
    
    // Create job
    const jobId = uuidv4();
    const job: Job = {
        jobId,
        accountId,
        status: 'pending',
        createdAt: new Date().toISOString(),
        options: {
            direction: options.direction || 'backward',
            maxTransactions: options.maxTransactions || 100,
            startBlock: options.startBlock,
            endBlock: options.endBlock
        }
    };
    
    const jobsDb = loadJobs();
    jobsDb.jobs[jobId] = job;
    saveJobs(jobsDb);
    
    // Start processing in background - track by accountId
    const jobPromise = processJob(jobId);
    runningJobs.set(accountId, jobPromise);
    
    res.status(201).json({
        message: 'Job created successfully',
        job: {
            jobId: job.jobId,
            accountId: job.accountId,
            status: job.status,
            createdAt: job.createdAt,
            options: job.options
        }
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

// GET /api/jobs - List all jobs
app.get('/api/jobs', (req: Request, res: Response) => {
    const { accountId } = req.query;
    
    const jobsDb = loadJobs();
    let jobs = Object.values(jobsDb.jobs);
    
    // Filter by accountId if provided
    if (accountId && typeof accountId === 'string') {
        jobs = jobs.filter(job => job.accountId === accountId);
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
    
    // Check for running job
    const jobsDb = loadJobs();
    const accountJobs = Object.values(jobsDb.jobs).filter(job => job.accountId === accountId);
    const runningJob = accountJobs.find(job => job.status === 'running' || job.status === 'pending');
    
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
        ongoingJob: runningJob ? {
            jobId: runningJob.jobId,
            status: runningJob.status,
            createdAt: runningJob.createdAt,
            startedAt: runningJob.startedAt,
            options: runningJob.options
        } : null
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

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error', message: err.message });
});

// Start server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log('');
    console.log('Available endpoints:');
    console.log('  POST   /api/accounts - Register an account');
    console.log('  GET    /api/accounts - List registered accounts');
    console.log('  GET    /api/accounts/:accountId/status - Get account status and data range');
    console.log('  GET    /api/accounts/:accountId/download/json - Download account data as JSON');
    console.log('  GET    /api/accounts/:accountId/download/csv - Download account data as CSV');
    console.log('  POST   /api/jobs - Start a data collection job');
    console.log('  GET    /api/jobs - List all jobs');
    console.log('  GET    /api/jobs/:jobId - Get job status');
    console.log('  GET    /health - Health check');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

export { app };
