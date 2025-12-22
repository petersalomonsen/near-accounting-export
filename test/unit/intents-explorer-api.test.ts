import { strict as assert } from 'assert';
import { describe, it, before, after } from 'mocha';
import { 
    isIntentsExplorerAvailable, 
    parseAssetToTokenId 
} from '../../scripts/intents-explorer-api.js';

describe('Intents Explorer API', () => {
    describe('isIntentsExplorerAvailable', () => {
        // The actual env var used by the module
        const ENV_VAR = 'INTENTS_EXPLORER_API_KEY';
        let originalApiKey: string | undefined;
        let hadOriginalKey: boolean;

        before(() => {
            // Save original value
            originalApiKey = process.env[ENV_VAR];
            hadOriginalKey = originalApiKey !== undefined;
        });

        after(() => {
            // Restore original value
            if (hadOriginalKey) {
                process.env[ENV_VAR] = originalApiKey;
            } else {
                delete process.env[ENV_VAR];
            }
        });

        it('should return false when API key is not set', function() {
            // Skip this test if the key was originally set (e.g., in CI or dev environment)
            if (hadOriginalKey) {
                this.skip();
            }
            delete process.env[ENV_VAR];
            
            assert.strictEqual(isIntentsExplorerAvailable(), false);
        });

        it('should return true when API key is set', () => {
            process.env[ENV_VAR] = 'test-jwt-token';
            
            assert.strictEqual(isIntentsExplorerAvailable(), true);
        });
    });

    describe('parseAssetToTokenId', () => {
        // The intents.near multi-token contract requires full prefixed token IDs
        // e.g., "nep141:wrap.near" not just "wrap.near"
        
        it('should keep NEP-141 token with full contract address as-is', () => {
            const asset = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
            const result = parseAssetToTokenId(asset);
            // Keep the full prefixed format for intents.near contract compatibility
            assert.strictEqual(result, 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
        });

        it('should keep NEP-141 token with named contract as-is', () => {
            const asset = 'nep141:wrap.near';
            const result = parseAssetToTokenId(asset);
            assert.strictEqual(result, 'nep141:wrap.near');
        });

        it('should keep NEP-141 token with complex contract name as-is', () => {
            const asset = 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near';
            const result = parseAssetToTokenId(asset);
            assert.strictEqual(result, 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near');
        });

        it('should handle native NEAR', () => {
            const result = parseAssetToTokenId('near');
            assert.strictEqual(result, 'near');
        });

        it('should handle native NEAR case-insensitive', () => {
            const result = parseAssetToTokenId('NEAR');
            assert.strictEqual(result, 'near');
        });

        it('should return asset as-is for unknown format', () => {
            const asset = 'some-unknown-format';
            const result = parseAssetToTokenId(asset);
            assert.strictEqual(result, 'some-unknown-format');
        });

        it('should return null for empty string', () => {
            const result = parseAssetToTokenId('');
            assert.strictEqual(result, null);
        });
    });
});
