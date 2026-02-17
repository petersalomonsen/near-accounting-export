# Staking Balance Snapshot Bug

## Summary

Periodic staking pool balance snapshots are incorrectly represented in the V2 JSON output. When checking staking balances at epoch boundaries where no actual change occurred (just a periodic snapshot), the API generates records that look like deposits rather than snapshots.

## The Problem

### Current (Incorrect) Output

For a periodic balance check where no actual reward was earned (just recording current state):

```json
{
  "block_height": 161870400,
  "block_timestamp": "2025-08-30T14:29:10.402Z",
  "tx_hash": null,
  "token_id": "astro-stakers.poolv1.near",
  "receipt_id": null,
  "counterparty": "astro-stakers.poolv1.near",
  "amount": "1442848977056627936899944430",
  "balance_before": "0",
  "balance_after": "1442848977056627936899944430"
}
```

This representation suggests that 1442 NEAR was deposited (balance went from 0 to 1442), when in reality it's just a snapshot of existing balance.

### Expected (Correct) Output

For a snapshot where the balance hasn't changed:

```json
{
  "block_height": 161870400,
  "block_timestamp": "2025-08-30T14:29:10.402Z",
  "tx_hash": null,
  "token_id": "astro-stakers.poolv1.near",
  "receipt_id": null,
  "counterparty": "astro-stakers.poolv1.near",
  "amount": "0",
  "balance_before": "1442848977056627936899944430",
  "balance_after": "1442848977056627936899944430"
}
```

## How to Distinguish Record Types

The data should clearly distinguish between:

| Record Type | tx_hash | balance_before | amount | Description |
|-------------|---------|----------------|--------|-------------|
| **Deposit** | Has value | Previous balance | Negative (outgoing NEAR) | User sends NEAR to pool |
| **Withdrawal** | Has value | Previous balance | Positive (incoming NEAR) | User receives NEAR from pool |
| **Reward** | `null` | Previous balance (> 0) | Small positive delta | Epoch staking reward |
| **Snapshot** | `null` | Same as balance_after | `0` | Periodic balance check, no change |

## Impact

Client applications (like Ariz-Portfolio) that consume this API data calculate staking rewards using the formula:

```
earnings = balance_after - balance_before - deposits + withdrawals
```

When `balance_before` is incorrectly `0`, this calculation produces wildly incorrect results:
- Expected staking reward for Aug 30, 2025: ~0.2 NEAR
- Actual displayed reward: ~1000 NEAR (the entire balance difference)

## Test Data

See `petermusic-staking-bug.near.json` in this directory for a real-world example showing the bug.

Key entries to examine:
- Line 15562-15576: Snapshot for `astro-stakers.poolv1.near` with `balance_before: "0"`
- Line 15532-15546: Actual reward entry with correct `balance_before` value

## Root Cause

In `scripts/get-account-history.ts`, the `collectStakingRewards` function creates staking entries at epoch boundaries. When this is the first record for a pool in the sync session, `balance_before` defaults to '0' because there's no prior record to reference.

The fix should:
1. For actual rewards (balance changed): Use proper `balance_before` from previous epoch
2. For snapshots (balance unchanged): Set `amount: "0"` and `balance_before = balance_after`
3. Or simply: Don't create records when the balance hasn't changed from the previous check

## Suggested Fix

In `collectStakingRewards`, before creating a staking balance change entry:

```typescript
// Only create entry if there's an actual balance change
if (prevBalance !== currentBalance) {
    // Create reward entry with proper balance_before
    allChanges.push({
        pool: range.pool,
        block: block,
        startBalance: prevBalance.toString(),  // NOT '0'
        endBalance: currentBalance.toString(),
        diff: (currentBalance - prevBalance).toString()
    });
}
// If balances are equal, don't create a record (it's just a snapshot with no change)
```
