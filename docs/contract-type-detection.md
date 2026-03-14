# Contract Type Detection via WASM Export Inspection

## Problem

Contract type detection is currently based on account name patterns:

```typescript
const STAKING_POOL_PATTERNS = [
    /\.poolv1\.near$/,
    /\.pool\.near$/,
    /\.poolv2\.near$/
];
```

This misses contracts that implement standard interfaces but don't follow naming conventions. For example, `meta-pool.near` is a liquid staking pool that implements both the staking pool interface AND the NEP-141 fungible token interface (issuing stNEAR tokens), but its account name doesn't match any pattern.

Other examples of contracts that would be missed:
- Liquid staking protocols with custom names
- Staking pool wrappers or aggregators
- FT contracts that also implement staking

## Proposed Approach: WASM Export Inspection

Every NEAR contract is compiled to WebAssembly. The WASM binary's export section lists all functions the contract exposes. By downloading the WASM and parsing its exports, we can detect which standard interfaces a contract implements — without relying on naming conventions.

### Step 1: Download Contract Code

Use the NEAR RPC `view_code` method to get the contract's WASM binary:

```
POST https://archival-rpc.mainnet.fastnear.com
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "query",
  "params": {
    "request_type": "view_code",
    "finality": "final",
    "account_id": "meta-pool.near"
  }
}
```

Response includes `code_base64` — the contract WASM encoded as base64.

### Step 2: Parse WASM Exports

The WebAssembly binary format has a well-defined export section. Parse it to extract function names:

```typescript
// Decode base64 → Uint8Array
const wasmBytes = Buffer.from(code_base64, 'base64');

// Use WebAssembly.compile() (built into Node.js) or a WASM parser
const module = await WebAssembly.compile(wasmBytes);
const exports = WebAssembly.Module.exports(module);
const functionNames = exports
    .filter(e => e.kind === 'function')
    .map(e => e.name);
```

No external dependencies needed — Node.js has built-in WebAssembly support.

### Step 3: Detect Contract Types

Check for known method signatures that indicate standard interfaces:

#### Staking Pool

Required methods (standard staking pool interface):
- `deposit_and_stake`
- `unstake`
- `unstake_all`
- `withdraw`
- `withdraw_all`
- `get_account_staked_balance`
- `get_account_unstaked_balance`
- `get_account_total_balance`

Detection rule: Contract exports `get_account_total_balance` AND `get_account_staked_balance`.

#### NEP-141 Fungible Token

Required methods:
- `ft_transfer`
- `ft_transfer_call`
- `ft_total_supply`
- `ft_balance_of`

Optional (NEP-148 metadata):
- `ft_metadata`

Detection rule: Contract exports `ft_balance_of` AND `ft_transfer`.

#### NEP-245 Multi-Token

Required methods:
- `mt_transfer`
- `mt_transfer_call`
- `mt_balance_of`
- `mt_batch_balance_of`

Detection rule: Contract exports `mt_balance_of` AND `mt_transfer`.

### Dual-Interface Contracts

Some contracts implement multiple interfaces. For example, `meta-pool.near`:
- **Staking pool**: accepts deposits via `deposit_and_stake`, reports balances via `get_account_total_balance`
- **Fungible token**: issues stNEAR tokens, queryable via `ft_balance_of`

When a contract implements both staking and FT interfaces, the system should:
1. Track the **staked balance** using `get_account_total_balance` (like any staking pool)
2. Track the **issued token** (stNEAR) as a separate fungible token via `ft_balance_of`
3. Recognize that the staked NEAR and the stNEAR token represent related but distinct balances

## Caching Strategy

Contract code changes rarely. Use `code_hash` from `view_account` as a cache key:

```typescript
interface ContractTypeCache {
    [code_hash: string]: {
        isStakingPool: boolean;
        isFungibleToken: boolean;
        isMultiToken: boolean;
        exportedMethods: string[];
    };
}
```

The `code_hash` is returned by every `view_account` call (already used throughout the codebase). Same `code_hash` = same WASM = same exports. This means:
- Multiple contracts with the same code (e.g., staking pool factory deployments) share one cache entry
- Cache only invalidates when a contract is redeployed with new code
- Cache can be persisted to disk alongside account data

## When to Check

Inspect a contract's WASM when we encounter it for the first time via a function call action in a receipt:

1. During `findBalanceChangingTransaction()`, when processing receipts
2. If the receipt contains a `FunctionCall` action to a contract we haven't seen before
3. Download and inspect the WASM (or use cached result)
4. Add the contract to the appropriate tracking list (staking pools, FT contracts, etc.)

This is lazy — we only inspect contracts the account actually interacts with, not every contract on NEAR.

## Integration with Current Code

### Current: `isStakingPool()` in `balance-tracker.ts`

```typescript
// Current regex-based detection
export function isStakingPool(id: string): boolean {
    return STAKING_POOL_PATTERNS.some(p => p.test(id));
}
```

### Future: `getContractType()` replacing regex

```typescript
// WASM-based detection (conceptual)
export async function getContractType(
    contractId: string,
    blockId?: number
): Promise<ContractType> {
    const account = await viewAccount(contractId, blockId);
    const cached = contractTypeCache[account.code_hash];
    if (cached) return cached;

    const wasm = await viewContractCode(contractId, blockId);
    const exports = parseWasmExports(wasm);
    const type = classifyContract(exports);

    contractTypeCache[account.code_hash] = type;
    return type;
}
```

The regex-based `isStakingPool()` can remain as a fast path — if the name matches a known pattern, skip the WASM download. WASM inspection acts as a fallback for contracts that don't match any naming pattern.

## RPC Considerations

- `view_code` returns the full WASM binary (can be 100KB-500KB+)
- One RPC call per unique contract (cached by `code_hash`)
- For accounts interacting with few contracts (typical), this adds minimal overhead
- The WASM download can be done at a specific block height for historical accuracy, though contract code changes are rare enough that `finality: "final"` is usually sufficient
