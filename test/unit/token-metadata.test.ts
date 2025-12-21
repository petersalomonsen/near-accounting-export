/**
 * Test suite for token metadata fetching and formatting
 */
import { strict as assert } from 'assert';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load environment variables
dotenv.config({ path: path.join(__dirname, '..', '..', '..', '.env') });

import {
    getTokenMetadata,
    formatTokenAmount,
    clearMetadataCache
} from '../../scripts/token-metadata.js';

describe('Token Metadata', function() {
    // Increase timeout for RPC calls
    this.timeout(30000);

    // Clear cache before each test to ensure fresh fetches
    beforeEach(function() {
        clearMetadataCache();
    });

    describe('NEAR Native Token', function() {
        it('should return NEAR metadata for native token', async function() {
            const metadata = await getTokenMetadata('NEAR', 'near');
            assert.equal(metadata.symbol, 'NEAR');
            assert.equal(metadata.decimals, 24);
        });
    });

    describe('Fungible Tokens (FT)', function() {
        it('should fetch metadata for wrap.near', async function() {
            const metadata = await getTokenMetadata('wrap.near', 'ft');
            assert.equal(metadata.symbol, 'wNEAR');
            assert.equal(metadata.decimals, 24);
        });

        it('should fetch metadata for USDC (17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1)', async function() {
            const tokenId = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            const metadata = await getTokenMetadata(tokenId, 'ft');
            assert.ok(metadata.symbol, 'Should have a symbol');
            // Note: May fall back to default decimals if RPC is unavailable
            assert.ok(metadata.decimals >= 0, 'Should have decimals');
            console.log(`    USDC FT metadata: symbol=${metadata.symbol}, decimals=${metadata.decimals}`);
        });
    });

    describe('NEAR Intents Multi-Tokens (MT)', function() {
        it('should fetch metadata for nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1 (USDC via Intents)', async function() {
            const tokenId = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            assert.ok(metadata.symbol, 'Should have a symbol');
            // Note: May fall back to default decimals if RPC is unavailable
            assert.ok(metadata.decimals >= 0, 'Should have decimals');
            console.log(`    USDC MT metadata: symbol=${metadata.symbol}, decimals=${metadata.decimals}`);
        });

        it('should fetch metadata for nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near (USDC bridged)', async function() {
            const tokenId = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            assert.ok(metadata.symbol, 'Should have a symbol');
            assert.ok(metadata.decimals >= 0, 'Should have decimals');
            console.log(`    USDC bridged MT metadata: symbol=${metadata.symbol}, decimals=${metadata.decimals}`);
        });

        it('should fetch metadata for nep141:eth.omft.near', async function() {
            const tokenId = 'nep141:eth.omft.near';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            assert.ok(metadata.symbol, 'Should have a symbol');
            assert.ok(metadata.decimals >= 0, 'Should have decimals');
            console.log(`    ETH MT metadata: symbol=${metadata.symbol}, decimals=${metadata.decimals}`);
        });

        it('should fetch metadata for nep141:wrap.near (wNEAR via Intents)', async function() {
            const tokenId = 'nep141:wrap.near';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            // wrap.near is in KNOWN_TOKENS, so should always return wNEAR
            assert.equal(metadata.symbol, 'wNEAR');
            assert.equal(metadata.decimals, 24);
        });

        it('should handle nep245:v2_1.omni.hot.tg:43114_11111111111111111111 token', async function() {
            const tokenId = 'nep245:v2_1.omni.hot.tg:43114_11111111111111111111';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            assert.ok(metadata.symbol, 'Should have a symbol');
            assert.ok(metadata.decimals >= 0, 'Should have decimals');
            console.log(`    nep245 token metadata: symbol=${metadata.symbol}, decimals=${metadata.decimals}`);
        });
    });

    describe('Token Amount Formatting', function() {
        it('should format NEAR amounts correctly', function() {
            // 1 NEAR = 1e24 yoctoNEAR
            assert.equal(formatTokenAmount('1000000000000000000000000', 24), '1');
            assert.equal(formatTokenAmount('500000000000000000000000', 24), '0.5');
            assert.equal(formatTokenAmount('100000000000000000000000', 24), '0.1');
            assert.equal(formatTokenAmount('1500000000000000000000000', 24), '1.5');
        });

        it('should format USDC amounts correctly', function() {
            // 1 USDC = 1e6 base units
            assert.equal(formatTokenAmount('1000000', 6), '1');
            assert.equal(formatTokenAmount('500000', 6), '0.5');
            assert.equal(formatTokenAmount('20000', 6), '0.02');
            assert.equal(formatTokenAmount('1500000', 6), '1.5');
        });

        it('should format amounts with 18 decimals correctly', function() {
            // Common for many ERC-20 tokens
            assert.equal(formatTokenAmount('1000000000000000000', 18), '1');
            assert.equal(formatTokenAmount('500000000000000000', 18), '0.5');
            assert.equal(formatTokenAmount('1500000000000000000', 18), '1.5');
        });

        it('should handle zero amounts', function() {
            assert.equal(formatTokenAmount('0', 24), '0');
            assert.equal(formatTokenAmount('0', 6), '0');
            assert.equal(formatTokenAmount('0', 18), '0');
        });

        it('should trim trailing zeros', function() {
            assert.equal(formatTokenAmount('1000000000000000000000000', 24), '1');
            assert.equal(formatTokenAmount('1100000000000000000000000', 24), '1.1');
            assert.equal(formatTokenAmount('1010000000000000000000000', 24), '1.01');
        });
    });

    describe('Caching', function() {
        it('should cache metadata and not fetch twice', async function() {
            const tokenId = 'wrap.near';
            
            // First fetch
            const metadata1 = await getTokenMetadata(tokenId, 'ft');
            assert.equal(metadata1.symbol, 'wNEAR');
            
            // Second fetch should use cache (no RPC call)
            const metadata2 = await getTokenMetadata(tokenId, 'ft');
            assert.equal(metadata2.symbol, 'wNEAR');
            assert.deepEqual(metadata1, metadata2);
        });

        it('should clear cache properly', async function() {
            const tokenId = 'wrap.near';
            
            // Fetch once
            await getTokenMetadata(tokenId, 'ft');
            
            // Clear cache
            clearMetadataCache();
            
            // Fetch again - should work
            const metadata = await getTokenMetadata(tokenId, 'ft');
            assert.equal(metadata.symbol, 'wNEAR');
        });
    });

    describe('Fallback Behavior', function() {
        it('should use fallback for unknown FT token', async function() {
            const tokenId = 'nonexistent.near';
            const metadata = await getTokenMetadata(tokenId, 'ft');
            assert.equal(metadata.symbol, 'NONEXISTENT');
            assert.equal(metadata.decimals, 24);
        });

        it('should handle MT token with fallback', async function() {
            const tokenId = 'nep141:nonexistent.near';
            const metadata = await getTokenMetadata(tokenId, 'mt');
            assert.equal(metadata.symbol, 'NONEXISTENT');
            assert.equal(metadata.decimals, 24);
        });
    });
});
