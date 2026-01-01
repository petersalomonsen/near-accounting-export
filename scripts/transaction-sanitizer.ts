/**
 * Transaction Sanitizer Module
 *
 * Utilities for sanitizing transaction data to prevent storing large binary payloads.
 * This helps keep JSON files manageable and readable.
 */

// Maximum size for args field in bytes (as base64)
const MAX_ARGS_SIZE = 1000; // ~750 bytes of actual data when base64 decoded

// Marker for removed binary data
const BINARY_DATA_MARKER = "BINARY_DATA";

/**
 * Check if a string is valid JSON
 */
function isValidJSON(str: string): boolean {
    try {
        JSON.parse(str);
        return true;
    } catch {
        return false;
    }
}

/**
 * Decode base64 string and check if it's valid JSON
 */
function tryDecodeBase64AsJSON(base64Str: string): any | null {
    try {
        const decoded = Buffer.from(base64Str, 'base64').toString('utf-8');
        if (isValidJSON(decoded)) {
            return JSON.parse(decoded);
        }
    } catch {
        // Not valid JSON or not decodable
    }
    return null;
}

/**
 * Sanitize a FunctionCall action's args field
 * - If args is large binary data (not JSON), replace with marker
 * - If args is small or valid JSON, keep it
 */
function sanitizeFunctionCallArgs(args: any): any {
    if (typeof args !== 'string') {
        return args;
    }

    // Check size
    if (args.length > MAX_ARGS_SIZE) {
        // Try to decode as JSON first
        const decoded = tryDecodeBase64AsJSON(args);
        if (decoded !== null) {
            // It's valid JSON, keep it even if large
            // (most contract calls have JSON args that are useful)
            return args;
        }

        // It's binary data, replace with marker
        return BINARY_DATA_MARKER;
    }

    return args;
}

/**
 * Sanitize a single action object
 */
function sanitizeAction(action: any): any {
    if (!action || typeof action !== 'object') {
        return action;
    }

    // Create a copy to avoid mutating original
    const sanitized = { ...action };

    // Check for FunctionCall with args
    if (sanitized.FunctionCall && sanitized.FunctionCall.args) {
        sanitized.FunctionCall = {
            ...sanitized.FunctionCall,
            args: sanitizeFunctionCallArgs(sanitized.FunctionCall.args)
        };
    }

    return sanitized;
}

/**
 * Sanitize transaction data by removing or marking large binary payloads
 * Returns a sanitized copy of the transaction
 */
export function sanitizeTransaction(tx: any): any {
    if (!tx || typeof tx !== 'object') {
        return tx;
    }

    const sanitized = { ...tx };

    // Sanitize actions array if present
    if (Array.isArray(sanitized.actions)) {
        sanitized.actions = sanitized.actions.map(sanitizeAction);
    }

    return sanitized;
}

/**
 * Sanitize an array of transactions
 */
export function sanitizeTransactions(transactions: any[]): any[] {
    if (!Array.isArray(transactions)) {
        return transactions;
    }

    return transactions.map(sanitizeTransaction);
}

/**
 * Check if a transaction has been sanitized (contains BINARY_DATA marker)
 */
export function hasBinaryDataMarker(tx: any): boolean {
    if (!tx || typeof tx !== 'object') {
        return false;
    }

    const txStr = JSON.stringify(tx);
    return txStr.includes(BINARY_DATA_MARKER);
}

/**
 * Get statistics about sanitization in a transaction entry
 */
export function getSanitizationStats(tx: any): {
    totalActions: number;
    sanitizedActions: number;
    totalArgsSize: number;
    savedBytes: number;
} {
    const stats = {
        totalActions: 0,
        sanitizedActions: 0,
        totalArgsSize: 0,
        savedBytes: 0
    };

    if (!tx || typeof tx !== 'object' || !Array.isArray(tx.actions)) {
        return stats;
    }

    for (const action of tx.actions) {
        if (action && action.FunctionCall && action.FunctionCall.args) {
            stats.totalActions++;
            const argsSize = typeof action.FunctionCall.args === 'string'
                ? action.FunctionCall.args.length
                : 0;
            stats.totalArgsSize += argsSize;

            if (action.FunctionCall.args === BINARY_DATA_MARKER) {
                stats.sanitizedActions++;
                // Estimate saved bytes (marker is much smaller than original)
                stats.savedBytes += MAX_ARGS_SIZE;
            } else if (argsSize > MAX_ARGS_SIZE) {
                // Large JSON args that were kept
                stats.totalArgsSize += argsSize;
            }
        }
    }

    return stats;
}

export { BINARY_DATA_MARKER, MAX_ARGS_SIZE };
