# Balance Tracking

## Orchestration

Every time the fetching job runs it should start by checking the data it has. It can easily understand if the data is complete or not by checking if the balance before one record matches the balance after the previous recorded record for the same token. If this is not the case then there is a gap, and we have to search for data in that gap. First use APIs, then finally binary search as the last resort.

When there are no gaps, the data collection should look for new data from todays date. Start by getting todays balance, which given that there have been transactions, also will mean that there will be a gap from todays balance to the latest recorded block. Go into gap-finding and filling mode as described above.

Then there is the past. We go to the earliest recorded block, and find that it has balance - which means it is a gap to the account was created - back where the balance was zero. The data collection needs to use the approach above to start filling gaps back in time.

## Organizing the code

The orchestration of the process, should be expressed in a simple source file that calls into the gap detection and filling logic. High level orchestration logic

- Detect gaps in existing data (detecting should not need any data fetching, it should be done by analyzing the balances recorded before and after each block)
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
- Find data in the past, detect and fill gaps according to the process above (only search in the block range before the first block of the existing data)

## The dataset

The dataset uses a flat V2 format where each record represents a single token balance change at a specific block. One block may produce multiple records (e.g., a swap that changes both NEAR and an FT balance produces two records).

### File structure

```json
{
  "version": 2,
  "accountId": "example.near",
  "createdAt": "2025-12-22T21:18:36.094Z",
  "updatedAt": "2025-12-23T07:08:41.879Z",
  "metadata": {
    "firstBlock": 139109383,
    "lastBlock": 176950914,
    "totalRecords": 1204,
    "historyComplete": true
  },
  "stakingPools": ["astro-stakers.poolv1.near"],
  "records": [...]
}
```

### BalanceChangeRecord structure

Each entry in the `records` array represents a single token's balance change at a block:

```json
{
  "block_height": 176950914,
  "block_timestamp": "2025-01-15T12:00:00.000Z",
  "tx_hash": "9QCNXa...",
  "tx_block": 176950913,
  "signer_id": "alice.near",
  "receiver_id": "bob.near",
  "predecessor_id": "alice.near",
  "token_id": "near",
  "receipt_id": "DHnhxj...",
  "counterparty": "bob.near",
  "amount": "-123750000000000000000000",
  "balance_before": "26569088627379869499999976",
  "balance_after": "26445338627379869499999976"
}
```

### Token ID format

- **NEAR**: `"near"`
- **Fungible Token**: contract address, e.g. `"wrap.near"`, `"usdt.tether-token.near"`
- **Intents Token**: full token ID, e.g. `"nep141:wrap.near"`, `"nep141:eth.omft.near"`
- **Staking Pool**: pool address, e.g. `"astro-stakers.poolv1.near"`

### Record types

| Type | tx_hash | amount | Description |
|------|---------|--------|-------------|
| Transfer | Has value | Non-zero | NEAR/FT/MT transfer in or out |
| Staking deposit | Has value | Negative NEAR + positive pool | User stakes NEAR |
| Staking withdrawal | Has value | Positive NEAR + negative pool | User unstakes and withdraws |
| Staking reward | `null` | Positive (small delta) | Epoch staking reward |
| Weekly snapshot | `null` | `"0"` | Periodic balance reference point |

### Example records

**NEAR transfer out:**
```json
{
  "block_height": 182347200,
  "block_timestamp": "2025-01-15T12:00:00.000Z",
  "tx_hash": "ABC123...",
  "tx_block": 182347199,
  "signer_id": "alice.near",
  "receiver_id": "bob.near",
  "predecessor_id": "alice.near",
  "token_id": "near",
  "receipt_id": "DEF456...",
  "counterparty": "bob.near",
  "amount": "-1000000000000000000000000",
  "balance_before": "5000000000000000000000000",
  "balance_after": "4000000000000000000000000"
}
```

**Staking reward (no transaction):**
```json
{
  "block_height": 182347200,
  "block_timestamp": "2025-01-15T12:00:00.000Z",
  "tx_hash": null,
  "tx_block": null,
  "signer_id": null,
  "receiver_id": null,
  "predecessor_id": null,
  "token_id": "astro-stakers.poolv1.near",
  "receipt_id": null,
  "counterparty": "astro-stakers.poolv1.near",
  "amount": "1000000000000000000000",
  "balance_before": "100000000000000000000000000",
  "balance_after": "100001000000000000000000000"
}
```

### Benefits of this format

1. **Flat structure** - Easy to export to CSV, SQL, spreadsheets
2. **One row per change** - No nested objects to parse
3. **Complete context** - All info needed for accounting in one record
4. **Token-agnostic** - Same format for NEAR, FT, MT, staking

## Gap detection

A **gap** exists when `balance_after` of record N does not match `balance_before` of record N+1 **for the same `token_id`**.

Gap detection is computed in-memory each time the script runs - it is NOT stored in the dataset. The algorithm:

1. Load records sorted by block height
2. Group records by `token_id`
3. For each token's consecutive record pair (N, N+1):
   - Compare `records[N].balance_after` with `records[N+1].balance_before`
   - If they differ, a gap exists between those blocks for that token
4. Check if the earliest record for each token has a non-zero `balance_before` - gap to first interaction
5. Check if the latest record's `balance_after` differs from current on-chain balance - gap to present

This is a fast O(n) in-memory operation with no I/O required.
