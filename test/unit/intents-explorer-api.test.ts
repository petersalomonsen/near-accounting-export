import { strict as assert } from 'assert';
import { describe, it, before, after } from 'mocha';
import { isIntentsExplorerAvailable } from '../../scripts/intents-explorer-api.js';

describe('Intents Explorer API', () => {
    describe('isIntentsExplorerAvailable', () => {
        let originalApiUrl: string | undefined;

        before(() => {
            // Save original value
            originalApiUrl = process.env.INTENTS_EXPLORER_API_URL;
        });

        after(() => {
            // Restore original value
            if (originalApiUrl !== undefined) {
                process.env.INTENTS_EXPLORER_API_URL = originalApiUrl;
            } else {
                delete process.env.INTENTS_EXPLORER_API_URL;
            }
        });

        it('should return false when API URL is not set', () => {
            delete process.env.INTENTS_EXPLORER_API_URL;
            
            assert.strictEqual(isIntentsExplorerAvailable(), false);
        });

        it('should return true when API URL is set', () => {
            process.env.INTENTS_EXPLORER_API_URL = 'https://custom-api.example.com';
            
            assert.strictEqual(isIntentsExplorerAvailable(), true);
        });
    });
});
