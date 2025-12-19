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
        it('should return 404 for POST /api/jobs (endpoint removed)', async function() {
            const response = await makeRequest('POST', '/api/jobs', {
                accountId: 'unregistered.near'
            });
            
            // POST /api/jobs has been removed - jobs are now automatic
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('POST /api/jobs has been removed'));
        });

        it('should list all jobs (may be empty initially)', async function() {
            const response = await makeRequest('GET', '/api/jobs');
            
            assert.equal(response.statusCode, 200);
            assert.ok(Array.isArray(response.body.jobs));
            // Jobs may be empty initially since POST /api/jobs is removed
            // Jobs are now created automatically by the continuous sync loop
        });

        it('should filter jobs by account ID', async function() {
            const response = await makeRequest('GET', `/api/jobs?accountId=${TEST_ACCOUNT}`);
            
            assert.equal(response.statusCode, 200);
            assert.ok(Array.isArray(response.body.jobs));
            
            // All jobs should belong to the test account (if any exist)
            for (const job of response.body.jobs) {
                assert.equal(job.accountId, TEST_ACCOUNT);
            }
        });

        it('should return 404 for non-existent job', async function() {
            const response = await makeRequest('GET', '/api/jobs/non-existent-job-id');
            
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('Job not found'));
        });
    });

    describe('Download Endpoints', function() {
        // Note: With the removal of POST /api/jobs, jobs are now created automatically
        // by the continuous sync loop. We skip the job completion wait since we can't
        // manually create jobs anymore.

        it('should reject download for account without data', async function() {
            // Register a new account that has no data
            const otherAccount = 'no-data-testaccount.near';
            await makeRequest('POST', '/api/accounts', { accountId: otherAccount });
            
            // Try to download (should fail because no data file exists)
            const response = await makeRequest('GET', `/api/accounts/${otherAccount}/download/json`);
            
            assert.equal(response.statusCode, 404);
            assert.ok(response.body.error.includes('No data file found'));
        });

        it('should download account data as JSON (or 404 if no data yet)', async function() {
            const response = await makeRequest('GET', `/api/accounts/${TEST_ACCOUNT}/download/json`);
            
            // For streaming responses, we expect either success or 404 if file doesn't exist
            // Without manual job creation, data file may not exist yet
            assert.ok(response.statusCode === 200 || response.statusCode === 404);
            
            if (response.statusCode === 200) {
                assert.ok(response.body.accountId);
                assert.ok(Array.isArray(response.body.transactions));
            }
        });

        it('should download account data as CSV (or 404 if no data yet)', async function() {
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

// Separate test suite for payment verification with real transactions
// This requires network access and tests against actual mainnet transactions
describe('API Server - Payment Verification', function() {
    this.timeout(120000);

    let serverProcess: any = null;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'api-payment');
    const PAYMENT_TEST_PORT = 3003;

    // Real DAO transaction that transfers 0.1 ARIZ via a Sputnik DAO proposal
    // Transaction: 93AijbdCEF8odXHzLsEx6D1ZCKdDquKoVungdzBZTYMD
    // - Signer: maledress6270.near (calls act_proposal on DAO)
    // - DAO: romakqatesting.sputnik-dao.near (executes ft_transfer)
    // - Recipient: arizcredits.near
    // - Amount: 100000 (0.1 ARIZ)
    const DAO_TRANSACTION_HASH = '93AijbdCEF8odXHzLsEx6D1ZCKdDquKoVungdzBZTYMD';
    const EXPECTED_DAO_ACCOUNT = 'romakqatesting.sputnik-dao.near';

    function makePaymentRequest(
        method: string,
        requestPath: string,
        body?: any
    ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
        return new Promise((resolve, reject) => {
            const options: http.RequestOptions = {
                hostname: 'localhost',
                port: PAYMENT_TEST_PORT,
                path: requestPath,
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

    before(async function() {
        // Setup test data directory
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

        // Start the API server WITH payment verification enabled
        const { spawn } = await import('child_process');
        
        serverProcess = spawn('node', ['dist/scripts/api-server.js'], {
            env: {
                ...process.env,
                PORT: PAYMENT_TEST_PORT.toString(),
                DATA_DIR: TEST_DATA_DIR,
                // Enable payment verification with default ARIZ settings
                REGISTRATION_FEE_AMOUNT: '100000',
                REGISTRATION_FEE_RECIPIENT: 'arizcredits.near',
                REGISTRATION_FEE_TOKEN: 'arizcredits.near',
                // Allow old transactions for testing (the test transaction is from the past)
                REGISTRATION_TX_MAX_AGE_MS: String(365 * 24 * 60 * 60 * 1000) // 1 year
            },
            stdio: 'inherit'
        });

        // Poll for server readiness
        for (let i = 0; i < 20; i++) {
            try {
                await makePaymentRequest('GET', '/health');
                break;
            } catch (error) {
                if (i === 19) {
                    throw new Error('Payment test server failed to start within timeout');
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    });

    after(function() {
        if (serverProcess) {
            serverProcess.kill();
        }

        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
    });

    describe('DAO Transaction Payment Verification', function() {
        it('should register account from DAO proposal ft_transfer in receipts', async function() {
            // Register using the DAO transaction hash
            // The ft_transfer is in the receipts, not in the top-level transaction actions
            const response = await makePaymentRequest('POST', '/api/accounts', {
                transactionHash: DAO_TRANSACTION_HASH
            });
            
            assert.equal(response.statusCode, 201, `Expected 201 but got ${response.statusCode}: ${JSON.stringify(response.body)}`);
            assert.equal(response.body.message, 'Account registered successfully');
            // The registered account should be the DAO (predecessor_id in receipt), not the signer
            assert.equal(response.body.account.accountId, EXPECTED_DAO_ACCOUNT);
            assert.ok(response.body.account.registeredAt);
        });

        it('should renew subscription when re-registering with same DAO transaction', async function() {
            const response = await makePaymentRequest('POST', '/api/accounts', {
                transactionHash: DAO_TRANSACTION_HASH
            });
            
            // With the new subscription model, re-registering with a valid tx hash renews the subscription
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.message, 'Subscription renewed successfully');
            assert.equal(response.body.account.accountId, EXPECTED_DAO_ACCOUNT);
            // Verify payment info is stored
            assert.ok(response.body.account.paymentTransactionHash);
            assert.ok(response.body.account.paymentTransactionDate);
        });

        it('should reject registration with invalid transaction hash', async function() {
            const response = await makePaymentRequest('POST', '/api/accounts', {
                transactionHash: 'InvalidTransactionHashThatDoesNotExist123456789'
            });
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('Payment verification failed'));
        });

        it('should reject registration without transaction hash when payment is required', async function() {
            const response = await makePaymentRequest('POST', '/api/accounts', {
                accountId: 'someaccount.near'
            });
            
            assert.equal(response.statusCode, 400);
            assert.ok(response.body.error.includes('transactionHash is required'));
        });
    });
});

// Test suite for CORS functionality
describe('API Server - CORS Configuration', function() {
    this.timeout(120000);

    let serverProcess: any = null;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'api-cors');
    const CORS_TEST_PORT = 3004;

    // Helper to make HTTP requests with Origin header
    function makeRequestWithOrigin(
        method: string,
        requestPath: string,
        origin: string,
        body?: any
    ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
        return new Promise((resolve, reject) => {
            const options: http.RequestOptions = {
                hostname: 'localhost',
                port: CORS_TEST_PORT,
                path: requestPath,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Origin': origin
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

    describe('Default CORS Configuration (allow all)', function() {
        before(async function() {
            // Setup test data directory
            if (fs.existsSync(TEST_DATA_DIR)) {
                fs.rmSync(TEST_DATA_DIR, { recursive: true });
            }
            fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

            // Start the API server without CORS_ALLOWED_ORIGINS (defaults to *)
            const { spawn } = await import('child_process');
            
            serverProcess = spawn('node', ['dist/scripts/api-server.js'], {
                env: {
                    ...process.env,
                    PORT: CORS_TEST_PORT.toString(),
                    DATA_DIR: TEST_DATA_DIR,
                    REGISTRATION_FEE_AMOUNT: '0' // Disable payment verification for tests
                    // CORS_ALLOWED_ORIGINS not set - should default to '*'
                },
                stdio: 'inherit'
            });

            // Poll for server readiness
            for (let i = 0; i < 20; i++) {
                try {
                    await makeRequestWithOrigin('GET', '/health', 'https://example.com');
                    break;
                } catch (error) {
                    if (i === 19) {
                        throw new Error('CORS test server failed to start within timeout');
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        });

        after(function() {
            if (serverProcess) {
                serverProcess.kill();
            }

            if (fs.existsSync(TEST_DATA_DIR)) {
                fs.rmSync(TEST_DATA_DIR, { recursive: true });
            }
        });

        it('should allow requests from any origin when CORS_ALLOWED_ORIGINS is not set', async function() {
            const response = await makeRequestWithOrigin('GET', '/health', 'https://example.com');
            
            assert.equal(response.statusCode, 200);
            assert.ok(response.headers['access-control-allow-origin']);
        });

        it('should allow requests from different origins', async function() {
            const response1 = await makeRequestWithOrigin('GET', '/health', 'https://app1.example.com');
            const response2 = await makeRequestWithOrigin('GET', '/health', 'https://app2.example.com');
            
            assert.equal(response1.statusCode, 200);
            assert.equal(response2.statusCode, 200);
        });

        it('should allow requests without Origin header', async function() {
            // Make request without Origin header
            const response = await new Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
                const options: http.RequestOptions = {
                    hostname: 'localhost',
                    port: CORS_TEST_PORT,
                    path: '/health',
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json'
                        // No Origin header
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
                req.end();
            });
            
            assert.equal(response.statusCode, 200);
        });
    });

    describe('Restricted CORS Configuration', function() {
        let restrictedServerProcess: any = null;
        const RESTRICTED_TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'api-cors-restricted');
        const RESTRICTED_TEST_PORT = 3005;

        before(async function() {
            // Setup test data directory
            if (fs.existsSync(RESTRICTED_TEST_DATA_DIR)) {
                fs.rmSync(RESTRICTED_TEST_DATA_DIR, { recursive: true });
            }
            fs.mkdirSync(RESTRICTED_TEST_DATA_DIR, { recursive: true });

            // Start the API server with restricted CORS origins
            const { spawn } = await import('child_process');
            
            restrictedServerProcess = spawn('node', ['dist/scripts/api-server.js'], {
                env: {
                    ...process.env,
                    PORT: RESTRICTED_TEST_PORT.toString(),
                    DATA_DIR: RESTRICTED_TEST_DATA_DIR,
                    REGISTRATION_FEE_AMOUNT: '0', // Disable payment verification for tests
                    CORS_ALLOWED_ORIGINS: 'https://allowed1.example.com,https://allowed2.example.com'
                },
                stdio: 'inherit'
            });

            // Helper for restricted server requests
            function makeRestrictedRequest(
                method: string,
                requestPath: string,
                origin: string,
                body?: any
            ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
                return new Promise((resolve, reject) => {
                    const options: http.RequestOptions = {
                        hostname: 'localhost',
                        port: RESTRICTED_TEST_PORT,
                        path: requestPath,
                        method,
                        headers: {
                            'Content-Type': 'application/json',
                            'Origin': origin
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

            // Poll for server readiness
            for (let i = 0; i < 20; i++) {
                try {
                    await makeRestrictedRequest('GET', '/health', 'https://allowed1.example.com');
                    break;
                } catch (error) {
                    if (i === 19) {
                        throw new Error('Restricted CORS test server failed to start within timeout');
                    }
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }
        });

        after(function() {
            if (restrictedServerProcess) {
                restrictedServerProcess.kill();
            }

            if (fs.existsSync(RESTRICTED_TEST_DATA_DIR)) {
                fs.rmSync(RESTRICTED_TEST_DATA_DIR, { recursive: true });
            }
        });

        it('should allow requests from explicitly allowed origin', async function() {
            function makeRestrictedRequest(
                method: string,
                requestPath: string,
                origin: string
            ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
                return new Promise((resolve, reject) => {
                    const options: http.RequestOptions = {
                        hostname: 'localhost',
                        port: RESTRICTED_TEST_PORT,
                        path: requestPath,
                        method,
                        headers: {
                            'Content-Type': 'application/json',
                            'Origin': origin
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
                    req.end();
                });
            }

            const response = await makeRestrictedRequest('GET', '/health', 'https://allowed1.example.com');
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['access-control-allow-origin'], 'https://allowed1.example.com');
        });

        it('should allow requests from second allowed origin', async function() {
            function makeRestrictedRequest(
                method: string,
                requestPath: string,
                origin: string
            ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
                return new Promise((resolve, reject) => {
                    const options: http.RequestOptions = {
                        hostname: 'localhost',
                        port: RESTRICTED_TEST_PORT,
                        path: requestPath,
                        method,
                        headers: {
                            'Content-Type': 'application/json',
                            'Origin': origin
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
                    req.end();
                });
            }

            const response = await makeRestrictedRequest('GET', '/health', 'https://allowed2.example.com');
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.headers['access-control-allow-origin'], 'https://allowed2.example.com');
        });
    });
});
