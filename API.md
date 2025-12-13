# API Server Documentation

## Overview

The API server provides REST endpoints for managing NEAR account data collection jobs, including account registration, job creation, account status tracking with data range information, and data downloads in JSON and CSV formats.

**Important:** 
- Each account has a single JSON file (`accountId.json`) and CSV file (`accountId.csv`) in the data directory
- Multiple jobs can be created for the same account, each job appending or continuing from the existing file
- Only one job can run per account at a time (enforced to prevent conflicts)
- Data can be downloaded at any time, even while a job is running, allowing access to partial results
- Use the account status endpoint to see data range and ongoing jobs without needing job IDs

## Starting the API Server

### Development

```bash
# Build and start the API server
npm run api

# The server will start on port 3000 by default
```

### Production

```bash
# Build the project
npm run build

# Start the API server
PORT=8080 DATA_DIR=/var/data node dist/scripts/api-server.js
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
ENV PORT=3000
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node", "dist/scripts/api-server.js"]
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `3000` |
| `DATA_DIR` | Directory for storing accounts, jobs, and results | `./data` |
| `NEAR_RPC_ENDPOINT` | RPC endpoint URL | `https://archival-rpc.mainnet.fastnear.com` |
| `FASTNEAR_API_KEY` | FastNEAR API key for higher rate limits | None |
| `NEARBLOCKS_API_KEY` | NearBlocks API key for faster transaction discovery | None |
| `RPC_DELAY_MS` | Delay between RPC calls in ms | `50` |

## API Endpoints

### Health Check

**GET /health**

Check if the API server is running.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Account Registration

**POST /api/accounts**

Register a NEAR account for data collection. Registration requires payment verification via a fungible token transfer transaction.

**Payment Requirements:**
- Transfer the required amount (configurable via `REGISTRATION_FEE_AMOUNT`, default: 0.1 ARIZ = 100000) 
- Send to the recipient account (configurable via `REGISTRATION_FEE_RECIPIENT`, default: arizcredits.near)
- Use the specified FT contract (configurable via `REGISTRATION_FEE_TOKEN`, default: arizcredits.near)
- Transaction must be within the maximum age (configurable via `REGISTRATION_TX_MAX_AGE_MS`, default: 30 days)

**Request Body:**
```json
{
  "transactionHash": "BfcxWzpQbvPzPXp438EpqpfcLZ1vHW36YoetCBac3WEA"
}
```

**Response (201 Created):**
```json
{
  "message": "Account registered successfully",
  "account": {
    "accountId": "sender.near",
    "registeredAt": "2024-01-01T00:00:00.000Z"
  }
}
```

Note: The account ID is automatically extracted from the payment transaction sender.

**Response (200 OK - Already Registered):**
```json
{
  "message": "Account already registered",
  "account": {
    "accountId": "sender.near",
    "registeredAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Missing transaction hash, payment verification failed, or transaction issues
  - Example: `{ "error": "Payment verification failed", "details": "Insufficient amount. Required: 100000, Got: 100" }`
  - Example: `{ "error": "Payment verification failed", "details": "Transaction is too old" }`
  - Example: `{ "error": "Payment verification failed", "details": "Incorrect recipient" }`
- `500 Internal Server Error` - Failed to verify payment transaction

**Environment Variables for Payment Configuration:**
- `REGISTRATION_FEE_AMOUNT` - Required payment amount in FT base units (default: "100000" for 0.1 ARIZ with 6 decimals)
- `REGISTRATION_FEE_RECIPIENT` - Recipient account for payments (default: "arizcredits.near")
- `REGISTRATION_FEE_TOKEN` - FT contract ID (default: "arizcredits.near")
- `REGISTRATION_TX_MAX_AGE_MS` - Maximum age of transaction in milliseconds (default: 30 days)

---

**GET /api/accounts**

List all registered accounts.

**Response:**
```json
{
  "accounts": [
    {
      "accountId": "myaccount.near",
      "registeredAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

---

**GET /api/accounts/:accountId/status**

Get the data collection status for a specific account, including the data range and any ongoing jobs.

**Response:**
```json
{
  "accountId": "myaccount.near",
  "hasData": true,
  "dataRange": {
    "firstBlock": 120000000,
    "lastBlock": 121000000,
    "totalTransactions": 150,
    "updatedAt": "2024-01-01T00:05:00.000Z"
  },
  "ongoingJob": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "running",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "startedAt": "2024-01-01T00:00:05.000Z",
    "options": {
      "direction": "backward",
      "maxTransactions": 100
    }
  }
}
```

**Response (no data yet):**
```json
{
  "accountId": "myaccount.near",
  "hasData": false,
  "dataRange": null,
  "ongoingJob": null
}
```

**Error Responses:**
- `400 Bad Request` - Missing accountId
- `404 Not Found` - Account not registered

### Job Management

**POST /api/jobs**

Create a new data collection job for a registered account.

**Request Body:**
```json
{
  "accountId": "myaccount.near",
  "options": {
    "direction": "backward",
    "maxTransactions": 100,
    "startBlock": 120000000,
    "endBlock": 121000000
  }
}
```

**Parameters:**
- `accountId` (required): The NEAR account ID to collect data for
- `options` (optional):
  - `direction`: "backward" or "forward" (default: "backward")
  - `maxTransactions`: Maximum number of transactions to fetch (default: 100)
  - `startBlock`: Starting block height (optional)
  - `endBlock`: Ending block height (optional)

**Response (201 Created):**
```json
{
  "message": "Job created successfully",
  "job": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "accountId": "myaccount.near",
    "status": "pending",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "options": {
      "direction": "backward",
      "maxTransactions": 100
    }
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid options or missing accountId
- `403 Forbidden` - Account not registered
- `409 Conflict` - A job is already running for this account

---

**GET /api/jobs**

List all jobs, optionally filtered by account ID.

**Query Parameters:**
- `accountId` (optional): Filter jobs by account ID

**Example:**
```
GET /api/jobs?accountId=myaccount.near
```

**Response:**
```json
{
  "jobs": [
    {
      "jobId": "550e8400-e29b-41d4-a716-446655440000",
      "accountId": "myaccount.near",
      "status": "completed",
      "createdAt": "2024-01-01T00:00:00.000Z",
      "startedAt": "2024-01-01T00:00:05.000Z",
      "completedAt": "2024-01-01T00:05:00.000Z",
      "options": {
        "direction": "backward",
        "maxTransactions": 100
      }
    }
  ]
}
```

---

**GET /api/jobs/:jobId**

Get the status of a specific job.

**Response:**
```json
{
  "job": {
    "jobId": "550e8400-e29b-41d4-a716-446655440000",
    "accountId": "myaccount.near",
    "status": "running",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "startedAt": "2024-01-01T00:00:05.000Z",
    "options": {
      "direction": "backward",
      "maxTransactions": 100
    }
  }
}
```

**Job Status Values:**
- `pending` - Job is queued and waiting to start
- `running` - Job is currently executing
- `completed` - Job has finished successfully
- `failed` - Job encountered an error

**Error Responses:**
- `404 Not Found` - Job ID does not exist

### Data Download

**GET /api/accounts/:accountId/download/json**

Download the collected data as JSON for the specified account.

**Note:** Data can be downloaded at any time, even while a job is running. This allows access to partial results as they are collected.

**Response:**
- Content-Type: `application/json`
- Content-Disposition: `attachment; filename="myaccount.near.json"`
- Body: JSON file with account history

**Error Responses:**
- `400 Bad Request` - Missing accountId
- `404 Not Found` - Account not registered or no data file exists for this account yet

---

**GET /api/accounts/:accountId/download/csv**

Download the collected data as CSV for the specified account.

**Note:** 
- Data can be downloaded at any time, even while a job is running
- CSV is generated on-demand from the JSON file
- If the JSON file has been updated since the last CSV generation, a fresh CSV will be created

**Response:**
- Content-Type: `text/csv`
- Content-Disposition: `attachment; filename="myaccount.near.csv"`
- Body: CSV file with transaction history

**CSV Columns:**
- `change_block_height` - Block where balance change occurred
- `timestamp` - ISO 8601 timestamp
- `counterparty` - Other account involved
- `direction` - "in" or "out"
- `token_symbol` - Human-readable token symbol
- `amount_whole_units` - Amount in whole units
- `balance_whole_units` - Balance after transaction
- `asset` - Token contract ID
- `amount_raw` - Amount in base units
- `token_balance_raw` - Balance in base units
- `transaction_hash` - Transaction hash
- `receipt_id` - Receipt ID

**Error Responses:**
- `400 Bad Request` - Missing accountId
- `404 Not Found` - Account not registered or no data file exists for this account yet
- `500 Internal Server Error` - Error converting to CSV

## Usage Examples

### cURL

```bash
# Register an account (provide transaction hash of FT payment)
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"transactionHash": "YOUR_PAYMENT_TX_HASH_HERE"}'

# Create a job (account ID is extracted from payment transaction)
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "youraccountid.near",
    "options": {
      "maxTransactions": 50,
      "direction": "backward"
    }
  }'

# Check account status and data range
curl http://localhost:3000/api/accounts/myaccount.near/status

# Check job status (replace with actual job ID)
curl http://localhost:3000/api/jobs/550e8400-e29b-41d4-a716-446655440000

# Download JSON result
curl -O -J http://localhost:3000/api/accounts/myaccount.near/download/json

# Download CSV result
curl -O -J http://localhost:3000/api/accounts/myaccount.near/download/csv
```

### JavaScript/TypeScript

```javascript
// Register an account (provide transaction hash of FT payment)
const registerResponse = await fetch('http://localhost:3000/api/accounts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ transactionHash: 'YOUR_PAYMENT_TX_HASH_HERE' })
});
const registration = await registerResponse.json();
const accountId = registration.account.accountId; // Extracted from payment transaction

// Create a job
const jobResponse = await fetch('http://localhost:3000/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    accountId: accountId,
    options: {
      maxTransactions: 50,
      direction: 'backward'
    }
  })
});
const { job } = await jobResponse.json();
const accountId = job.accountId;

// Check account status
const statusResponse = await fetch(`http://localhost:3000/api/accounts/${accountId}/status`);
const accountStatus = await statusResponse.json();
console.log('Account status:', accountStatus);

// Download results (can be done anytime, even while job is running)
const jsonResponse = await fetch(`http://localhost:3000/api/accounts/${accountId}/download/json`);
const data = await jsonResponse.json();
console.log('Downloaded data:', data);
```

### Python

```python
import requests
import time

BASE_URL = "http://localhost:3000"

# Register an account (provide transaction hash of FT payment)
response = requests.post(
    f"{BASE_URL}/api/accounts",
    json={"transactionHash": "YOUR_PAYMENT_TX_HASH_HERE"}
)
registration = response.json()
account_id = registration["account"]["accountId"]  # Extracted from payment transaction
print(registration)

# Create a job
response = requests.post(
    f"{BASE_URL}/api/jobs",
    json={
        "accountId": account_id,
        "options": {
            "maxTransactions": 50,
            "direction": "backward"
        }
    }
)

# Check account status
response = requests.get(f"{BASE_URL}/api/accounts/{account_id}/status")
account_status = response.json()
print(f"Account status: {account_status}")

# Download CSV (can be done anytime, even while job is running)
response = requests.get(f"{BASE_URL}/api/accounts/{account_id}/download/csv")
with open("output.csv", "wb") as f:
    f.write(response.content)
print("Downloaded CSV to output.csv")
```

## Data Persistence

The API server stores all data in the directory specified by `DATA_DIR`:

- `accounts.json` - Registered accounts
- `jobs.json` - Job metadata and status
- `<accountId>.json` - Account transaction data (one file per account)
- `<accountId>.csv` - Account data as CSV (generated on-demand from JSON)

**Key Points:**
- Each account has a single JSON file that all jobs for that account write to
- Jobs append or continue from the existing account file
- CSV files are regenerated if the JSON file has been updated since the last CSV generation
- Only one job can run per account at a time to prevent data conflicts
- Data can be downloaded at any time, even while jobs are running

**Important:** Always mount a persistent volume for the `DATA_DIR` in production to ensure data survives server restarts.

## Error Handling

All errors follow a consistent format:

```json
{
  "error": "Description of the error",
  "details": "Additional details (when applicable)"
}
```

Common HTTP status codes:
- `200 OK` - Successful GET request
- `201 Created` - Successfully created resource
- `400 Bad Request` - Invalid input
- `403 Forbidden` - Action not allowed
- `404 Not Found` - Resource not found
- `409 Conflict` - Resource conflict (e.g., job already running for account)
- `500 Internal Server Error` - Server error

## Testing

```bash
# Run all tests including API tests
npm test

# Note: API tests will start a test server on port 3001
```

## Security Considerations

1. **Account Registration**: The API requires explicit account registration to prevent arbitrary data collection.

2. **Rate Limiting**: **Important for production** - Add rate limiting middleware to prevent abuse:
   ```javascript
   import rateLimit from 'express-rate-limit';
   
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 minutes
     max: 100 // limit each IP to 100 requests per windowMs
   });
   
   app.use('/api/', limiter);
   ```

3. **Authentication**: For production use, add authentication middleware to protect endpoints:
   ```javascript
   import jwt from 'jsonwebtoken';
   
   function authenticateToken(req, res, next) {
     const token = req.headers['authorization'];
     // Verify token...
     next();
   }
   
   app.use('/api/', authenticateToken);
   ```

4. **HTTPS**: Always use HTTPS in production to protect data in transit. Configure a reverse proxy (nginx, Caddy) with TLS certificates.

5. **Input Validation**: All inputs are validated to prevent injection attacks. The validation helper ensures NEAR account ID format compliance.

6. **File Access**: Job outputs are isolated by UUID to prevent unauthorized access. Consider adding user-to-job ownership checks.

7. **CORS**: Configure CORS based on your frontend requirements:
   ```javascript
   import cors from 'cors';
   
   app.use(cors({
     origin: 'https://your-frontend-domain.com'
   }));
   ```

8. **Environment Variables**: Never commit sensitive API keys or secrets. Use `.env` files (gitignored) or secure secret management.

## Monitoring

Monitor the API server using:

1. **Health Check Endpoint**: Regular polls to `/health`
2. **Logs**: stdout/stderr for job progress and errors
3. **Data Directory**: Monitor disk usage in `DATA_DIR`
4. **Job Status**: Track failed jobs for investigation
5. **Rate Limiting**: Monitor blocked requests if rate limiting is enabled

## Deployment

### Fly.io Deployment

Fly.io provides a simple platform for deploying the API server with persistent storage.

#### Prerequisites

1. Install the Fly.io CLI: https://fly.io/docs/hands-on/install-flyctl/
2. Sign up for a Fly.io account: `fly auth signup` or `fly auth login`

#### Initial Deployment

1. **Launch the app** (first time only):
   ```bash
   fly launch --no-deploy
   ```
   This will use the existing `fly.toml` configuration.

2. **Create a persistent volume** for data storage:
   ```bash
   fly volumes create accounting_data --size 1
   ```
   Note: The volume name `accounting_data` must match the `source` in `fly.toml`.

3. **Set secrets** for API keys:
   ```bash
   fly secrets set FASTNEAR_API_KEY=your_fastnear_api_key_here
   fly secrets set NEARBLOCKS_API_KEY=your_nearblocks_api_key_here
   ```

4. **Deploy the application**:
   ```bash
   fly deploy
   ```

#### Accessing Your Deployment

After deployment, your API will be available at:
```
https://near-accounting-export.fly.dev
```

Check the health endpoint:
```bash
curl https://near-accounting-export.fly.dev/health
```

#### Updating the Deployment

To deploy changes:
```bash
# Build locally first
npm run build

# Deploy to Fly.io
fly deploy
```

#### Viewing Logs

Monitor your application logs:
```bash
fly logs
```

#### Scaling

To increase resources (if needed):
```bash
# Scale memory
fly scale memory 1024

# Scale to multiple machines (not recommended due to in-memory job tracking)
fly scale count 2
```

**Important Limitation**: The current implementation uses in-memory tracking for running jobs (`runningJobs` Map). This means:
- Only run a single instance (`fly scale count 1`)
- Running multiple instances will cause jobs to be tracked separately per instance
- For multi-instance deployments, consider implementing Redis or database-backed job tracking

#### Volume Management

View volumes:
```bash
fly volumes list
```

Extend volume size:
```bash
fly volumes extend <volume_id> --size 2
```

#### Environment Variables

View current secrets:
```bash
fly secrets list
```

Update a secret:
```bash
fly secrets set NEAR_RPC_ENDPOINT=https://your-custom-rpc.com
```

#### SSH Access

Access your running instance:
```bash
fly ssh console
```

View data directory:
```bash
fly ssh console -C "ls -la /data"
```

#### Cost Estimation

With the current `fly.toml` configuration:
- **VM**: shared-cpu-1x with 512MB RAM (~$2-3/month)
- **Volume**: 1GB persistent storage (~$0.15/month)
- **Total**: ~$2-4/month for a single instance

### Using Docker Compose

```yaml
version: '3.8'
services:
  api:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/data
    environment:
      - PORT=3000
      - DATA_DIR=/data
      - NEAR_RPC_ENDPOINT=https://archival-rpc.mainnet.fastnear.com
      - FASTNEAR_API_KEY=${FASTNEAR_API_KEY}
      - NEARBLOCKS_API_KEY=${NEARBLOCKS_API_KEY}
    restart: unless-stopped
```

**Environment Setup:**

```bash
# Create data directory
mkdir -p /var/data/near-accounting

# Set appropriate permissions
chmod 700 /var/data/near-accounting

# Start the service
docker-compose up -d
```

## Support

For issues or questions:
- GitHub Issues: https://github.com/petersalomonsen/near-accounting-export/issues
- Documentation: See README.md in the repository
