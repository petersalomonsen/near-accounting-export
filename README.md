# near-accounting-export

Gather NEAR account data history, tracking NEAR, Fungible Tokens, NEAR Intents and staking balance changes.

## Features

- **Binary Search Discovery**: Efficiently finds balance-changing transactions using binary search instead of scanning every block
- **Multiple Asset Types**: Tracks NEAR balance, fungible tokens (USDC, wNEAR, USDT, etc.), and NEAR Intents tokens
- **Resumable**: Save progress to file and continue from where you left off
- **Bidirectional**: Search forward or backward in time
- **Verification**: Verify transaction connectivity by checking that balance changes match between adjacent transactions
- **Docker Ready**: Designed to run in Docker containers for scheduled jobs

## Installation

```bash
npm install
```

## Usage

### Command Line

```bash
# Fetch last 50 transactions for an account
node scripts/get-account-history.js --account myaccount.near --max 50

# Continue fetching backward from existing file
node scripts/get-account-history.js --account myaccount.near --output ./history.json

# Fetch forward from a specific block
node scripts/get-account-history.js -a myaccount.near --direction forward --start-block 100000000

# Verify an existing history file
node scripts/get-account-history.js --verify --output ./history.json
```

### Docker

Build the image:

```bash
docker build -t near-accounting-export .
```

Run the container:

```bash
docker run -v $(pwd)/data:/data near-accounting-export \
  --account myaccount.near \
  --output /data/myaccount.json \
  --max 50
```

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
| `-h, --help` | Show help message | |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NEAR_RPC_ENDPOINT` | RPC endpoint URL | `https://archival-rpc.mainnet.fastnear.com` |
| `RPC_DELAY_MS` | Delay between RPC calls in ms | `50` |

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

## License

ISC
