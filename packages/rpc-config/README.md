# @protocol-01/rpc-config

Smart RPC connection manager for Solana with priority-based failover.

## Install

```bash
npm install @protocol-01/rpc-config @solana/web3.js
```

## Quick Start

```typescript
import { RpcConnectionManager } from '@protocol-01/rpc-config';

const rpc = new RpcConnectionManager({ cluster: 'devnet' });
const connection = rpc.getConnection(); // ready to use
```

The connection automatically uses the best available endpoint. If one goes down, call `switchEndpoint()` or use `checkHealthWithFailover()` to cycle to the next one.

## Features

- Priority-based endpoint selection (QuickNode > Helius > Public RPC)
- Health check with timeout and automatic failover
- Explorer URL builders (Solana Explorer, Solscan)
- Endpoint URL validation and API key sanitization for safe logging

## Configuration

### Basic (public RPC)

```typescript
const rpc = new RpcConnectionManager({ cluster: 'mainnet-beta' });
```

### With Helius

```typescript
const rpc = new RpcConnectionManager({
  cluster: 'mainnet-beta',
  heliusApiKey: process.env.HELIUS_API_KEY,
});
```

### With QuickNode (highest priority)

```typescript
const rpc = new RpcConnectionManager({
  cluster: 'mainnet-beta',
  quicknodeEndpoint: 'https://your-endpoint.quiknode.pro/...',
  heliusApiKey: process.env.HELIUS_API_KEY, // fallback
});
```

### Custom endpoints

```typescript
import { RpcConnectionManager, type RpcEndpoint } from '@protocol-01/rpc-config';

const custom: RpcEndpoint = {
  http: 'https://my-rpc.example.com',
  ws: 'wss://my-rpc.example.com',
  provider: 'custom',
  priority: 0, // highest priority
};

const rpc = new RpcConnectionManager({
  cluster: 'mainnet-beta',
  customEndpoints: [custom],
});
```

### Endpoint priority order

| Priority | Provider | Condition |
|---|---|---|
| 0 | QuickNode | `quicknodeEndpoint` provided |
| 1 | Helius | `heliusApiKey` provided |
| 2 | Solana public | Always included as fallback |
| N | Custom | Whatever `priority` you set |

## Health Checks and Failover

```typescript
// Check current endpoint health (with 5s default timeout)
const { healthy, latencyMs } = await rpc.checkHealth();

// Check with custom timeout
const result = await rpc.checkHealth(3000);

// Auto-failover: tries each endpoint, returns first healthy connection
try {
  const connection = await rpc.checkHealthWithFailover();
} catch (err) {
  // All endpoints failed -- err.message lists what was tried
}
```

### Handling RPC errors

```typescript
try {
  await connection.getBalance(pubkey);
} catch (error) {
  const switched = rpc.handleError(error as Error);
  if (switched) {
    // Retry with new endpoint
    const newConnection = rpc.getConnection();
    await newConnection.getBalance(pubkey);
  }
}
```

The manager auto-switches on: 429 (rate limit), 502/503 (server down), fetch failures, `ECONNREFUSED`, `ETIMEDOUT`, `socket hang up`, and `Blockhash not found`.

### Listening for endpoint switches

```typescript
const rpc = new RpcConnectionManager({
  cluster: 'devnet',
  onEndpointSwitch: (from, to) => {
    console.log(`Switched from ${from.provider} to ${to.provider}`);
  },
});
```

## Explorer URLs

```typescript
import { getExplorerUrl, getSolscanUrl } from '@protocol-01/rpc-config';

const txSig = '5abc...';
getExplorerUrl(txSig, 'devnet', 'tx');
// => https://explorer.solana.com/tx/5abc...?cluster=devnet

getSolscanUrl(txSig, 'mainnet-beta', 'tx');
// => https://solscan.io/tx/5abc...

getExplorerUrl('7gWp...', 'devnet', 'address');
// => https://explorer.solana.com/address/7gWp...?cluster=devnet
```

## URL Sanitization

```typescript
import { sanitizeRpcUrl, validateRpcEndpoint } from '@protocol-01/rpc-config';

// Safe for logging -- masks API keys
sanitizeRpcUrl('https://mainnet.helius-rpc.com/?api-key=SECRET123');
// => https://mainnet.helius-rpc.com/?api-key=***

// Throws if not HTTPS (localhost is exempt)
validateRpcEndpoint('http://evil.com/rpc'); // Error!
validateRpcEndpoint('http://127.0.0.1:8899'); // OK
```

## API Reference

### Connection Management

| Export | Description |
|---|---|
| `RpcConnectionManager` | Main class -- manages connections with failover |
| `.getConnection()` | Get the current `Connection` (lazy-created) |
| `.switchEndpoint()` | Advance to next endpoint, return new `Connection` |
| `.resetConnection()` | Drop cached connection (same endpoint) |
| `.getCurrentEndpoint()` | Get metadata about the active endpoint |
| `.getCluster()` | Get the configured cluster name |
| `.checkHealth(timeoutMs?)` | Probe current endpoint (default 5s timeout) |
| `.checkHealthWithFailover(timeoutMs?)` | Try all endpoints, return first healthy one |
| `.handleError(error)` | Auto-switch on known RPC errors, returns `true` if switched |

### Endpoints

| Export | Description |
|---|---|
| `getEndpoints(cluster, options?)` | Build a sorted list of RPC endpoints |
| `getDefaultRpcUrl(cluster)` | Get the public RPC URL for a cluster |

### Utilities

| Export | Description |
|---|---|
| `sanitizeRpcUrl(url)` | Redact API keys for safe logging |
| `validateRpcEndpoint(url)` | Throw if URL is not HTTPS (localhost exempt) |
| `getExplorerUrl(value, cluster, type?)` | Build Solana Explorer URL |
| `getSolscanUrl(value, cluster, type?)` | Build Solscan URL |

### Types

| Type | Description |
|---|---|
| `SolanaCluster` | `'mainnet-beta' \| 'devnet' \| 'testnet' \| 'localnet'` |
| `RpcEndpoint` | `{ http, ws, provider, priority }` |
| `ConnectionConfig` | Full config for `RpcConnectionManager` |
| `GetEndpointsOptions` | Options for `getEndpoints()` |

## License

MIT
