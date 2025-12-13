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
app.post('/api/accounts', (req: Request, res: Response) => {
    const { accountId } = req.body;
    
    if (!accountId || typeof accountId !== 'string') {
        return res.status(400).json({ error: 'accountId is required and must be a string' });
    }
    
    // Basic validation for NEAR account ID format
    if (!isValidNearAccountId(accountId)) {
        return res.status(400).json({ error: 'Invalid NEAR account ID format' });
    }
    
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
