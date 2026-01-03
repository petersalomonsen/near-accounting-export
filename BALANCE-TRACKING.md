BALANCE TRACKING
================

# Orchestration

Every time the fetching job runs it should start by checking the data it has. It can easily understand if the data is complete or not by checking if the balance before one block matches the balance after the previous recorded block. If this is not the case then there is a gap, and we have to search for data in that gap. First use APIs, then finally binary search as the last resort.

When there are no gaps, the data collection should look for new data from todays date. Start by getting todays balance, which given that there have been transactions, also will mean that there will be a gap from todays balance to the latest recorded block. Go into gap-finding and filling mode as described above.

Then there is the past. We go to the earliest recorded block, and find that it has balance - which means it is a gap to the account was created - back where the balance was zero. The data collection needs to use the approach above to start filling gaps back in time.

# Organizing the code

The orchestration of the process, should be expressed in a simple source file that calls into the gap detection and filling logic. High level orchestration logic

- Detect gaps in existing data ( detecting should not need any data fetching, it should be done by analyzing the balances recorded before and after each block )
    - Fetch data for the detected gaps
        - Orchestration of the fetching should be in a separate source file, and each of the fetching methods should have separate source files
            - Pikespeak API
            - NEAR Intents explorer API
            - NEARBlocks API
            - RPC binary search
        - For all fetching methods, parameters for limiting fetching to the specific block ranges must be used
        - All fetching methods should convert and return the final data in the same format as the RPC binary search, so that we have a unified dataset that is independent of fetching method
    - Fill gaps with retrieved data
- Find the latest data, detect and fill gaps according to the process above (only search in the block range after the last block of the existing data)
- Find data in the past, detect and fill gaps according to the process above (only search in the block range before the first block of the existing data )

# The dataset

Even though the dataset is named "transactions" it is still organized per block. Each record in the dataset represents a block which might process part of a transaction. A record points to the block where the transaction starts, it has the hash of the transaction. A record also contains the receipt of the balance change that occured in the recorded block.

## File structure

```json
{
  "accountId": "example.near",
  "createdAt": "2025-12-22T21:18:36.094Z",
  "updatedAt": "2025-12-23T07:08:41.879Z",
  "metadata": {
    "firstBlock": 139109383,      // Earliest block with recorded balance change
    "lastBlock": 176950914,       // Latest block with recorded balance change
    "totalTransactions": 552      // Total number of block records
  },
  "stakingPools": ["astro-stakers.poolv1.near"],  // Discovered staking pools
  "transactions": [...]           // Array of block records (see below)
}
```

## Block record structure

Each entry in the `transactions` array represents a **block** where a balance change occurred:

```json
{
  "block": 176950914,                    // The block where balance changed
  "transactionBlock": 176950914,         // The block where the transaction started
  "timestamp": 1765811984648801000,      // Block timestamp in nanoseconds
  "transactionHashes": ["9QCNXa..."],    // Transaction hash(es) that caused the change
  "transactions": [...],                  // Full transaction details (signerId, receiverId, actions)
  "transfers": [                         // Parsed transfer details
    {
      "type": "near",                    // Type: near, ft, mt, action_receipt_gas_reward
      "direction": "in",                 // Direction: in or out
      "amount": "123750000000000000000000",
      "counterparty": "arizcredits.near",
      "txHash": "9QCNXa...",
      "receiptId": "DHnhxj..."           // The receipt that caused this balance change
    }
  ],
  "balanceBefore": {                     // Balance snapshot BEFORE this block (sparse)
    "near": "26445338627379869499999976",
    "fungibleTokens": {},                // May be empty if no FT changes in this transaction
    "intentsTokens": {},                 // May be empty if no intents changes in this transaction
    "stakingPools": {}                   // May be empty if no staking changes in this transaction
  },
  "balanceAfter": {                      // Balance snapshot AFTER this block (sparse)
    "near": "26569088627379869499999976",
    "fungibleTokens": {},
    "intentsTokens": {},
    "stakingPools": {}
  },
  "changes": {                           // Summary of what changed
    "nearChanged": true,
    "nearDiff": "123750000000000000000000",
    "tokensChanged": {},
    "intentsChanged": {}
  }
}
```

### Sparse Balance Representation

**Important**: `balanceBefore` and `balanceAfter` use **sparse representation** - they only include tokens that **changed** in that transaction.

- **Empty token maps** (`{}`) mean "not queried" NOT "zero balance"
- This prevents unnecessary RPC calls and avoids data loss when RPC queries fail
- Gap detection only compares tokens that appear in BOTH snapshots

**Example**: A NEAR-only transaction (no token transfers):
```json
{
  "balanceBefore": { "near": "1000", "fungibleTokens": {}, "intentsTokens": {} },
  "balanceAfter": { "near": "900", "fungibleTokens": {}, "intentsTokens": {} }
}
```
The empty `fungibleTokens` and `intentsTokens` mean they weren't queried (sparse), NOT that they're zero.

## Gap detection

A **gap** exists when `balanceAfter` of record N does not match `balanceBefore` of record N+1 **for tokens that appear in BOTH snapshots**.

Gap detection is computed in-memory each time the script runs - it is NOT stored in the dataset. The algorithm:

1. Load transactions sorted by block height
2. For each consecutive pair (N, N+1):
   - Compare `transactions[N].balanceAfter` with `transactions[N+1].balanceBefore`
   - **Only compare tokens that appear in BOTH snapshots** (sparse balance handling)
   - If any common token differs → gap exists between the blocks
3. Check if `transactions[first].balanceBefore` has non-zero balances → gap to account creation
4. Check if `transactions[last].balanceAfter` differs from current on-chain balance → gap to present

This is a fast O(n) in-memory operation with no I/O required.