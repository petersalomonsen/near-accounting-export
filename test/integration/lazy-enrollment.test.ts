// Test case for lazy enrollment functionality
import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRouter, startWorker } from '../../scripts/api-server.js';
import express from 'express';
import type { Request, Response } from 'express';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Helper to make HTTP requests
function makeRequest(
    port: number,
    method: string,
    path: string,
    headers?: Record<string, string>,
    body?: any
): Promise<{ statusCode: number; body: any; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: 'localhost',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...headers
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

describe('Lazy Enrollment', function () {
    this.timeout(60000);

    let server: any;
    let worker: any;
    const TEST_DATA_DIR = path.join(__dirname, '..', '..', 'test-data', 'lazy-enrollment');
    const TEST_PORT = 3007;

    before(async function () {
        // Setup test data directory
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
        fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

        // Create Express app with router
        const app = express();

        // Create router with getAccountId hook that reads from X-Account-Id header
        const router = createRouter({
            getAccountId: (req: Request): string => {
                const accountId = req.headers['x-account-id'];
                if (!accountId || typeof accountId !== 'string') {
                    throw new Error('X-Account-Id header is required');
                }
                return accountId;
            },
            dataDir: TEST_DATA_DIR
        });

        app.use('/api/accounting', router);

        // Start server
        await new Promise<void>((resolve) => {
            server = app.listen(TEST_PORT, () => {
                console.log(`Test server running on port ${TEST_PORT}`);
                resolve();
            });
        });

        // Start worker (but don't wait for it to complete)
        worker = await startWorker({ dataDir: TEST_DATA_DIR });
    });

    after(async function () {
        // Stop worker first
        if (worker) {
            await worker.stop();
        }

        // Stop server
        if (server) {
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
        }

        // Cleanup test data
        if (fs.existsSync(TEST_DATA_DIR)) {
            fs.rmSync(TEST_DATA_DIR, { recursive: true });
        }
    });

    describe('Account Auto-Registration', function () {
        it('should automatically register an account on first API request', async function () {
            const testAccount = 'testaccount.near';

            // Make first request - should trigger lazy enrollment
            const response = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/status',
                { 'X-Account-Id': testAccount }
            );

            // Request should succeed
            assert.equal(response.statusCode, 200);
            assert.equal(response.body.accountId, testAccount);

            // Verify account was registered in accounts.json
            const accountsFile = path.join(TEST_DATA_DIR, 'accounts.json');
            assert.ok(fs.existsSync(accountsFile), 'accounts.json should exist');

            const accountsData = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
            assert.ok(accountsData.accounts[testAccount], 'Account should be registered');
            assert.equal(accountsData.accounts[testAccount].accountId, testAccount);
            assert.ok(accountsData.accounts[testAccount].registeredAt, 'Should have registeredAt timestamp');
        });

        it('should not duplicate registration on subsequent requests', async function () {
            const testAccount = 'testaccount2.near';

            // Make first request
            const response1 = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/status',
                { 'X-Account-Id': testAccount }
            );
            assert.equal(response1.statusCode, 200);

            // Read accounts file after first request
            const accountsFile = path.join(TEST_DATA_DIR, 'accounts.json');
            const accountsData1 = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
            const registeredAt1 = accountsData1.accounts[testAccount].registeredAt;

            // Wait a bit to ensure timestamp would be different if re-registered
            await new Promise(resolve => setTimeout(resolve, 100));

            // Make second request
            const response2 = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/download/json',
                { 'X-Account-Id': testAccount }
            );

            // Should return 404 (no data yet), but should have processed the auth
            assert.ok(response2.statusCode === 404 || response2.statusCode === 200);

            // Verify registration timestamp hasn't changed
            const accountsData2 = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
            const registeredAt2 = accountsData2.accounts[testAccount].registeredAt;

            assert.equal(registeredAt2, registeredAt1, 'Registration timestamp should not change on subsequent requests');
        });

        it('should register different accounts independently', async function () {
            const accounts = ['account1.near', 'account2.near', 'account3.near'];

            // Make requests for different accounts
            for (const account of accounts) {
                const response = await makeRequest(
                    TEST_PORT,
                    'GET',
                    '/api/accounting/status',
                    { 'X-Account-Id': account }
                );
                assert.equal(response.statusCode, 200);
                assert.equal(response.body.accountId, account);
            }

            // Verify all accounts were registered
            const accountsFile = path.join(TEST_DATA_DIR, 'accounts.json');
            const accountsData = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));

            for (const account of accounts) {
                assert.ok(accountsData.accounts[account], `Account ${account} should be registered`);
                assert.equal(accountsData.accounts[account].accountId, account);
            }
        });

        it('should reject requests without authentication', async function () {
            const response = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/status',
                {} // No X-Account-Id header
            );

            assert.equal(response.statusCode, 401);
            assert.ok(response.body.error.includes('Unauthorized'));
        });

        it('should reject invalid NEAR account IDs', async function () {
            const invalidAccounts = [
                'Invalid Account!',
                'account with spaces',
                'UPPERCASE.near',
                ''
            ];

            for (const invalidAccount of invalidAccounts) {
                const response = await makeRequest(
                    TEST_PORT,
                    'GET',
                    '/api/accounting/status',
                    { 'X-Account-Id': invalidAccount }
                );

                assert.ok(
                    response.statusCode === 400 || response.statusCode === 401,
                    `Should reject invalid account: ${invalidAccount}`
                );
            }
        });
    });

    describe('Worker Integration', function () {
        it('should allow worker to process lazily-enrolled accounts', async function () {
            const testAccount = 'worker-test.near';

            // Trigger lazy enrollment
            const response = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/status',
                { 'X-Account-Id': testAccount }
            );
            assert.equal(response.statusCode, 200);

            // Verify account is registered and available to worker
            const accountsFile = path.join(TEST_DATA_DIR, 'accounts.json');
            const accountsData = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));

            assert.ok(accountsData.accounts[testAccount], 'Account should be registered');

            // Note: We don't test actual worker processing here as it requires
            // network access and takes time. The integration is verified by
            // checking that the account is in accounts.json which the worker reads.
        });
    });

    describe('No Payment Verification', function () {
        it('should not require payment transaction hash', async function () {
            const testAccount = 'no-payment.near';

            // Request should succeed without any payment info
            const response = await makeRequest(
                TEST_PORT,
                'GET',
                '/api/accounting/status',
                { 'X-Account-Id': testAccount }
            );

            assert.equal(response.statusCode, 200);
            assert.equal(response.body.accountId, testAccount);

            // Verify account has no payment fields
            const accountsFile = path.join(TEST_DATA_DIR, 'accounts.json');
            const accountsData = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
            const account = accountsData.accounts[testAccount];

            assert.ok(account, 'Account should be registered');
            assert.equal(account.paymentTransactionHash, undefined, 'Should not have payment hash');
            assert.equal(account.paymentTransactionDate, undefined, 'Should not have payment date');
        });
    });
});
