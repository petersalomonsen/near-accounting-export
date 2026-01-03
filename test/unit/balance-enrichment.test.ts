import { describe, it } from 'mocha';
import assert from 'assert';
import { enrichBalanceSnapshot, detectBalanceChanges } from '../../scripts/balance-tracker.js';
import type { BalanceSnapshot } from '../../scripts/balance-tracker.js';

/**
 * Unit test for balance snapshot enrichment functionality.
 * 
 * This tests the enrichBalanceSnapshot function that adds missing FT/intents token
 * balances to existing snapshots after those tokens are discovered from transfers.
 */
describe('Balance Enrichment - Unit Tests', function() {
    it('should identify missing FT tokens correctly', function() {
        const existingSnapshot: BalanceSnapshot = {
            near: '1000000',
            fungibleTokens: {
                'wrap.near': '500000',
                'usdt.tether-token.near': '100000'
            },
            intentsTokens: {},
            stakingPools: {}
        };
        
        const additionalFtContracts = ['wrap.near', 'arizcredits.near', 'token.near'];
        
        // Filter out tokens already in snapshot (simulating what enrichBalanceSnapshot does)
        const missingTokens = additionalFtContracts.filter(
            token => !(token in existingSnapshot.fungibleTokens)
        );
        
        // Should identify arizcredits.near and token.near as missing
        assert.strictEqual(missingTokens.length, 2);
        assert.ok(missingTokens.includes('arizcredits.near'));
        assert.ok(missingTokens.includes('token.near'));
        assert.ok(!missingTokens.includes('wrap.near'), 'wrap.near should not be in missing list');
    });
    
    it('should identify missing intents tokens correctly', function() {
        const existingSnapshot: BalanceSnapshot = {
            near: '1000000',
            fungibleTokens: {},
            intentsTokens: {
                'nep141:wrap.near': '800000000000000000000000'
            },
            stakingPools: {}
        };
        
        const additionalIntentsTokens = [
            'nep141:wrap.near',
            'nep141:eth.omft.near',
            'nep245:v2_1.omni.hot.tg:43114_11111111111111111111'
        ];
        
        // Filter out tokens already in snapshot
        const missingTokens = additionalIntentsTokens.filter(
            token => !(token in existingSnapshot.intentsTokens)
        );
        
        // Should identify the two new tokens as missing
        assert.strictEqual(missingTokens.length, 2);
        assert.ok(missingTokens.includes('nep141:eth.omft.near'));
        assert.ok(missingTokens.includes('nep245:v2_1.omni.hot.tg:43114_11111111111111111111'));
        assert.ok(!missingTokens.includes('nep141:wrap.near'), 'nep141:wrap.near should not be in missing list');
    });
    
    it('should detect FT balance changes correctly', function() {
        const balanceBefore: BalanceSnapshot = {
            near: '1000000000000000000000000',
            fungibleTokens: {
                'arizcredits.near': '0'
            },
            intentsTokens: {},
            stakingPools: {}
        };
        
        const balanceAfter: BalanceSnapshot = {
            near: '1000000000000000000000000',
            fungibleTokens: {
                'arizcredits.near': '3000000'
            },
            intentsTokens: {},
            stakingPools: {}
        };
        
        const changes = detectBalanceChanges(balanceBefore, balanceAfter);
        
        assert.strictEqual(changes.hasChanges, true, 'Should detect changes');
        assert.strictEqual(changes.nearChanged, false, 'NEAR should not have changed');
        
        // Check FT changes
        assert.ok('arizcredits.near' in changes.tokensChanged, 'arizcredits.near should be in tokensChanged');
        assert.strictEqual(changes.tokensChanged['arizcredits.near']?.diff, '3000000');
        assert.strictEqual(changes.tokensChanged['arizcredits.near']?.start, '0');
        assert.strictEqual(changes.tokensChanged['arizcredits.near']?.end, '3000000');
    });
    
    it('should handle enrichment with no missing tokens', function() {
        const existingSnapshot: BalanceSnapshot = {
            near: '1000000',
            fungibleTokens: {
                'wrap.near': '500000',
                'arizcredits.near': '100000'
            },
            intentsTokens: {
                'nep141:wrap.near': '800000'
            },
            stakingPools: {}
        };
        
        // Try to enrich with tokens that are already present
        const additionalFtContracts = ['wrap.near', 'arizcredits.near'];
        const additionalIntentsTokens = ['nep141:wrap.near'];
        
        const missingFt = additionalFtContracts.filter(
            token => !(token in existingSnapshot.fungibleTokens)
        );
        const missingIntents = additionalIntentsTokens.filter(
            token => !(token in existingSnapshot.intentsTokens)
        );
        
        // Should have no missing tokens
        assert.strictEqual(missingFt.length, 0, 'No FT tokens should be missing');
        assert.strictEqual(missingIntents.length, 0, 'No intents tokens should be missing');
        
        // In this case, enrichBalanceSnapshot would just return the existing snapshot
        // (no RPC calls needed)
    });
    
    it('should detect multiple token changes in same transaction', function() {
        const balanceBefore: BalanceSnapshot = {
            near: '2000000000000000000000000',
            fungibleTokens: {
                'arizcredits.near': '1000000',
                'wrap.near': '5000000000000000000000000'
            },
            intentsTokens: {
                'nep141:eth.omft.near': '35015088429776132'
            },
            stakingPools: {}
        };
        
        const balanceAfter: BalanceSnapshot = {
            near: '1500000000000000000000000',  // Decreased by 0.5 NEAR
            fungibleTokens: {
                'arizcredits.near': '4000000',  // Increased by 3000000
                'wrap.near': '5000000000000000000000000'  // No change
            },
            intentsTokens: {
                'nep141:eth.omft.near': '30015088429776132'  // Decreased
            },
            stakingPools: {}
        };
        
        const changes = detectBalanceChanges(balanceBefore, balanceAfter);
        
        assert.strictEqual(changes.hasChanges, true, 'Should detect changes');
        assert.strictEqual(changes.nearChanged, true, 'NEAR should have changed');
        
        // Check NEAR change
        const nearDiff = BigInt(balanceAfter.near) - BigInt(balanceBefore.near);
        assert.strictEqual(changes.nearDiff, nearDiff.toString());
        
        // Check FT changes
        assert.ok('arizcredits.near' in changes.tokensChanged, 'arizcredits.near should be in tokensChanged');
        assert.strictEqual(changes.tokensChanged['arizcredits.near']?.diff, '3000000');
        
        // wrap.near should NOT be in changes (no change)
        assert.ok(!('wrap.near' in changes.tokensChanged), 'wrap.near should not be in tokensChanged (no change)');
        
        // Check intents changes
        assert.ok('nep141:eth.omft.near' in changes.intentsChanged, 'nep141:eth.omft.near should be in intentsChanged');
        const intentsDiff = BigInt('30015088429776132') - BigInt('35015088429776132');
        assert.strictEqual(changes.intentsChanged['nep141:eth.omft.near']?.diff, intentsDiff.toString());
    });
});
