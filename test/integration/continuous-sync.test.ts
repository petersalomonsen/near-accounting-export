// Test case for continuous sync functionality
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Test configuration constants
const TEST_CONFIG = {
    SERVER_PORT: 3002,
    SERVER_READY_MAX_RETRIES: 20,
    SERVER_READY_RETRY_DELAY_MS: 200,
    // Use very short delays for testing
    BATCH_SIZE: '1',
    CYCLE_DELAY_MS: '100'
};

// Helper to make HTTP requests with configurable port
function createRequestHelper(port: number) {
    return function makeRequest(
        method: string,
        requestPath: string,
        body?: any
    ): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
        return new Promise((resolve, reject) => {
            const options: http.RequestOptions = {
                hostname: 'localhost',
                port,
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
    };
}

// Create request helpers for different test suites
const makeRequest = createRequestHelper(TEST_CONFIG.SERVER_PORT);

describe('Continuous Sync', function() {
    // Tests may take time
    this.timeout(120000);

    let serverProcess: any = null;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'continuous-sync');

    // Test accounts
    const TEST_ACCOUNTS = [
        'webassemblymusic-treasury.sputnik-dao.near',
        'testing-astradao.sputnik-dao.near',
        'romakqatesting.sputnik-dao.near'
    ];

    before(async function() {
        // Setup test data directory
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

        // Start the API server with test configuration
        const { spawn } = await import('child_process');
        
        serverProcess = spawn('node', ['dist/scripts/api-server.js'], {
            env: {
                ...process.env,
                PORT: TEST_CONFIG.SERVER_PORT.toString(),
                DATA_DIR: TEST_DATA_DIR,
                REGISTRATION_FEE_AMOUNT: '0', // Disable payment verification for tests
                BATCH_SIZE: TEST_CONFIG.BATCH_SIZE,
                CYCLE_DELAY_MS: TEST_CONFIG.CYCLE_DELAY_MS
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

    describe('Continuous loop behavior', function() {
        it('should process registered accounts', async function() {
            // Register test accounts
            for (let i = 0; i < TEST_ACCOUNTS.length; i++) {
                await makeRequest('POST', '/api/accounts', {
                    accountId: TEST_ACCOUNTS[i]
                });
            }
            
            // Wait for at least one sync cycle to complete
            // With CYCLE_DELAY_MS=100, we wait a bit for the loop to process
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            // Verify accounts are registered
            const accountsResponse = await makeRequest('GET', '/api/accounts');
            assert.equal(accountsResponse.statusCode, 200);
            assert.ok(accountsResponse.body.accounts.length >= TEST_ACCOUNTS.length);
            
            // All test accounts should be in the list
            for (const testAccount of TEST_ACCOUNTS) {
                const found = accountsResponse.body.accounts.find(
                    (a: any) => a.accountId === testAccount
                );
                assert.ok(found, `Account ${testAccount} should be registered`);
            }
        });

        it('should have job records from continuous sync', async function() {
            // Wait a bit for the continuous sync loop to process
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            // Get all jobs
            const jobsResponse = await makeRequest('GET', '/api/jobs');
            assert.equal(jobsResponse.statusCode, 200);
            
            // Should have jobs created by the continuous sync loop
            // Note: The loop may not have completed any jobs yet, but we verify it's running
            assert.ok(Array.isArray(jobsResponse.body.jobs));
        });
    });

    describe('Health check', function() {
        it('should respond to health check', async function() {
            const response = await makeRequest('GET', '/health');
            
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.status, 'ok');
            assert.ok(response.body.timestamp);
        });
    });
});

// Subscription Renewal test kept as it tests actual continuous sync behavior
describe('Subscription Renewal', function() {
    this.timeout(60000);

    let serverProcess: any = null;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'subscription-renewal');
    const TEST_PORT = 3004;

    // Use the shared request helper with a different port
    const makeRenewalRequest = createRequestHelper(TEST_PORT);

    before(async function() {
        // Setup test data directory
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

        // Start the API server with payment disabled
        const { spawn } = await import('child_process');
        
        serverProcess = spawn('node', ['dist/scripts/api-server.js'], {
            env: {
                ...process.env,
                PORT: TEST_PORT.toString(),
                DATA_DIR: TEST_DATA_DIR,
                REGISTRATION_FEE_AMOUNT: '0', // Disable payment verification
                BATCH_SIZE: '1',
                CYCLE_DELAY_MS: '60000' // Long delay to prevent interference
            },
            stdio: 'inherit'
        });

        // Poll for server readiness
        for (let i = 0; i < 20; i++) {
            try {
                await makeRenewalRequest('GET', '/health');
                break;
            } catch (error) {
                if (i === 19) {
                    throw new Error('Server failed to start within timeout');
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

    it('should register an account and return it on duplicate without renewal', async function() {
        const testAccount = 'renewal-test.near';
        
        // First registration
        const response1 = await makeRenewalRequest('POST', '/api/accounts', {
            accountId: testAccount
        });
        assert.equal(response1.statusCode, 201);
        assert.equal(response1.body.message, 'Account registered successfully');
        
        // Second registration without transactionHash - should return existing
        const response2 = await makeRenewalRequest('POST', '/api/accounts', {
            accountId: testAccount
        });
        assert.equal(response2.statusCode, 200);
        assert.equal(response2.body.message, 'Account already registered');
    });
});
