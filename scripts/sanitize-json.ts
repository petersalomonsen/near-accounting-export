#!/usr/bin/env node
// Sanitize existing account JSON files by removing large binary data payloads
// This helps reduce file sizes and makes JSON files more readable

import fs from 'fs';
import { fileURLToPath } from 'url';
import { sanitizeTransactions, getSanitizationStats, BINARY_DATA_MARKER } from './transaction-sanitizer.js';

interface TransactionEntry {
    block: number;
    transactions: any[];
    [key: string]: any;
}

interface AccountHistory {
    accountId: string;
    transactions: TransactionEntry[];
    [key: string]: any;
}

interface ParsedArgs {
    inputFiles: string[];
    inPlace: boolean;
    dryRun: boolean;
    help: boolean;
}

/**
 * Parse command line arguments
 */
function parseArgs(): ParsedArgs {
    const args = process.argv.slice(2);
    const options: ParsedArgs = {
        inputFiles: [],
        inPlace: false,
        dryRun: false,
        help: false
    };

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        switch (arg) {
            case '--in-place':
            case '-i':
                options.inPlace = true;
                break;
            case '--dry-run':
            case '-d':
                options.dryRun = true;
                break;
            case '--help':
            case '-h':
                options.help = true;
                break;
            default:
                // If not a flag, treat as input file
                if (arg && !arg.startsWith('-')) {
                    options.inputFiles.push(arg);
                }
        }
    }

    return options;
}

/**
 * Print help message
 */
function printHelp(): void {
    console.log(`
Sanitize JSON Tool - Remove large binary data from account JSON files

Usage:
  node sanitize-json.js [options] <input-files...>

Options:
  -i, --in-place        Modify files in place (default: create .sanitized.json files)
  -d, --dry-run         Show what would be sanitized without modifying files
  -h, --help            Show this help message

Description:
  Scans account JSON files for large binary data in transaction args fields.
  Binary data larger than ~750 bytes is replaced with "${BINARY_DATA_MARKER}" marker.
  JSON-decodable args are preserved even if large, as they contain useful information.

  This helps:
  - Reduce file sizes significantly
  - Make JSON files more readable
  - Prevent issues with large files in editors/parsers

Examples:
  # Dry run to see what would be changed
  node sanitize-json.js --dry-run myaccount.near.json

  # Create sanitized copy (myaccount.near.sanitized.json)
  node sanitize-json.js myaccount.near.json

  # Sanitize in place (overwrites original)
  node sanitize-json.js --in-place myaccount.near.json

  # Sanitize multiple files
  node sanitize-json.js --in-place *.near.json
`);
}

/**
 * Sanitize a single file
 */
function sanitizeFile(inputFile: string, inPlace: boolean, dryRun: boolean): void {
    console.log(`\nProcessing: ${inputFile}`);

    // Check if input file exists
    if (!fs.existsSync(inputFile)) {
        console.error(`Error: File not found: ${inputFile}`);
        return;
    }

    try {
        // Read and parse input file
        const inputData = fs.readFileSync(inputFile, 'utf-8');
        const history: AccountHistory = JSON.parse(inputData);

        // Validate basic structure
        if (!history.accountId || !Array.isArray(history.transactions)) {
            console.error('Error: Invalid JSON structure - missing accountId or transactions array');
            return;
        }

        let totalTransactions = 0;
        let totalSanitized = 0;
        let totalBytesSaved = 0;

        // Sanitize each transaction entry
        for (const entry of history.transactions) {
            if (!entry.transactions || !Array.isArray(entry.transactions)) {
                continue;
            }

            // Count original stats
            for (const tx of entry.transactions) {
                const beforeStats = getSanitizationStats(tx);
                totalTransactions++;

                if (beforeStats.totalActions > 0) {
                    // Check if would be sanitized
                    const sanitized = sanitizeTransactions([tx])[0];
                    const afterStats = getSanitizationStats(sanitized);

                    if (afterStats.sanitizedActions > 0) {
                        totalSanitized++;
                        totalBytesSaved += afterStats.savedBytes;

                        if (dryRun) {
                            console.log(`  Would sanitize transaction at block ${entry.block}:`);
                            console.log(`    Actions: ${beforeStats.totalActions}, Sanitized: ${afterStats.sanitizedActions}`);
                            console.log(`    Bytes saved: ~${afterStats.savedBytes}`);
                        }
                    }
                }
            }

            // Apply sanitization
            if (!dryRun) {
                entry.transactions = sanitizeTransactions(entry.transactions);
            }
        }

        // Report results
        console.log(`\nResults for ${history.accountId}:`);
        console.log(`  Total transaction entries: ${history.transactions.length}`);
        console.log(`  Total transactions with actions: ${totalTransactions}`);
        console.log(`  Transactions with sanitized args: ${totalSanitized}`);
        console.log(`  Estimated bytes saved: ~${totalBytesSaved.toLocaleString()}`);

        if (totalSanitized === 0) {
            console.log(`  ✅ No sanitization needed`);
            return;
        }

        if (dryRun) {
            console.log(`  (Dry run - no files modified)`);
            return;
        }

        // Determine output file
        const outputFile = inPlace
            ? inputFile
            : inputFile.replace(/\.json$/, '.sanitized.json');

        // Write sanitized data
        const outputData = JSON.stringify(history, null, 2);
        fs.writeFileSync(outputFile, outputData, 'utf-8');

        // Calculate size difference
        const originalSize = inputData.length;
        const sanitizedSize = outputData.length;
        const sizeDiff = originalSize - sanitizedSize;
        const percentReduction = ((sizeDiff / originalSize) * 100).toFixed(1);

        console.log(`\n✅ Sanitized file written to: ${outputFile}`);
        console.log(`  Original size: ${originalSize.toLocaleString()} bytes`);
        console.log(`  Sanitized size: ${sanitizedSize.toLocaleString()} bytes`);
        console.log(`  Reduction: ${sizeDiff.toLocaleString()} bytes (${percentReduction}%)`);

    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error processing ${inputFile}: ${message}`);
    }
}

/**
 * Main execution
 */
async function main(): Promise<void> {
    const options = parseArgs();

    if (options.help) {
        printHelp();
        process.exit(0);
    }

    if (options.inputFiles.length === 0) {
        console.error('Error: No input files specified');
        printHelp();
        process.exit(1);
    }

    console.log(`=== JSON Sanitization Tool ===`);
    if (options.dryRun) {
        console.log(`Mode: Dry run (no files will be modified)`);
    } else if (options.inPlace) {
        console.log(`Mode: In-place (files will be overwritten)`);
    } else {
        console.log(`Mode: Create sanitized copies (*.sanitized.json)`);
    }

    // Process each file
    for (const inputFile of options.inputFiles) {
        sanitizeFile(inputFile, options.inPlace, options.dryRun);
    }

    console.log(`\n=== Complete ===`);
}

// Run if called directly
if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}

// Export for testing
export { sanitizeFile };
