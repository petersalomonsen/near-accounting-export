# Balance Discovery and Tracking Flow

This document describes the complete process of discovering and tracking balance changes for a NEAR account.

## Architecture Principles

1. **RPC binary search is the foundation** - The system must work with RPC alone
2. **APIs are optional helpers** - They hint at blocks to check, but are not required
3. **Balance changes drive discovery** - We find blocks where balances changed
4. **Snapshots are the core data structure** - Not "transactions", but balance snapshots at specific blocks

## Terminology

- **Balance Change Record**: The main data - a block where a token balance changed
- **Helper Snapshot**: Optional - a cached balance state to avoid re-querying or mark reference points
- **Gap**: When record[N].balance_after ≠ record[N+1].balance_before for the same token

---

## Output Record Format

Each record represents a single token balance change - the core data for accounting:

```
{
  // Block context
  block_height: number,
  block_timestamp: string,          // ISO 8601 date string

  // Transaction context (where the transaction originated)
  tx_hash: string,
  tx_block: number,                 // Block where tx was signed (may differ from receipt block)
  signer_id: string,
  receiver_id: string,

  // Token and transfer data
  token_id: string,                 // "near" | FT contract | MT token ID | staking pool
  receipt_id: string,
  counterparty: string,             // Who sent or received the token
  amount: string,                   // Change amount (positive = in, negative = out)
  balance_before: string,           // Token balance before this block
  balance_after: string             // Token balance after this block
}
```

### Token ID Format

- **NEAR**: `"near"`
- **Fungible Token**: contract address, e.g. `"usdc.near"`, `"wrap.near"`
- **Intents Token**: full token ID, e.g. `"nep141:wrap.near"`, `"nep141:eth.omft.near"`
- **Staking Pool**: pool address, e.g. `"astro-stakers.poolv1.near"`

### Example Records

**NEAR transfer:**
```json
{
  "block_height": 182347200,
  "block_timestamp": "2024-01-15T12:00:00.000Z",
  "tx_hash": "ABC123...",
  "tx_block": 182347199,
  "signer_id": "alice.near",
  "receiver_id": "bob.near",
  "token_id": "near",
  "receipt_id": "DEF456...",
  "counterparty": "bob.near",
  "amount": "-1000000000000000000000000",
  "balance_before": "5000000000000000000000000",
  "balance_after": "4000000000000000000000000"
}
```

**Staking reward:**
```json
{
  "block_height": 182347200,
  "block_timestamp": "2024-01-15T12:00:00.000Z",
  "tx_hash": null,
  "tx_block": null,
  "signer_id": null,
  "receiver_id": null,
  "token_id": "astro-stakers.poolv1.near",
  "receipt_id": null,
  "counterparty": "astro-stakers.poolv1.near",
  "amount": "1000000000000000000000",
  "balance_before": "100000000000000000000000000",
  "balance_after": "100001000000000000000000000"
}
```

### Benefits of This Format

1. **Flat structure** - Easy to export to CSV, SQL, spreadsheets
2. **One row per change** - No nested objects to parse
3. **Complete context** - All info needed for accounting in one record
4. **Token-agnostic** - Same format for NEAR, FT, MT, staking

## Overview

The system tracks four types of balances:
1. **NEAR** - Native token balance
2. **Fungible Tokens (FT)** - NEP-141 tokens like USDC, wNEAR
3. **Intents Tokens (MT)** - Multi-tokens via intents.near (NEP-245)
4. **Staking Pools** - Delegated stake balances

### Token Discovery Summary

**Key principle:** Tokens are discovered by parsing receipt logs during block processing, NOT by looking at existing records.

| Token Type | Discovery Method | Identification |
|------------|------------------|----------------|
| NEAR | Always tracked | Native token - no discovery needed |
| FT (NEP-141) | `EVENT_JSON` logs with `standard:"nep141"` | `receiver_id` of receipt containing `ft_transfer` event |
| MT/Intents (NEP-245) | `EVENT_JSON` logs with `standard:"nep245"` | `token_ids` field in `mt_transfer` event data |
| Staking Pools | Method names in transaction actions | `receiver_id` when method is `deposit_and_stake`, `unstake`, etc. |

**When discovery happens:**
- During `findBalanceChangingTransaction()` which parses all receipts
- `parseFtTransferEvents()` extracts FT contracts from receipt logs
- `parseMtTransferEvents()` extracts MT token IDs from receipt logs
- `extractTokensFromTransfers()` collects discovered token IDs
- `enrichBalancesWithDiscoveredTokens()` queries balances for new tokens

## Current Flow

### Phase 1: NEAR Balance Discovery (Foundation - RPC Only)

The core mechanism uses binary search on NEAR balance changes:

```
Start with current block and current NEAR balance
    ↓
Binary search backwards:
    - Compare balance at block X vs block X-1
    - If different → balance changed at block X
    - Record block X as a transaction entry
    ↓
Continue until account creation (balance goes to 0)
```

**Key function:** `findLatestBalanceChangingBlock()` in balance-tracker.ts

This works **without any APIs** - purely RPC queries.

### Phase 2: API Hints (Optional Optimization)

APIs can provide hints about which blocks to check, making discovery faster:

```
Query NearBlocks API → list of blocks with transactions
Query Intents Explorer API → list of blocks with intent transfers
Query Pikespeak API → list of blocks with FT/staking events
    ↓
Use these as "hints" - blocks to prioritize checking
    ↓
Still verify with RPC that balance actually changed
```

**Key function:** `fetchTransactionBlocksFromAPIs()` in get-account-history.ts

**Important:** If APIs are unavailable, the system falls back to pure binary search.

### Phase 3: Balance Snapshot Creation

For each transaction block, create balance snapshots:

```
For block N:
    ↓
Query NEAR balance at block N-1 (balanceBefore.near)
Query NEAR balance at block N (balanceAfter.near)
    ↓
Query FT/MT balances at block N (balanceBefore.fungibleTokens, intentsTokens)
Query FT/MT balances at block N+1 (balanceAfter.fungibleTokens, intentsTokens)
    ↓
Note: FT/MT balances update at N+1 due to cross-contract call mechanics
```

**Key function:** `getBalanceChangesAtBlock()` in balance-tracker.ts

### Phase 4: Token Discovery from Transfers

After getting transaction details, discover which tokens were involved:

```
Parse transaction receipts and event logs
    ↓
Extract FT transfers → discover FT contract addresses
Extract MT transfers → discover intents token IDs
Extract staking operations → discover staking pool addresses
    ↓
Store discovered tokens for enrichment
```

**Key function:** `findBalanceChangingTransaction()` in balance-tracker.ts

#### How FT Contracts Are Identified

Fungible tokens are discovered by parsing `EVENT_JSON` logs in receipt outcomes:

```
For each receipt in transaction:
    ↓
For each log entry:
    ↓
If log starts with "EVENT_JSON:":
    → Parse the JSON payload
    → Check if standard === "nep141" and event === "ft_transfer"
    ↓
If ft_transfer found:
    → The FT contract address is the receipt's receiver_id
    → This is because ft_transfer events are emitted by the FT contract itself
```

**Key function:** `parseFtTransferEvents()` in balance-tracker.ts

Example receipt structure:
```json
{
  "receipt_id": "ABC123...",
  "receiver_id": "usdc.near",     // ← This is the FT contract
  "outcome": {
    "logs": [
      "EVENT_JSON:{\"standard\":\"nep141\",\"event\":\"ft_transfer\",\"data\":[{\"old_owner_id\":\"alice.near\",\"new_owner_id\":\"bob.near\",\"amount\":\"1000000\"}]}"
    ]
  }
}
```

The `receiver_id` of the receipt containing the ft_transfer event IS the FT contract address.

#### How Intents/MT Tokens Are Identified

Multi-tokens (NEP-245) are discovered similarly:

```
For each receipt where receiver_id === "intents.near":
    ↓
For each log entry:
    ↓
If log starts with "EVENT_JSON:":
    → Parse the JSON payload
    → Check if standard === "nep245" and event === "mt_transfer"
    ↓
If mt_transfer found:
    → Extract token_ids from the transfer data
    → Token IDs have format like "nep141:wrap.near", "nep141:eth.omft.near"
```

**Key function:** `parseMtTransferEvents()` in balance-tracker.ts

#### How Staking Pools Are Identified

Staking operations are detected by method names:

```
For each action in transaction:
    ↓
If method is deposit_and_stake, unstake, unstake_all, withdraw, withdraw_all:
    → The receiver_id is a staking pool
    → Add to known staking pools list
```

#### Important: No Proactive Token Tracking from Existing Records

**Current behavior:** The system does NOT look at existing records to determine which tokens to track. Token discovery happens **only during block processing** by parsing receipt logs.

This means:
1. If a sync cycle processes block N, it only discovers tokens that appear in receipts at that block
2. There is no "collect all known tokens from records and query them" step
3. `getUniqueTokenIds()` exists in balance-tracker.ts but is NOT used during sync cycles
4. Known tokens grow incrementally as blocks are processed

**Implication:** If a token was held at block N but no transfer occurred, the system won't query that token's balance at block N unless:
- The token was already discovered from a previous/later block's receipts
- The `enrichBalancesWithDiscoveredTokens()` step includes it from transfer parsing

This is by design - we track balance **changes**, not static holdings at arbitrary blocks

### Phase 5: Balance Enrichment

Re-query balances for discovered tokens:

```
For each discovered FT token not in snapshot:
    Query balance at block N → add to balanceBefore.fungibleTokens
    Query balance at block N+1 → add to balanceAfter.fungibleTokens
    ↓
For each discovered intents token not in snapshot:
    Query balance at block N → add to balanceBefore.intentsTokens
    Query balance at block N+1 → add to balanceAfter.intentsTokens
    ↓
For each discovered staking pool:
    Query balance at block N → add to balanceBefore.stakingPools
    Query balance at block N+1 → add to balanceAfter.stakingPools
```

**Key functions:**
- `enrichBalanceSnapshot()` in balance-tracker.ts
- `enrichBalancesWithDiscoveredTokens()` in get-account-history.ts
- `enrichWithStakingPoolBalances()` in get-account-history.ts

### Phase 6: Auto-Discovery of Intents Tokens

When `intentsTokens` parameter is `undefined`, the system auto-discovers:

```
Call intents.near.mt_tokens_for_owner(account_id) at block N
    ↓
Returns list of token IDs the account owns at that block
    ↓
Query balances for all discovered tokens
```

**Problem:** This is called INDEPENDENTLY for block N and block N+1, potentially returning different token sets.

**Key function:** `getIntentsBalances()` in balance-tracker.ts (lines 173-239)

### Phase 7: Normalization (NEW)

After all enrichment, normalize snapshots:

```
Collect all token keys from balanceBefore and balanceAfter
    ↓
For any key missing from balanceBefore, add with value '0'
For any key missing from balanceAfter, add with value '0'
    ↓
Both snapshots now have identical keys
```

**Key function:** `normalizeBalanceSnapshots()` in balance-tracker.ts

---

## Problems with Current Approach

### Problem 1: Independent Token Discovery

The `getIntentsBalances()` function discovers tokens at each block independently:

```typescript
// At block N
const tokensBefore = await mt_tokens_for_owner(account, blockN);
// At block N+1
const tokensAfter = await mt_tokens_for_owner(account, blockN+1);
// These may return DIFFERENT sets!
```

**Result:** `balanceBefore` and `balanceAfter` can have different token keys.

### Problem 2: Multiple Enrichment Passes

Enrichment happens at multiple points:
1. Initial creation in `getBalanceChangesAtBlock()`
2. After transfer discovery in `enrichBalancesWithDiscoveredTokens()`
3. After staking detection in `enrichWithStakingPoolBalances()`
4. During gap re-enrichment in `reEnrichFungibleTokenBalances()`

Each pass can introduce asymmetry.

### Problem 3: Conditional Queries

Tokens are only queried if discovered in transfers:

```typescript
// Only query tokens found in transfers
const ftTokens = transfers.filter(t => t.type === 'ft').map(t => t.tokenId);
// If a token existed but wasn't transferred, it's not queried
```

### Problem 4: Late Normalization

Normalization happens AFTER enrichment, requiring an extra pass over the data.

---

## Proposed Simplified Flow

### Per-Token Tracking (Correct Approach)

Each token is tracked independently:

```
For each token T in knownTokens:
    ↓
Find all blocks where T's balance changed (binary search)
    ↓
For each change block:
    → Query T's balance_before and balance_after
    → Create one record for that token at that block
    ↓
Result: One record per token per change block
```

We do NOT query all tokens at every block - only the token that changed.

---

## Unified Balance Tracking Model

All balance types (NEAR, FT, MT, Staking) follow the same pattern:

### Core Principle: Binary Search + Gap Detection

```
For any balance type:
    ↓
If balanceBefore[N] ≠ balanceAfter[N-1]:
    → There's a gap
    → Binary search to find the exact block where change occurred
    → Determine cause: transfer, reward, deposit, withdrawal, etc.
```

### Known Token Lists (Growing)

Maintain cumulative lists that grow as we discover tokens:

```
knownFungibleTokens: Set<string>     // FT contract addresses
knownIntentsTokens: Set<string>      // MT token IDs
knownStakingPools: Set<string>       // Staking pool addresses
```

These lists only grow - once a token is known, it stays known.

### Backfilling on Discovery

When a new token is discovered at block N:

```
1. Add token to known list
2. Find first interaction with this token (binary search backwards)
3. Backfill all transactions from first interaction to present
4. Query this token's balance for all affected transactions
```

Example:
```
Block 100: Discover FT "usdc.near" in transfer
    ↓
Binary search: first USDC interaction was at block 50
    ↓
Backfill blocks 50-100 with USDC balances
    ↓
All snapshots in range now include USDC
```

---

## Staking Pools as a Balance Type

Staking pools work exactly like tokens:

### Discovery
```
Parse receipts for staking operations:
    - deposit_and_stake → add pool to knownStakingPools
    - unstake, withdraw → add pool to knownStakingPools
```

### Gap Detection
```
For each staking pool in knownStakingPools:
    ↓
Compare consecutive staking records:
    If record[N].balanceBefore ≠ record[N-1].balanceAfter:
        → Gap detected for this pool
        → Binary search to find exact block of change
        → Classify: staking reward, deposit, or withdrawal
```

### Staking Reward Detection
```
Gap found between blocks A and B for pool P:
    ↓
Check for deposits/withdrawals in receipts between A and B:
    - If none found → it's a staking reward
    - If deposit found → it's a deposit
    - If withdrawal found → it's a withdrawal
    ↓
Epoch boundaries are hints (rewards typically occur at epoch changes)
```

### Staking Snapshots as Gap-Filling Tools
```
Staking balance at epoch E provides:
    - Known balance at a specific point in time
    - Reference point to detect gaps
    - If snapshot doesn't match expected, investigate
```

---

## Complete Flow (Simplified)

### Phase 1: Initial NEAR Discovery

```
Binary search NEAR balance from current block to account creation
    ↓
Record all blocks where NEAR changed
    ↓
For each block, parse receipts to discover tokens/pools
    ↓
Add discovered tokens to known lists
```

### Phase 2: Track Each Token Independently

```
For each known token T:
    ↓
Binary search to find all blocks where T's balance changed
    ↓
For each change block N:
    → Query T's balance at block N (before) and N+1 (after)
    → Create one balance change record for T
    ↓
Result: Separate change history per token
```

Each token has its own timeline of balance changes. We don't mix them.

### Phase 3: Gap Detection and Filling

```
For each consecutive pair of records:
    ↓
Compare balanceAfter[N] vs balanceBefore[N+1]:
    ↓
For each balance type (NEAR, each FT, each MT, each pool):
    If mismatch detected:
        → Binary search to find exact change block
        → Add new record at that block
        → Classify the change type
```

### Phase 4: Backfill on New Discovery

```
When new token T discovered at block N:
    ↓
Find first use of T (might be before N if we're processing backwards)
    ↓
For all existing records from first use to present:
    → Query T's balance at each block
    → Add to snapshots
```

---

## Key Insight: Same Token List for Before and After

**Current (broken):**
```typescript
// Query whatever tokens exist at each block independently
const tokensBefore = await discoverTokensAt(blockN);     // might find [A, B]
const tokensAfter = await discoverTokensAt(blockN + 1);  // might find [B, C]
// Result: asymmetric keys
```

**Proposed (correct):**
```typescript
// Use the cumulative known tokens list
const allTokens = knownTokens;  // [A, B, C, ...]

// Query the SAME list for both blocks
const balancesBefore = await queryTokens(blockN, allTokens);
const balancesAfter = await queryTokens(blockN + 1, allTokens);
// Result: symmetric keys by construction
```

---

## Handling Historical Cases (Contract Didn't Exist)

Simple rule: **Don't query before the contract existed.**

```
For each token/pool query at block N:
    ↓
If block N < CONTRACT_CREATION_BLOCK[token]:
    → Skip RPC query
    → Balance is implicitly '0'
    ↓
Else:
    → Query normally
```

Already implemented via `CONTRACT_CREATION_BLOCKS` in balance-tracker.ts:
```typescript
const CONTRACT_CREATION_BLOCKS: Record<string, number> = {
    'intents.near': 148600000,
    'usdc.near': 79039276,
    'usdt.tether-token.near': 91079307,
    'wrap.near': 34550000,
    // ... etc
};
```

This saves RPC queries and avoids errors from querying non-existent contracts.

---

## Performance Considerations

### Batch Queries

- **Intents tokens**: Use `mt_batch_balance_of` - single RPC call for all MT tokens
- **Fungible tokens**: Individual `ft_balance_of` per contract (can parallelize)
- **Staking pools**: Individual `get_account_total_balance` per pool (can parallelize)

### Skip Non-Existent Contracts

Already handled by `CONTRACT_CREATION_BLOCKS` - don't query before contract existed.

### Snapshots as Cache (Dataset-Level)

**Key insight**: Balance at block X never changes. Store queried balances as snapshot records in the dataset.

```
When querying balance at block X:
    ↓
First: Check dataset for existing snapshot at block X
    ↓
If found:
    → Use cached value (no RPC query)
    ↓
If not found:
    → Query RPC
    → Store result as snapshot record in dataset
    → Return value
```

Benefits:
- **Persistence**: Cache survives across sessions
- **Gap detection**: Snapshots help identify where gaps exist
- **Incremental sync**: Only query blocks we haven't seen before

### Helper Snapshots

Optional snapshots that don't represent balance changes, but help the system:

```
Use cases:
    - Cache a queried balance to avoid re-querying
    - Mark epoch boundaries as reference points for staking
    - Narrow down binary search range for future gap detection
```

Helper snapshots are secondary to balance change records - they exist to optimize queries and aid debugging, not as primary data.
