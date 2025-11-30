# NEAR Accounting Export - Copilot Instructions

## Project Overview

This TypeScript project provides tools to gather NEAR account data history, tracking:
- NEAR token balance changes
- Fungible Token (FT) balance changes
- NEAR Intents multi-token balance changes
- Staking balance changes

The project uses `@near-js/jsonrpc-client` for RPC interactions and is written in TypeScript for type safety.

## Architecture

The project uses a binary search approach to efficiently discover balance changes without scanning every block. The main components are:

### scripts/rpc.ts
RPC helper module for NEAR blockchain interactions using @near-js/jsonrpc-client. Provides:
- `getClient()` - Get/create the NearRpcClient instance
- `viewAccount(accountId, blockId)` - View account state at a specific block
- `callViewFunction(contractId, methodName, args, blockId)` - Call view functions
- `getCurrentBlockHeight()` - Get the current block height
- `fetchBlockData(blockHeight)` - Fetch detailed block data including receipts
- Proper TypeScript types from @near-js/jsonrpc-types

### scripts/balance-tracker.ts
Balance tracking and binary search logic with TypeScript interfaces:
- `getAllBalances(accountId, blockId, tokenContracts, intentsTokens, checkNear)` - Get all balances at a block
- `findLatestBalanceChangingBlock(accountId, firstBlock, lastBlock)` - Binary search for balance changes
- `findBalanceChangingTransaction(targetAccountId, balanceChangeBlock)` - Find the transaction that caused a change
- `getBlockHeightAtDate(date)` - Estimate block height at a specific date
- Exports TypeScript interfaces: BalanceSnapshot, BalanceChanges, TransactionInfo

### scripts/get-account-history.ts
Main CLI script that:
- Loads existing history files to continue from
- Searches forward or backward in time
- Continuously searches through adjacent ranges when no balance changes found
- Stops on: user interrupt (Ctrl+C), rate limit, max transactions, or endpoint errors
- Verifies transaction connectivity (balance changes match between adjacent transactions)
- Saves progress continuously (every 5 transactions and when moving to new ranges)
- Fully typed with TypeScript interfaces for all data structures

## Building and Testing

The project is written in TypeScript and must be compiled before running:

```bash
# Build TypeScript to JavaScript
npm run build

# Run the compiled script
npm start

# Run tests (tests will be auto-compiled)
npm test

# For development with auto-reload
npm run dev
```

Built files are output to the `dist/` directory.

## Environment Variables

- `NEAR_RPC_ENDPOINT` - RPC endpoint URL (default: https://archival-rpc.mainnet.fastnear.com)
  - **Note**: The old rpc.mainnet.near.org endpoint is deprecated and returns error -429. Use fastnear.com or alternative providers from https://docs.near.org/api/rpc/providers
- `FASTNEAR_API_KEY` - FastNEAR API key for higher rate limits (optional). When set, adds `Authorization: Bearer <key>` header to all RPC requests
- `RPC_DELAY_MS` - Delay between RPC calls in milliseconds (default: 50)

## Key Conventions

1. **Balance Verification**: Always verify that transactions are connected by checking that the balance after one transaction matches the balance before the next.

2. **Binary Search**: Use binary search to find balance-changing blocks efficiently instead of scanning every block.

3. **Continuous Search**: When no balance changes are found in a range, automatically move to the adjacent range of equal size and continue searching until interrupted, rate limited, or endpoint becomes unresponsive.

4. **Error Handling**: Handle rate limiting and endpoint errors gracefully with a stop signal mechanism. Always save progress before stopping.

5. **Progress Saving**: Save progress continuously - every 5 transactions and when moving to new search ranges - to ensure no data is lost on interruption.

6. **BigInt for Balances**: Always use BigInt when comparing or calculating balance differences to avoid precision issues.

## Docker Usage

The script is designed to run in Docker containers for scheduled jobs:

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY scripts/ ./scripts/
ENTRYPOINT ["node", "scripts/get-account-history.js"]
```

Run with:
```bash
docker run -v $(pwd)/data:/data near-accounting-export \
  --account myaccount.near \
  --output /data/myaccount.json \
  --max 50
```

## Contributing

When adding new features:
1. Follow the existing module pattern (ES modules with named exports)
2. Add appropriate tests
3. Handle the stop signal for graceful cancellation
4. Update this documentation if adding new functionality
