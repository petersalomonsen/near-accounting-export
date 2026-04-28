# NEAR Accounting Export - API Module

This document describes how to use the NEAR Accounting Export module in your Node.js application.

## Overview

The `near-accounting-export` package can be imported as a module to provide NEAR account transaction history tracking in your own application. This is useful when you want to integrate accounting functionality into a larger system, such as the ariz-gateway.

## Installation

```bash
npm install near-accounting-export
# or
npm install github:PeterSalomonsen/near-accounting-export#<commit-sha>
```

## API

The module exports two main functions:

### `createRouter(config: RouterConfig): Router`

Creates an Express Router with all accounting endpoints. The router handles:
- Account data status
- JSON/CSV downloads
- Gap analysis

**Parameters:**

```typescript
interface RouterConfig {
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
```

**Returns:** Express Router instance

**Endpoints:**

- `GET /status` - Get account data collection status
- `GET /download/json` - Download account data as JSON
- `GET /download/csv` - Download account data as CSV
- `GET /gap-analysis` - Get gap analysis report

**Example Usage (in ariz-gateway):**

```typescript
import { createRouter } from 'near-accounting-export';
import express from 'express';

const app = express();

// Your authentication middleware sets req.accountId
app.use(authMiddleware);

// Create the accounting router
const accountingRouter = createRouter({
  getAccountId: (req) => req.accountId, // Read from auth middleware
  dataDir: '/data/accounting'
});

// Mount at /api/accounting
app.use('/api/accounting', accountingRouter);

app.listen(3000);
```

**Example Usage (local development with fixed account):**

```typescript
import { createRouter } from 'near-accounting-export';
import express from 'express';

const app = express();

const router = createRouter({
  getAccountId: () => 'testaccount.near', // Fixed account for testing
  dataDir: './test-data'
});

app.use('/api/accounting', router);
app.listen(3000);
```

### `startWorker(config?: WorkerConfig): Promise<WorkerHandle>`

Starts the background sync worker that continuously updates account data.

**Parameters:**

```typescript
interface WorkerConfig {
  /**
   * Data directory path for storing account data and metadata.
   * Defaults to process.env.DATA_DIR || './data'
   */
  dataDir?: string;
}
```

**Returns:** Promise that resolves to a WorkerHandle

```typescript
interface WorkerHandle {
  /** Stop the background sync worker */
  stop(): Promise<void>;
}
```

**Example Usage:**

```typescript
import { startWorker } from 'near-accounting-export';

// Start the worker
const worker = await startWorker({ dataDir: '/data/accounting' });

// Later, for graceful shutdown:
await worker.stop();
```

## Lazy Enrollment

Accounts are automatically registered on their first API request. There is no need for explicit registration or payment verification. When a request comes in with an authenticated account ID, the system:

1. Validates the account ID format
2. Registers the account in `accounts.json` (if not already registered)
3. Processes the request
4. The background worker picks up the account on its next cycle

This "lazy enrollment" approach eliminates the need for a separate registration endpoint or payment flow.

## Configuration

The module respects these environment variables:

### Sync Configuration

- `BATCH_SIZE` - Number of transactions to fetch per cycle (default: 10)
- `CYCLE_DELAY_MS` - Delay between sync cycles in milliseconds (default: 60000 / 1 minute)
- `MAX_EPOCHS_PER_CYCLE` - Maximum epochs to check per cycle (default: 50)
- `ACCOUNT_TIMEOUT_MS` - Timeout for processing a single account (default: 300000 / 5 minutes)
- `COMPLETE_ACCOUNT_INTERVAL_MS` - Sync interval for complete accounts (default: 28800000 / 8 hours)
- `INCOMPLETE_ACCOUNT_INTERVAL_MS` - Sync interval for incomplete accounts (default: 300000 / 5 minutes)

### RPC Configuration

- `NEAR_RPC_ENDPOINT` - RPC endpoint URL (default: https://archival-rpc.mainnet.fastnear.com)
- `FASTNEAR_API_KEY` - FastNEAR API key for higher rate limits
- `RPC_DELAY_MS` - Delay between RPC calls (default: 50ms)

### API Keys

- `NEARBLOCKS_API_KEY` - NearBlocks API key for transaction discovery
- `INTENTS_EXPLORER_API_KEY` - NEAR Intents Explorer JWT token
- `PIKESPEAK_API_KEY` - Pikespeak API key

### Data Directory

- `DATA_DIR` - Directory for storing account data (default: './data')

## Complete Example

Here's a complete example integrating both the router and worker:

```typescript
import express from 'express';
import { createRouter, startWorker } from 'near-accounting-export';

const app = express();
const PORT = 3000;
const DATA_DIR = '/data/accounting';

// Your auth middleware
app.use((req, res, next) => {
  // Extract account from JWT, session, etc.
  const token = req.headers.authorization?.replace('Bearer ', '');
  const accountId = verifyAndExtractAccount(token);

  if (!accountId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.accountId = accountId;
  next();
});

// Create accounting router
const accountingRouter = createRouter({
  getAccountId: (req) => req.accountId,
  dataDir: DATA_DIR
});

// Mount router
app.use('/api/accounting', accountingRouter);

// Start server
const server = app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Start background worker
  const worker = await startWorker({ dataDir: DATA_DIR });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    server.close(async () => {
      await worker.stop();
      process.exit(0);
    });
  });
});
```

## Standalone Mode

⚠️ **Security Warning:** Standalone mode trusts the `X-Account-Id` header and URL-path account ID — both are unauthenticated. Do not expose standalone mode to the public internet. It's intended for local development or for running behind a trusted gateway (like ariz-gateway) that authenticates the request and injects the account ID.

The package can also run as a standalone server:

```bash
npm run api
# or
node dist/scripts/api-server.js
```

In standalone mode, the server includes CORS support and accepts the account ID from:
1. `X-Account-Id` header
2. URL path (e.g., `/api/accounting/:accountId/status`)

## Architecture

- **Router**: Handles HTTP requests for account data
- **Worker**: Background process that continuously syncs account data
- **Storage**: File-based storage in `DATA_DIR`:
  - `accounts.json` - Registered accounts metadata
  - `{accountId}.json` - Transaction history for each account
  - `{accountId}.csv` - CSV export cache

## Migration from Previous Version

If you were using the payment-gated registration system:

1. The `POST /api/accounts` endpoint has been removed
2. `REGISTRATION_FEE_*` environment variables are no longer used
3. Accounts are now registered automatically on first request
4. Existing `accounts.json` files will continue to work (payment fields are simply ignored)

## TypeScript Support

The module includes TypeScript definitions. Import types as needed:

```typescript
import type { RouterConfig, WorkerConfig, WorkerHandle } from 'near-accounting-export';
```
