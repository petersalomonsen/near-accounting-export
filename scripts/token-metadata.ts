// Token metadata caching and fetching
// Provides token symbol and decimals for NEAR, FT, and MT tokens

import { callViewFunction } from './rpc.js';

export interface TokenMetadata {
    symbol: string;
    decimals: number;
}

// Cache for token metadata to avoid repeated RPC calls
const metadataCache = new Map<string, TokenMetadata>();

// Known token metadata for common tokens
const KNOWN_TOKENS: Record<string, TokenMetadata> = {
    'NEAR': { symbol: 'NEAR', decimals: 24 },
    'wrap.near': { symbol: 'wNEAR', decimals: 24 },
    'usdt.tether-token.near': { symbol: 'USDT', decimals: 6 },
    'usdc.spin-fi.near': { symbol: 'USDC', decimals: 6 },
    'token.v2.ref-finance.near': { symbol: 'REF', decimals: 18 },
    'aurora': { symbol: 'AURORA', decimals: 18 }
};

/**
 * Get token metadata from cache
 */
function getCachedMetadata(tokenId: string): TokenMetadata | null {
    return metadataCache.get(tokenId) || null;
}

/**
 * Set token metadata in cache
 */
function setCachedMetadata(tokenId: string, metadata: TokenMetadata): void {
    metadataCache.set(tokenId, metadata);
}

/**
 * Fetch FT metadata from contract
 */
async function fetchFTMetadata(contractId: string): Promise<TokenMetadata | null> {
    try {
        // Use 'finalized' to get the latest state
        const metadata = await callViewFunction(contractId, 'ft_metadata', {}, 'finalized');
        
        if (metadata && typeof metadata === 'object') {
            const symbol = (metadata as any).symbol || contractId.split('.')[0]?.toUpperCase() || 'UNKNOWN';
            const decimals = (metadata as any).decimals || 24;
            return { symbol, decimals };
        }
    } catch (error) {
        // Contract might not have ft_metadata method or might be inaccessible
        console.warn(`Could not fetch FT metadata for ${contractId}: ${error}`);
    }
    
    return null;
}

/**
 * Get token metadata for any token type (NEAR, FT, MT, staking)
 * Uses cache and known tokens first, then fetches from contract if needed
 */
export async function getTokenMetadata(
    tokenId: string,
    tokenType: 'near' | 'ft' | 'mt' | 'staking_reward'
): Promise<TokenMetadata> {
    // Handle NEAR native token
    if (tokenType === 'near' || tokenId === 'NEAR') {
        return KNOWN_TOKENS['NEAR']!;
    }
    
    // Handle staking rewards - use NEAR decimals
    if (tokenType === 'staking_reward') {
        return {
            symbol: `STAKED`,
            decimals: 24
        };
    }
    
    // Check cache first
    const cached = getCachedMetadata(tokenId);
    if (cached) {
        return cached;
    }
    
    // Check known tokens
    const known = KNOWN_TOKENS[tokenId];
    if (known) {
        setCachedMetadata(tokenId, known);
        return known;
    }
    
    // For MT (multi-token/intents), extract the underlying contract
    // MT tokens can be formatted as:
    // - "nep141:contract.near" - NEP-141 token via intents
    // - "nep245:contract.near:token_id" - NEP-245 multi-token via intents
    if (tokenType === 'mt') {
        if (tokenId.startsWith('nep141:')) {
            const contractId = tokenId.substring(7); // Remove "nep141:" prefix
            
            // Check if the underlying contract is in known tokens
            const knownContract = KNOWN_TOKENS[contractId];
            if (knownContract) {
                setCachedMetadata(tokenId, knownContract);
                return knownContract;
            }
            
            const ftMetadata = await fetchFTMetadata(contractId);
            if (ftMetadata) {
                // Cache with the full MT token ID
                setCachedMetadata(tokenId, ftMetadata);
                return ftMetadata;
            }
        } else if (tokenId.startsWith('nep245:')) {
            // For nep245 tokens, extract the contract part (before the second colon)
            // Format: "nep245:contract.near:token_id"
            const withoutPrefix = tokenId.substring(7); // Remove "nep245:" prefix
            const contractId = withoutPrefix.split(':')[0]; // Get contract before token_id
            if (contractId) {
                const ftMetadata = await fetchFTMetadata(contractId);
                if (ftMetadata) {
                    // Cache with the full MT token ID
                    setCachedMetadata(tokenId, ftMetadata);
                    return ftMetadata;
                }
            }
        }
    }
    
    // For FT tokens, fetch metadata
    if (tokenType === 'ft') {
        const ftMetadata = await fetchFTMetadata(tokenId);
        if (ftMetadata) {
            setCachedMetadata(tokenId, ftMetadata);
            return ftMetadata;
        }
    }
    
    // Fallback: use first part of contract ID as symbol
    // For MT tokens, strip the prefix first
    let fallbackTokenId = tokenId;
    if (tokenId.startsWith('nep141:')) {
        fallbackTokenId = tokenId.substring(7);
    } else if (tokenId.startsWith('nep245:')) {
        fallbackTokenId = tokenId.substring(7).split(':')[0] || tokenId;
    }
    const fallbackSymbol = fallbackTokenId.split('.')[0]?.toUpperCase() || 'UNKNOWN';
    const fallback: TokenMetadata = { symbol: fallbackSymbol, decimals: 24 };
    setCachedMetadata(tokenId, fallback);
    return fallback;
}

/**
 * Format amount from base units to whole units
 */
export function formatTokenAmount(amountRaw: string, decimals: number): string {
    try {
        const amount = BigInt(amountRaw);
        const divisor = BigInt(10) ** BigInt(decimals);
        const wholePart = amount / divisor;
        const fractionalPart = amount % divisor;
        
        if (fractionalPart === 0n) {
            return wholePart.toString();
        }
        
        // Format fractional part with proper padding
        const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
        // Remove trailing zeros
        const trimmedFractional = fractionalStr.replace(/0+$/, '');
        
        return `${wholePart}.${trimmedFractional}`;
    } catch (error) {
        console.warn(`Error formatting amount ${amountRaw} with ${decimals} decimals: ${error}`);
        return '0';
    }
}

/**
 * Clear the metadata cache (useful for testing)
 */
export function clearMetadataCache(): void {
    metadataCache.clear();
}
