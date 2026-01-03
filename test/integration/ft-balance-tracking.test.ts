import { describe, it } from 'mocha';
import assert from 'assert';
import { getBalanceChangesAtBlock, findBalanceChangingTransaction } from '../../scripts/balance-tracker.js';

/**
 * Integration test for FT balance tracking.
 * 
 * This test validates that FT balances are properly queried when FT transfers occur,
 * even if the FT contract is not in the DEFAULT_TOKENS list.
 */
describe('FT Balance Tracking', function() {
    // Extend timeout for RPC calls
    this.timeout(120000);

    const accountId = 'webassemblymusic-treasury.sputnik-dao.near';

    it('should query FT balance when FT transfer is detected (block 168568481)', async function() {
        // This block has an FT transfer of arizcredits.near tokens
        // The test verifies that:
        // 1. The FT transfer is detected in transfers
        // 2. The arizcredits.near balance is included in balance snapshots
        
        const blockHeight = 168568481;
        
        // First, discover the transaction to see what tokens are involved
        const txInfo = await findBalanceChangingTransaction(accountId, blockHeight);
        
        // Verify that the FT transfer was detected
        const ftTransfers = txInfo.transfers.filter(t => t.type === 'ft');
        assert.ok(ftTransfers.length > 0, 'Should detect FT transfers');
        
        const arizcreditsTransfer = ftTransfers.find(t => t.tokenId === 'arizcredits.near');
        assert.ok(arizcreditsTransfer, 'Should detect arizcredits.near FT transfer');
        assert.strictEqual(arizcreditsTransfer.amount, '3000000', 'Transfer amount should be 3000000');
        assert.strictEqual(arizcreditsTransfer.direction, 'in', 'Transfer direction should be in');
        
        // Extract FT contracts from transfers
        const ftContracts = new Set<string>();
        for (const transfer of txInfo.transfers) {
            if (transfer.type === 'ft' && transfer.tokenId) {
                ftContracts.add(transfer.tokenId);
            }
        }
        
        // Now get balance changes with the discovered FT contracts
        const balanceChanges = await getBalanceChangesAtBlock(
            accountId,
            blockHeight,
            Array.from(ftContracts),
            null,
            undefined
        );
        
        // Verify that arizcredits.near balance is included in the snapshots
        assert.ok(
            balanceChanges.startBalance?.fungibleTokens,
            'startBalance should have fungibleTokens'
        );
        assert.ok(
            balanceChanges.endBalance?.fungibleTokens,
            'endBalance should have fungibleTokens'
        );
        
        assert.ok(
            'arizcredits.near' in balanceChanges.startBalance.fungibleTokens,
            'startBalance should include arizcredits.near balance'
        );
        assert.ok(
            'arizcredits.near' in balanceChanges.endBalance.fungibleTokens,
            'endBalance should include arizcredits.near balance'
        );
        
        // Verify the balance change
        const startBalance = BigInt(balanceChanges.startBalance.fungibleTokens['arizcredits.near'] || '0');
        const endBalance = BigInt(balanceChanges.endBalance.fungibleTokens['arizcredits.near'] || '0');
        const diff = endBalance - startBalance;
        
        assert.strictEqual(
            diff.toString(),
            '3000000',
            'Balance should increase by 3000000 (the transfer amount)'
        );
        
        // Verify it's tracked in changes
        assert.ok(
            balanceChanges.tokensChanged['arizcredits.near'],
            'arizcredits.near should be in tokensChanged'
        );
        assert.strictEqual(
            balanceChanges.tokensChanged['arizcredits.near']?.diff,
            '3000000',
            'Token change diff should be 3000000'
        );
    });
    
    it('should include FT balances in balance snapshots (example from issue)', async function() {
        // This test reproduces the issue described in the problem statement:
        // - Transaction has FT transfer detected in transfers array
        // - But fungibleTokens in balanceBefore and balanceAfter are empty
        
        const blockHeight = 168568481;
        
        // Get the transaction info (which includes transfers)
        const txInfo = await findBalanceChangingTransaction(accountId, blockHeight);
        
        // Find FT transfers
        const ftTransfers = txInfo.transfers.filter(t => t.type === 'ft');
        assert.ok(ftTransfers.length > 0, 'Should have FT transfers');
        
        // Extract FT contract IDs
        const ftContractIds = ftTransfers
            .filter(t => t.tokenId)
            .map(t => t.tokenId!);
        
        // Get balance changes WITH the FT contracts specified
        const balanceChanges = await getBalanceChangesAtBlock(
            accountId,
            blockHeight,
            ftContractIds,
            null,
            undefined
        );
        
        // Verify that fungibleTokens is NOT empty
        const ftTokensInBefore = Object.keys(balanceChanges.startBalance?.fungibleTokens || {});
        const ftTokensInAfter = Object.keys(balanceChanges.endBalance?.fungibleTokens || {});
        
        assert.ok(
            ftTokensInBefore.length > 0,
            'balanceBefore.fungibleTokens should not be empty when FT transfers occur'
        );
        assert.ok(
            ftTokensInAfter.length > 0,
            'balanceAfter.fungibleTokens should not be empty when FT transfers occur'
        );
        
        // Verify that tokensChanged is NOT empty
        const changedTokens = Object.keys(balanceChanges.tokensChanged);
        assert.ok(
            changedTokens.length > 0,
            'tokensChanged should not be empty when FT transfers occur'
        );
    });
});
