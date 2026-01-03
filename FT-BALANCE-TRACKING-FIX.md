# FT Balance Tracking Fix

## Problem

Fungible token (FT) balances were not being tracked in transaction history, even when FT transfers occurred. The issue manifested as:
- FT transfers correctly detected in `transfers[]` array  
- But `fungibleTokens: {}` empty in both `balanceBefore` and `balanceAfter`
- And `tokensChanged: {}` empty in `changes`

Example from `webassemblymusic-treasury.sputnik-dao.near` at block 168568481:
```json
{
  "transfers": [
    {"type": "ft", "amount": "3000000", "tokenId": "arizcredits.near"}
  ],
  "balanceBefore": {"fungibleTokens": {}},
  "balanceAfter": {"fungibleTokens": {}},
  "changes": {"tokensChanged": {}}
}
```

## Root Cause

The binary search discovery flow had a timing issue:

1. **Step 1**: `findLatestBalanceChangingBlock` is called with NO token parameters
   - Queries balance at block-1 and block  
   - Only queries DEFAULT_TOKENS (USDC, wNEAR, USDT)
   - Returns balance snapshots with only DEFAULT_TOKENS

2. **Step 2**: `findBalanceChangingTransaction` is called to get transaction details
   - Parses logs to discover FT transfers
   - Correctly identifies FT contract (e.g., `arizcredits.near`)

3. **Step 3**: Transaction entry is created
   - Uses balance snapshots from Step 1 (which only have DEFAULT_TOKENS)
   - FT transfer is in `transfers[]` but not in balance snapshots
   - **Result**: Mismatch between `transfers[]` and `fungibleTokens`

The problem: Balance snapshots were created BEFORE FT contracts were discovered.

## Solution

After discovering FT transfers, enrich the balance snapshots with those FT contracts:

1. **Find balance change** (as before)
2. **Discover transfers** including FT contracts involved
3. **Enrich balance snapshots** with discovered FT contracts
   - Query FT balances at block-1 and block
   - Merge into existing snapshots
   - Recalculate balance changes
4. **Create transaction entry** with enriched snapshots

### Code Changes

#### 1. New `enrichBalanceSnapshot` function

```typescript
export async function enrichBalanceSnapshot(
    accountId: string,
    blockId: number | string,
    existingSnapshot: BalanceSnapshot,
    additionalFtContracts: string[],
    additionalIntentsTokens: string[]
): Promise<BalanceSnapshot>
```

This function:
- Takes an existing balance snapshot
- Identifies which FT/intents tokens are missing from the snapshot
- Queries only the missing tokens (efficient - no redundant queries)
- Returns enriched snapshot with all tokens

#### 2. Updated `searchForTransactions` 

After finding a balance change:
```typescript
// Find transaction details
const txInfo = await findBalanceChangingTransaction(accountId, balanceChange.block);

// Extract FT and intents tokens from discovered transfers
const discoveredFtTokens: string[] = [];
const discoveredIntentsTokens: string[] = [];

for (const transfer of txInfo.transfers || []) {
    if (transfer.type === 'ft' && transfer.tokenId) {
        discoveredFtTokens.push(transfer.tokenId);
    } else if (transfer.type === 'mt' && transfer.tokenId) {
        discoveredIntentsTokens.push(transfer.tokenId);
    }
}

// Enrich balance snapshots with discovered tokens
if (discoveredFtTokens.length > 0 || discoveredIntentsTokens.length > 0) {
    enrichedBalanceBefore = await enrichBalanceSnapshot(
        accountId,
        balanceChange.block - 1,
        balanceBefore,
        discoveredFtTokens,
        discoveredIntentsTokens
    );
    
    enrichedBalanceAfter = await enrichBalanceSnapshot(
        accountId,
        balanceChange.block,
        balanceAfter,
        discoveredFtTokens,
        discoveredIntentsTokens
    );
    
    // Recalculate changes with enriched balances
    const updatedChanges = detectBalanceChanges(enrichedBalanceBefore, enrichedBalanceAfter);
    balanceChange.tokensChanged = updatedChanges.tokensChanged;
    balanceChange.intentsChanged = updatedChanges.intentsChanged;
}
```

#### 3. Updated `fillGapWithBinarySearch`

Same enrichment logic applied when filling gaps via binary search.

### Benefits

1. **Accurate FT tracking**: All FT contracts involved in transfers are now tracked in balance snapshots
2. **Efficient**: Only queries FT contracts that are missing from snapshots (no redundant queries)
3. **Consistent**: `transfers[]` and `fungibleTokens` now match
4. **Sparse-compatible**: Works with existing sparse balance representation (empty `{}` means "not queried", not "zero")
5. **Backward compatible**: No changes to data format or API

## Testing

### Unit Tests
- `test/unit/balance-enrichment.test.ts`: Tests the enrichment logic
  - Missing token identification
  - Balance change detection with FT changes
  - Multiple token changes in same transaction

### Integration Tests  
- Existing sparse balance tests continue to pass
- All unit tests pass

### Real-world Verification
To verify with real data:
```bash
npm start -- --account webassemblymusic-treasury.sputnik-dao.near --output test.json --max 10
```

Check that FT transfers at block 168568481 now have:
- `fungibleTokens.arizcredits.near` in both `balanceBefore` and `balanceAfter`
- `tokensChanged.arizcredits.near` with correct diff

## Related

- Issue #32: Fix FT balance tracking by querying per contract when transactions occur
- PR #29: Sparse balance representation (merged)
- Issue #28: Original token loss issue (partially fixed by PR #29)
