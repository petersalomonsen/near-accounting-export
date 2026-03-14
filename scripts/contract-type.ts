// Contract type detection via WASM export inspection.
// See docs/contract-type-detection.md for design details.

import { viewAccount, viewContractCode, getCurrentBlockHeight } from './rpc.js';

/**
 * Result of contract type classification.
 */
export interface ContractType {
    isStakingPool: boolean;
    isFungibleToken: boolean;
    isMultiToken: boolean;
    methods: string[];
}

// Required methods for each interface detection
const STAKING_POOL_METHODS = ['get_account_total_balance', 'get_account_staked_balance'];
const FT_METHODS = ['ft_balance_of', 'ft_transfer'];
const MT_METHODS = ['mt_balance_of', 'mt_transfer'];

// Cache by code_hash — same code = same exports
const contractTypeCache = new Map<string, ContractType>();

// Access the global WebAssembly object (available in Node.js 12+).
// Typed locally since tsconfig lib: es2022 doesn't include WebAssembly types.
const WA = (globalThis as Record<string, unknown>).WebAssembly as {
    compile(bytes: Uint8Array): Promise<object>;
    Module: {
        exports(module: object): Array<{ name: string; kind: string }>;
    };
};

/**
 * Parse WASM binary exports from a base64-encoded WASM module.
 * Uses Node.js built-in WebAssembly support — no external dependencies.
 */
export async function parseWasmExports(wasmBase64: string): Promise<string[]> {
    const wasmBytes = Buffer.from(wasmBase64, 'base64');
    const module = await WA.compile(wasmBytes);
    return WA.Module.exports(module)
        .filter(e => e.kind === 'function')
        .map(e => e.name);
}

/**
 * Classify a contract based on its exported method names.
 */
export function classifyContract(methods: string[]): ContractType {
    const methodSet = new Set(methods);
    return {
        isStakingPool: STAKING_POOL_METHODS.every(m => methodSet.has(m)),
        isFungibleToken: FT_METHODS.every(m => methodSet.has(m)),
        isMultiToken: MT_METHODS.every(m => methodSet.has(m)),
        methods,
    };
}

/**
 * Get contract type for a given contract, with caching by code_hash.
 *
 * 1. Calls viewAccount() to get codeHash
 * 2. Checks cache by codeHash
 * 3. If miss: downloads WASM via viewContractCode(), parses exports, classifies, caches
 */
export async function getContractType(
    contractId: string,
    blockId?: number | string
): Promise<ContractType> {
    // Resolve 'final' to a numeric block height (the SDK has issues with string finality)
    const resolvedBlockId = (blockId === undefined || blockId === 'final')
        ? await getCurrentBlockHeight()
        : blockId;

    // Get code_hash from account view
    const account = await viewAccount(contractId, resolvedBlockId);
    const codeHash = account.codeHash;

    // No contract deployed
    if (!codeHash || codeHash === '11111111111111111111111111111111') {
        return { isStakingPool: false, isFungibleToken: false, isMultiToken: false, methods: [] };
    }

    // Check cache
    const cached = contractTypeCache.get(codeHash);
    if (cached) {
        return cached;
    }

    // Download and inspect WASM
    const code = await viewContractCode(contractId, resolvedBlockId);
    const wasmBase64 = code.code_base64 || code.codeBase64;
    if (!wasmBase64) {
        return { isStakingPool: false, isFungibleToken: false, isMultiToken: false, methods: [] };
    }
    const methods = await parseWasmExports(wasmBase64);
    const contractType = classifyContract(methods);

    // Cache by code_hash
    contractTypeCache.set(codeHash, contractType);
    return contractType;
}

/**
 * Clear the contract type cache. Useful for testing.
 */
export function clearContractTypeCache(): void {
    contractTypeCache.clear();
}

/**
 * Get the current cache size. Useful for testing cache behavior.
 */
export function getContractTypeCacheSize(): number {
    return contractTypeCache.size;
}
