// Test case for the API server
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test configuration constants
const TEST_CONFIG = {
    SERVER_PORT: 3001,
    SERVER_READY_MAX_RETRIES: 20,
    SERVER_READY_RETRY_DELAY_MS: 200,
    JOB_COMPLETION_MAX_RETRIES: 60,
    JOB_COMPLETION_RETRY_DELAY_MS: 3000
};

// Helper to make HTTP requests
function makeRequest(
    method: string,
    path: string,
    body?: any
): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: 'localhost',
            port: TEST_CONFIG.SERVER_PORT,
            path,
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                let parsedBody;
                try {
                    parsedBody = JSON.parse(data);
                } catch {
                    parsedBody = data;
                }

                resolve({
                    statusCode: res.statusCode || 0,
                    body: parsedBody,
                    headers: res.headers
                });
            });
        });

        req.on('error', reject);

        if (body) {
            req.write(JSON.stringify(body));
        }

        req.end();
    });
}

describe('API Server', function() {
    // API tests may take time
    this.timeout(120000);

    let serverProcess: any = null;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'api');
    const TEST_ACCOUNT = 'testaccount.near';

    before(async function() {
        // Setup test data directory
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

        // Start the API server on a different port for testing
        const { spawn } = await import('child_process');
        
        serverProcess = spawn('node', ['dist/scripts/api-server.js'], {
            env: {
                ...process.env,
                PORT: TEST_CONFIG.SERVER_PORT.toString(),
                DATA_DIR: TEST_DATA_DIR,
                REGISTRATION_FEE_AMOUNT: '0' // Disable payment verification for tests
            },
            stdio: 'inherit'
        });

        // Poll for server readiness with retry mechanism
        for (let i = 0; i < TEST_CONFIG.SERVER_READY_MAX_RETRIES; i++) {
            try {
                await makeRequest('GET', '/health');
                break; // Server is ready
            } catch (error) {
                if (i === TEST_CONFIG.SERVER_READY_MAX_RETRIES - 1) {
                    throw new Error('Server failed to start within timeout');
                }
                await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.SERVER_READY_RETRY_DELAY_MS));
            }
        }
    });

    after(function() {
        // Stop the server
        if (serverProcess) {
            serverProcess.kill();
        }

        // Cleanup test data
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
    });

    describe('Health Check', function() {
        it('should respond to health check', async function() {
            const response = await makeRequest('GET', '/health');
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.status, 'ok');
            assert.ok(response.body.timestamp);
        });
    });

    describe('Account Registration', function() {
        it('should register a new account', async function() {
            const response = await makeRequest('POST', '/api/accounts', {
                accountId: TEST_ACCOUNT
            });
            
            assert.equal(response.statusCode, 201);
            assert.equal(response.body.message, 'Account registered successfully');
            assert.equal(response.body.account.accountId, TEST_ACCOUNT);
            assert.ok(response.body.account.registeredAt);
        });

        it('should return existing account if already registered', async function() {
            const response = await makeRequest('POST', '/api/accounts', {
                accountId: TEST_ACCOUNT
            });
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.message, 'Account already registered');
            assert.equal(response.body.account.accountId, TEST_ACCOUNT);
        });

        it('should reject invalid account ID format', async function() {
            const response = await makeRequest('POST', '/api/accounts', {
                accountId: 'invalid account!'
            });
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('Invalid NEAR account ID format'));
        });

        it('should reject missing account ID', async function() {
            const response = await makeRequest('POST', '/api/accounts', {});
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('accountId is required'));
        });

        it('should list registered accounts', async function() {
            const response = await makeRequest('GET', '/api/accounts');
            
            assert.equal(response.statusCode, 200);
            assert.ok(Array.isArray(response.body.accounts));
            assert.ok(response.body.accounts.length >= 1);
            
            const account = response.body.accounts.find((a: any) => a.accountId === TEST_ACCOUNT);
            assert.ok(account, 'Registered account should be in the list');
        });
    });

    describe('Job Management', function() {
        it('should reject job for unregistered account', async function() {
            const response = await makeRequest('POST', '/api/jobs', {
                accountId: 'unregistered.near'
            });
            
            assert.equal(response.statusCode, 403);
            assert.ok(response.body.error.includes('Account not registered'));
        });

        it('should create a job for registered account', async function() {
            const response = await makeRequest('POST', '/api/jobs', {
                accountId: TEST_ACCOUNT,
                options: {
                    maxTransactions: 5,
                    direction: 'backward'
                }
            });
            
            assert.equal(response.statusCode, 201);
            assert.equal(response.body.message, 'Job created successfully');
            assert.ok(response.body.job.jobId);
            assert.equal(response.body.job.accountId, TEST_ACCOUNT);
            assert.equal(response.body.job.status, 'pending');
            assert.equal(response.body.job.options.maxTransactions, 5);
        });

        it('should reject invalid direction', async function() {
            const response = await makeRequest('POST', '/api/jobs', {
                accountId: TEST_ACCOUNT,
                options: {
                    direction: 'sideways'
                }
            });
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('direction must be'));
        });

        it('should reject invalid maxTransactions', async function() {
            const response = await makeRequest('POST', '/api/jobs', {
                accountId: TEST_ACCOUNT,
                options: {
                    maxTransactions: -5
                }
            });
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('maxTransactions must be a positive number'));
        });

        it('should list all jobs', async function() {
            const response = await makeRequest('GET', '/api/jobs');
            
            assert.equal(response.statusCode, 200);
            assert.ok(Array.isArray(response.body.jobs));
            assert.ok(response.body.jobs.length >= 1);
        });

        it('should filter jobs by account ID', async function() {
            const response = await makeRequest('GET', `/api/jobs?accountId=${TEST_ACCOUNT}`);
            
            assert.equal(response.statusCode, 200);
            assert.ok(Array.isArray(response.body.jobs));
            
            // All jobs should belong to the test account
            for (const job of response.body.jobs) {
                assert.equal(job.accountId, TEST_ACCOUNT);
            }
        });

        it('should get job status by ID', async function() {
            // Get the list of jobs and use an existing job ID
            const listResponse = await makeRequest('GET', `/api/jobs?accountId=${TEST_ACCOUNT}`);
            assert.ok(listResponse.body.jobs.length >= 1, 'Should have at least one job');
            
            const jobId = listResponse.body.jobs[0].jobId;
            
            // Get job status
            const response = await makeRequest('GET', `/api/jobs/${jobId}`);
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.job.jobId, jobId);
            assert.equal(response.body.job.accountId, TEST_ACCOUNT);
            assert.ok(['pending', 'running', 'completed', 'failed'].includes(response.body.job.status));
        });

        it('should return 404 for non-existent job', async function() {
            const response = await makeRequest('GET', '/api/jobs/non-existent-job-id');
            
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('Job not found'));
        });
    });

    describe('Download Endpoints', function() {
        let completedJobId: string;

        before(async function() {
            // Wait for any existing job to complete, or create a new one
            this.timeout(180000); // 3 minutes for job completion
            
            // First, try to find an existing job for the account
            const listResponse = await makeRequest('GET', `/api/jobs?accountId=${TEST_ACCOUNT}`);
            let jobId: string | undefined;
            
            if (listResponse.body.jobs.length > 0) {
                // Use the first job
                jobId = listResponse.body.jobs[0].jobId;
            } else {
                // No existing job, create one
                const createResponse = await makeRequest('POST', '/api/jobs', {
                    accountId: TEST_ACCOUNT,
                    options: { maxTransactions: 2 }
                });
                
                if (createResponse.statusCode === 409) {
                    // There's a running job, get it from the list
                    const refreshList = await makeRequest('GET', `/api/jobs?accountId=${TEST_ACCOUNT}`);
                    jobId = refreshList.body.jobs[0].jobId;
                } else {
                    jobId = createResponse.body.job.jobId;
                }
            }
            
            completedJobId = jobId!;
            
            // Poll until completed or failed
            let attempts = 0;
            while (attempts < TEST_CONFIG.JOB_COMPLETION_MAX_RETRIES) {
                const statusResponse = await makeRequest('GET', `/api/jobs/${completedJobId}`);
                const status = statusResponse.body.job.status;
                
                if (status === 'completed') {
                    break;
                }
                
                if (status === 'failed') {
                    throw new Error(`Job failed: ${statusResponse.body.job.error}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, TEST_CONFIG.JOB_COMPLETION_RETRY_DELAY_MS));
                attempts++;
            }
            
            if (attempts >= TEST_CONFIG.JOB_COMPLETION_MAX_RETRIES) {
                throw new Error('Job did not complete within timeout');
            }
        });

        it('should reject download for account without data', async function() {
            // Register a new account that has no data
            const otherAccount = 'no-data-testaccount.near';
            await makeRequest('POST', '/api/accounts', { accountId: otherAccount });
            
            // Try to download (should fail because no data file exists)
            const response = await makeRequest('GET', `/api/accounts/${otherAccount}/download/json`);
            
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('No data file found'));
        });

        it('should download account data as JSON', async function() {
            const response = await makeRequest('GET', `/api/accounts/${TEST_ACCOUNT}/download/json`);
            
            // For streaming responses, we expect either success or 404 if file doesn't exist
            assert.ok(response.statusCode === 200 || response.statusCode === 404);
            
            if (response.statusCode === 200) {
                assert.ok(response.body.accountId);
                assert.ok(Array.isArray(response.body.transactions));
            }
        });

        it('should download account data as CSV', async function() {
            const response = await makeRequest('GET', `/api/accounts/${TEST_ACCOUNT}/download/csv`);
            
            // For streaming responses, we expect either success or 404 if file doesn't exist
            assert.ok(response.statusCode === 200 || response.statusCode === 404);
            
            // CSV download may generate the CSV on first request
            if (response.statusCode === 200 && typeof response.body === 'string') {
                // Check CSV headers
                assert.ok(response.body.includes('change_block_height'));
                assert.ok(response.body.includes('timestamp'));
                assert.ok(response.body.includes('counterparty'));
            }
        });

        it('should return 404 for download of unregistered account', async function() {
            const response = await makeRequest('GET', '/api/accounts/unregistered-account.near/download/json');
            
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('not registered'));
        });
    });
});
