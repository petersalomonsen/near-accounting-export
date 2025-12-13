# API Server Documentation

## Overview

The API server provides REST endpoints for managing NEAR account data collection jobs, including account registration, job creation, status tracking, and data downloads in JSON and CSV formats.

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

Register a NEAR account for data collection. Only registered accounts can have data collection jobs created.

**Request Body:**
```json
{
  "accountId": "myaccount.near"
}
```

**Response (201 Created):**
```json
{
  "message": "Account registered successfully",
  "account": {
    "accountId": "myaccount.near",
    "registeredAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Response (200 OK - Already Registered):**
```json
{
  "message": "Account already registered",
  "account": {
    "accountId": "myaccount.near",
    "registeredAt": "2024-01-01T00:00:00.000Z"
  }
}
```

**Error Responses:**
- `400 Bad Request` - Invalid account ID format or missing accountId
- Example: `{ "error": "Invalid NEAR account ID format" }`

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

**GET /api/jobs/:jobId/download/json**

Download the collected data as JSON.

**Response:**
- Content-Type: `application/json`
- Content-Disposition: `attachment; filename="myaccount.near-<jobId>.json"`
- Body: JSON file with account history

**Error Responses:**
- `400 Bad Request` - Job is not completed
- `404 Not Found` - Job or output file not found

---

**GET /api/jobs/:jobId/download/csv**

Download the collected data as CSV.

**Response:**
- Content-Type: `text/csv`
- Content-Disposition: `attachment; filename="myaccount.near-<jobId>.csv"`
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
- `400 Bad Request` - Job is not completed
- `404 Not Found` - Job not found
- `500 Internal Server Error` - Error converting to CSV

## Usage Examples

### cURL

```bash
# Register an account
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"accountId": "myaccount.near"}'

# Create a job
curl -X POST http://localhost:3000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "myaccount.near",
    "options": {
      "maxTransactions": 50,
      "direction": "backward"
    }
  }'

# Check job status (replace with actual job ID)
curl http://localhost:3000/api/jobs/550e8400-e29b-41d4-a716-446655440000

# Download JSON result
curl -O -J http://localhost:3000/api/jobs/550e8400-e29b-41d4-a716-446655440000/download/json

# Download CSV result
curl -O -J http://localhost:3000/api/jobs/550e8400-e29b-41d4-a716-446655440000/download/csv
```

### JavaScript/TypeScript

```javascript
// Register an account
const registerResponse = await fetch('http://localhost:3000/api/accounts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ accountId: 'myaccount.near' })
});
const registration = await registerResponse.json();

// Create a job
const jobResponse = await fetch('http://localhost:3000/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    accountId: 'myaccount.near',
    options: {
      maxTransactions: 50,
      direction: 'backward'
    }
  })
});
const { job } = await jobResponse.json();
const jobId = job.jobId;

// Poll for completion
let status = 'pending';
while (status === 'pending' || status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  const statusResponse = await fetch(`http://localhost:3000/api/jobs/${jobId}`);
  const { job: currentJob } = await statusResponse.json();
  status = currentJob.status;
  
  console.log(`Job status: ${status}`);
}

// Download results
if (status === 'completed') {
  const jsonResponse = await fetch(`http://localhost:3000/api/jobs/${jobId}/download/json`);
  const data = await jsonResponse.json();
  console.log('Downloaded data:', data);
}
```

### Python

```python
import requests
import time

BASE_URL = "http://localhost:3000"

# Register an account
response = requests.post(
    f"{BASE_URL}/api/accounts",
    json={"accountId": "myaccount.near"}
)
print(response.json())

# Create a job
response = requests.post(
    f"{BASE_URL}/api/jobs",
    json={
        "accountId": "myaccount.near",
        "options": {
            "maxTransactions": 50,
            "direction": "backward"
        }
    }
)
job_id = response.json()["job"]["jobId"]

# Poll for completion
while True:
    response = requests.get(f"{BASE_URL}/api/jobs/{job_id}")
    status = response.json()["job"]["status"]
    print(f"Job status: {status}")
    
    if status in ["completed", "failed"]:
        break
    
    time.sleep(5)

# Download CSV
if status == "completed":
    response = requests.get(f"{BASE_URL}/api/jobs/{job_id}/download/csv")
    with open("output.csv", "wb") as f:
        f.write(response.content)
    print("Downloaded CSV to output.csv")
```

## Data Persistence

The API server stores all data in the directory specified by `DATA_DIR`:

- `accounts.json` - Registered accounts
- `jobs.json` - Job metadata and status
- `job-<jobId>.json` - Job output data
- `job-<jobId>.csv` - Job output as CSV (generated on first download)

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

## Support

For issues or questions:
- GitHub Issues: https://github.com/petersalomonsen/near-accounting-export/issues
- Documentation: See README.md in the repository

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

### Environment Setup

```bash
# Create data directory
mkdir -p /var/data/near-accounting

# Set appropriate permissions
chmod 700 /var/data/near-accounting

# Start the service
docker-compose up -d
```

## Monitoring

Monitor the API server using:

1. **Health Check Endpoint**: Regular polls to `/health`
2. **Logs**: stdout/stderr for job progress and errors
3. **Data Directory**: Monitor disk usage in `DATA_DIR`

## Support

For issues or questions:
- GitHub Issues: https://github.com/petersalomonsen/near-accounting-export/issues
- Documentation: See README.md in the repository
