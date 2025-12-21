import { strict as assert } from 'assert';
import { describe, it, before, after } from 'mocha';
import { isIntentsExplorerAvailable } from '../../scripts/intents-explorer-api.js';

describe('Intents Explorer API', () => {
    describe('isIntentsExplorerAvailable', () => {
        let originalApiKey: string | undefined;
        let originalApiUrl: string | undefined;

        before(() => {
            // Save original values
            originalApiKey = process.env.INTENTS_EXPLORER_API_KEY;
            originalApiUrl = process.env.INTENTS_EXPLORER_API_URL;
        });

        after(() => {
            // Restore original values
            if (originalApiKey !== undefined) {
                process.env.INTENTS_EXPLORER_API_KEY = originalApiKey;
            } else {
                delete process.env.INTENTS_EXPLORER_API_KEY;
            }
            
            if (originalApiUrl !== undefined) {
                process.env.INTENTS_EXPLORER_API_URL = originalApiUrl;
            } else {
                delete process.env.INTENTS_EXPLORER_API_URL;
            }
        });

        it('should return false when neither API key nor URL is set', () => {
            delete process.env.INTENTS_EXPLORER_API_KEY;
            delete process.env.INTENTS_EXPLORER_API_URL;
            
            assert.strictEqual(isIntentsExplorerAvailable(), false);
        });

        it('should return true when API key is set', () => {
            process.env.INTENTS_EXPLORER_API_KEY = 'test-api-key';
            delete process.env.INTENTS_EXPLORER_API_URL;
            
            assert.strictEqual(isIntentsExplorerAvailable(), true);
        });

        it('should return true when API URL is set', () => {
            delete process.env.INTENTS_EXPLORER_API_KEY;
            process.env.INTENTS_EXPLORER_API_URL = 'https://custom-api.example.com';
            
            assert.strictEqual(isIntentsExplorerAvailable(), true);
        });

        it('should return true when both API key and URL are set', () => {
            process.env.INTENTS_EXPLORER_API_KEY = 'test-api-key';
            process.env.INTENTS_EXPLORER_API_URL = 'https://custom-api.example.com';
            
            assert.strictEqual(isIntentsExplorerAvailable(), true);
        });
    });
});
