---
name: near-rpc
description: NEAR Protocol RPC query conventions. Use when making any RPC calls to the NEAR blockchain, querying block heights, account state, or any on-chain data.
user-invocable: false
---

# NEAR RPC Usage

## RPC Endpoint

- **Always use**: `https://archival-rpc.mainnet.fastnear.com`
- **Never use**: `rpc.mainnet.near.org` (deprecated)

## Request Format

All NEAR RPC calls use JSON-RPC 2.0 over POST:

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"<method>","params":<params>}'
```

## Common Methods

### Get current block height

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"status","params":[]}'
```

Result path: `.result.sync_info.latest_block_height`

### View account

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_account","finality":"final","account_id":"<account>"}}'
```

### View account at specific block

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_account","block_id":<block_height>,"account_id":"<account>"}}'
```

### Get block by height

```bash
curl -s -X POST https://archival-rpc.mainnet.fastnear.com \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"block","params":{"block_id":<block_height>}}'
```

## Fly.io Deployment

- App name: `near-accounting-export`
- API base URL: `https://near-accounting-export.fly.dev`
- Check account status: `GET /api/accounts/{accountId}/status`
- Data stored on persistent volume at `/data`
