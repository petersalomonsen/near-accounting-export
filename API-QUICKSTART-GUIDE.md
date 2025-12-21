# NEAR Accounting Export API - Quick Start Guide

**API Endpoint:** `https://near-accounting-export.fly.dev`

## Step 1: Get ARIZ Tokens

First, you need ARIZ tokens to register your account. You can buy them with NEAR.

### 1.1 Register with the ARIZ token contract (one-time)

```bash
near contract call-function as-transaction arizcredits.near storage_deposit \
  json-args '{"account_id": "YOUR_ACCOUNT.near"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' \
  sign-as YOUR_ACCOUNT.near network-config mainnet sign-with-keychain send
```

### 1.2 Buy ARIZ tokens with NEAR

```bash
near contract call-function as-transaction arizcredits.near call_js_func \
  json-args '{"function_name": "buy_tokens_for_near"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0.5 NEAR' \
  sign-as YOUR_ACCOUNT.near network-config mainnet sign-with-keychain send
```

### 1.3 Check your balance (optional)

```bash
near tokens YOUR_ACCOUNT.near view-ft-balance arizcredits.near network-config mainnet now
```

## Step 2: Register with the API

### 2.1 Send 0.1 ARIZ registration fee

```bash
near tokens YOUR_ACCOUNT.near send-ft arizcredits.near arizcredits.near '0.1 ARIZ' \
  memo '' network-config mainnet sign-with-keychain send
```

Copy the **Transaction ID** from the output (e.g., `6HWrWibgzQ5yBs2Cb7qsScnkbb2bBMJSG575xnzd5RCT`).

### 2.2 Register your account

```bash
curl -X POST https://near-accounting-export.fly.dev/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"transactionHash": "YOUR_TRANSACTION_ID"}'
```

## Step 3: Automatic Data Collection

Once registered, the API server automatically collects your transaction history in a continuous sync loop. No manual job creation is needed!

### 3.1 Check collection status

```bash
curl https://near-accounting-export.fly.dev/api/accounts/YOUR_ACCOUNT.near/status
```

This shows:
- `dataRange`: The blocks and transactions already collected
- `ongoingJob`: Currently running collection job (if any)

The server processes accounts in round-robin fashion, continuously updating your data.

## Step 4: Download Your Data

### Download as JSON

```bash
curl -o transactions.json \
  https://near-accounting-export.fly.dev/api/accounts/YOUR_ACCOUNT.near/download/json
```

### Download as CSV

```bash
curl -o transactions.csv \
  https://near-accounting-export.fly.dev/api/accounts/YOUR_ACCOUNT.near/download/csv
```

---

## Complete Example

```bash
# 1. Register with ARIZ contract (first time only)
near contract call-function as-transaction arizcredits.near storage_deposit \
  json-args '{"account_id": "myaccount.near"}' \
  prepaid-gas '30.0 Tgas' attached-deposit '0.01 NEAR' \
  sign-as myaccount.near network-config mainnet sign-with-keychain send

# 2. Buy ARIZ tokens
near contract call-function as-transaction arizcredits.near call_js_func \
  json-args '{"function_name": "buy_tokens_for_near"}' \
  prepaid-gas '100.0 Tgas' attached-deposit '0.5 NEAR' \
  sign-as myaccount.near network-config mainnet sign-with-keychain send

# 3. Pay registration fee (note the Transaction ID in the output)
near tokens myaccount.near send-ft arizcredits.near arizcredits.near '0.1 ARIZ' \
  memo '' network-config mainnet sign-with-keychain send

# 4. Register with the API (use your transaction ID)
curl -X POST https://near-accounting-export.fly.dev/api/accounts \
  -H "Content-Type: application/json" \
  -d '{"transactionHash": "YOUR_TRANSACTION_ID"}'

# 5. Wait for automatic collection (or check status anytime)
curl https://near-accounting-export.fly.dev/api/accounts/myaccount.near/status

# 6. Download data (available anytime, even during collection)
curl -o myaccount.csv \
  https://near-accounting-export.fly.dev/api/accounts/myaccount.near/download/csv
```

---

## Pricing

| Item | Cost |
|------|------|
| Registration fee | 0.1 ARIZ |
| ARIZ token price | ~0.17 NEAR per ARIZ |

## Need Help?

- Full API documentation: [API.md](./API.md)
- View registered accounts: `curl https://near-accounting-export.fly.dev/api/accounts`
- Health check: `curl https://near-accounting-export.fly.dev/health`
