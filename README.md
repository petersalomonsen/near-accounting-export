# near-accounting-export

Gather NEAR account data history, tracking NEAR, Fungible Tokens, NEAR Intents and staking balance changes.

This project is written in **TypeScript** and uses the official **@near-js/jsonrpc-client** library for blockchain interactions.

## Features

- **Binary Search Discovery**: Efficiently finds balance-changing transactions using binary search instead of scanning every block
- **Gap Detection & Filling**: Automatically detects and fills gaps in transaction history where balance connectivity is broken
- **Multiple Asset Types**: Tracks NEAR balance, fungible tokens (USDC, wNEAR, USDT, etc.), and NEAR Intents tokens
- **Resumable**: Save progress to file and continue from where you left off
- **Bidirectional**: Search forward or backward in time
- **Verification**: Verify transaction connectivity by checking that balance changes match between adjacent transactions
- **Docker Ready**: Designed to run in Docker containers with persistent volumes for scheduled jobs
- **Type Safe**: Fully typed with TypeScript for better development experience

## Installation

```bash
npm install
```

## Building

The project is written in TypeScript and must be compiled:

```bash
# Build TypeScript to JavaScript
npm run build

# For development with auto-reload
npm run dev
```

## Usage

### Command Line

```bash
# Fetch last 50 transactions for an account
npm start -- --account myaccount.near --max 50

# Or use the compiled script directly
node dist/scripts/get-account-history.js --account myaccount.near --max 50

# Continue fetching backward from existing file
node dist/scripts/get-account-history.js --account myaccount.near --output ./history.json

# Fetch forward from a specific block
node dist/scripts/get-account-history.js -a myaccount.near --direction forward --start-block 100000000

# Verify an existing history file
node dist/scripts/get-account-history.js --verify --output ./history.json
```

### Docker

Build the image:

```bash
docker build -t near-accounting-export .
```

Run the container with a persistent volume:

```bash
# Create a local data directory
mkdir -p ./data

# Run with volume mounted to persist data
docker run -v $(pwd)/data:/data near-accounting-export \
  --account myaccount.near \
  --output /data/myaccount.json \
  --max 50

# Run again to continue from where you left off
docker run -v $(pwd)/data:/data near-accounting-export \
  --account myaccount.near \
  --output /data/myaccount.json \
  --max 50

# Fill gaps in existing history
docker run -v $(pwd)/data:/data near-accounting-export \
  --fill-gaps-only \
  --output /data/myaccount.json
```

**Important**: Always use the `-v` flag to mount a volume. This persists your data outside the container so:
- You can access the JSON file when the container is not running
- You can continue adding more transactions in subsequent runs
- Your data survives container restarts and deletions

The script automatically:
- Loads existing history from the output file
- Detects and fills gaps where balance connectivity is broken
- Continues searching from where it left off
- Saves progress continuously (every 5 transactions)

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-a, --account <id>` | NEAR account ID to fetch history for | Required |
| `-o, --output <file>` | Output file path | `<account-id>.json` |
| `-d, --direction <dir>` | Search direction: 'backward' or 'forward' | `backward` |
| `-m, --max <number>` | Maximum transactions to fetch | `100` |
| `--start-block <number>` | Starting block height | Auto-determined |
| `--end-block <number>` | Ending block height | Current block |
| `-v, --verify` | Verify an existing history file | `false` |
| `--fill-gaps-only` | Only fill gaps, don't search for new transactions | `false` |
| `-h, --help` | Show help message | |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEAR_RPC_ENDPOINT` | RPC endpoint URL | `https://archival-rpc.mainnet.fastnear.com` |
| `FASTNEAR_API_KEY` | FastNEAR API key for higher rate limits | None |
| `NEARBLOCKS_API_KEY` | NearBlocks API key for faster transaction discovery | None |
| `RPC_DELAY_MS` | Delay between RPC calls in ms | `50` |

**Note:** When `NEARBLOCKS_API_KEY` is set, the script will first fetch known transaction blocks from the NearBlocks API, which is much faster than binary search. It then falls back to binary search for any remaining transactions or if the API is unavailable.

## Output Format

The output JSON file contains:

```json
{
  "accountId": "myaccount.near",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "updatedAt": "2024-01-01T00:01:00.000Z",
  "transactions": [
    {
      "block": 123456789,
      "timestamp": "1234567890000000000",
      "transactionHashes": ["..."],
      "transactions": [...],
      "balanceBefore": {
        "near": "1000000000000000000000000",
        "fungibleTokens": {...},
        "intentsTokens": {...}
      },
      "balanceAfter": {
        "near": "900000000000000000000000",
        "fungibleTokens": {...},
        "intentsTokens": {...}
      },
      "changes": {
        "nearChanged": true,
        "nearDiff": "-100000000000000000000000",
        "tokensChanged": {},
        "intentsChanged": {}
      }
    }
  ],
  "metadata": {
    "firstBlock": 123456700,
    "lastBlock": 123456789,
    "totalTransactions": 10
  }
}
```

## Testing

```bash
npm test
```

## CSV Export

Convert the JSON accounting history to CSV format for import into spreadsheet software:

```bash
# Convert JSON to CSV (output file will be myaccount.near.csv)
node dist/scripts/json-to-csv.js myaccount.near.json

# Specify custom output file
node dist/scripts/json-to-csv.js -i myaccount.near.json -o accounting.csv

# Using long options
node dist/scripts/json-to-csv.js --input myaccount.near.json --output accounting.csv
```

### CSV Columns

The CSV export provides both **human-friendly columns** (on the left) for easy readability and **technical columns** (on the right) for programmatic use:

#### Human-Friendly Columns

| Column | Description |
|--------|-------------|
| `change_block_height` | Block where the balance change was observed (used for sorting) |
| `timestamp` | ISO 8601 timestamp of the transfer |
| `counterparty` | The other account involved in the transfer |
| `direction` | "in" for incoming, "out" for outgoing transfers |
| `token_symbol` | Human-readable token symbol (NEAR, USDT, wNEAR, etc.) |
| `amount_whole_units` | Amount transferred in whole units (with decimals applied) |
| `balance_whole_units` | Token balance after transfer (with decimals applied) |

#### Technical Columns

| Column | Description |
|--------|-------------|
| `asset` | Token contract ID (NEAR for native, contract address for FT/MT, STAKING:pool for staking rewards) |
| `amount_raw` | Amount transferred in base units (as string to prevent Excel scientific notation) |
| `token_balance_raw` | Token balance in base units (as string) |
| `transaction_hash` | Hash of the transaction (can be used to look up transaction in explorers) |
| `receipt_id` | Receipt ID of the transfer |

**Note:** 
- Raw values are exported as strings (wrapped in quotes) to prevent Excel from converting them to scientific notation.
- Rows are sorted by `change_block_height` in ascending order, reflecting the actual sequence of balance-changing events.
- The `transaction_hash` enables verification in block explorers (e.g., NearBlocks).
- For staking rewards, there is no transaction or receipt, only a balance change observation at a specific block.
- If timestamps are missing in the JSON, re-run `get-account-history.js` with the `--enrich` flag to fetch missing timestamps before converting to CSV.

## License

ISC
