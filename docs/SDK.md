# Protocol 01 SDK Documentation

## Introduction

The P-01 SDK allows developers to integrate Protocol 01 wallet functionality into their decentralized applications. It provides a simple, type-safe API for connecting wallets, requesting payments, and managing payment streams.

## Installation

```bash
npm install @p01/sdk
# or
yarn add @p01/sdk
# or
pnpm add @p01/sdk
```

## Quick Start

```typescript
import { P01SDK } from '@p01/sdk';

// Initialize SDK
const p01 = new P01SDK();

// Check if extension is installed
if (p01.isInstalled()) {
  // Connect wallet
  const wallet = await p01.connect();
  console.log('Connected:', wallet.publicKey);
}
```

## API Reference

### Constructor

```typescript
const p01 = new P01SDK(options?: SDKOptions);

interface SDKOptions {
  network?: 'mainnet-beta' | 'devnet' | 'testnet';
  autoConnect?: boolean;
}
```

### Connection Methods

#### `isInstalled()`

Check if the Protocol 01 extension is installed.

```typescript
const installed: boolean = p01.isInstalled();
```

#### `connect()`

Request connection to the user's wallet.

```typescript
const wallet = await p01.connect();
// Returns: { publicKey: string, connected: boolean }
```

#### `disconnect()`

Disconnect the current wallet session.

```typescript
await p01.disconnect();
```

#### `getBalance()`

Get the current SOL balance.

```typescript
const balance: number = await p01.getBalance();
// Returns balance in SOL (not lamports)
```

### Payment Methods

#### `requestPayment(params)`

Request a payment from the connected wallet.

```typescript
const signature = await p01.requestPayment({
  recipient: 'RecipientPublicKey',
  amount: 1.5,
  token: 'SOL', // or SPL token mint address
  memo?: 'Payment for services'
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| recipient | string | Yes | Recipient's public key |
| amount | number | Yes | Amount to send |
| token | string | Yes | 'SOL' or SPL token mint |
| memo | string | No | Transaction memo |

### Stream Methods

#### `createStream(params)`

Create a new payment stream (subscription).

```typescript
const stream = await p01.createStream({
  recipient: 'MerchantPublicKey',
  amount: 9.99,
  token: 'USDC',
  interval: 'monthly',
  maxPayments: 12, // optional, defaults to unlimited
  startDate: new Date(), // optional
  metadata: {
    name: 'Premium Subscription',
    description: 'Monthly premium access'
  }
});
```

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| recipient | string | Yes | Merchant's public key |
| amount | number | Yes | Amount per interval |
| token | string | Yes | 'SOL', 'USDC', or mint |
| interval | string | Yes | 'weekly', 'monthly', 'yearly' |
| maxPayments | number | No | Max payments (unlimited if not set) |
| startDate | Date | No | When to start (default: now) |
| metadata | object | No | Additional stream info |

**Returns:**
```typescript
interface StreamInfo {
  id: string;
  status: 'active' | 'paused' | 'cancelled' | 'completed';
  recipient: string;
  amount: number;
  token: string;
  interval: string;
  nextPayment: Date;
  totalPaid: number;
  paymentsRemaining: number | null;
}
```

#### `getStreams()`

Get all streams for the connected wallet.

```typescript
const streams: StreamInfo[] = await p01.getStreams();
```

#### `getStream(id)`

Get a specific stream by ID.

```typescript
const stream: StreamInfo = await p01.getStream('stream-id');
```

#### `cancelStream(id)`

Cancel an active stream.

```typescript
const signature = await p01.cancelStream('stream-id');
```

#### `pauseStream(id)`

Pause an active stream.

```typescript
const signature = await p01.pauseStream('stream-id');
```

#### `resumeStream(id)`

Resume a paused stream.

```typescript
const signature = await p01.resumeStream('stream-id');
```

### Privacy Methods

#### `generateStealthAddress()`

Generate a one-time stealth address for receiving private payments.

```typescript
const stealth = await p01.generateStealthAddress();
// Returns: { address: string, ephemeralPubKey: string }
```

#### `scanStealthPayments()`

Scan for incoming stealth payments.

```typescript
const payments = await p01.scanStealthPayments();
// Returns: Array of detected payments
```

### Transaction Methods

#### `signTransaction(transaction)`

Sign a transaction without sending.

```typescript
import { Transaction } from '@solana/web3.js';

const tx = new Transaction();
// ... add instructions

const signedTx = await p01.signTransaction(tx);
```

#### `signAllTransactions(transactions)`

Sign multiple transactions.

```typescript
const signedTxs = await p01.signAllTransactions([tx1, tx2, tx3]);
```

#### `signMessage(message)`

Sign an arbitrary message.

```typescript
const { signature } = await p01.signMessage(
  new TextEncoder().encode('Hello, Protocol 01!')
);
```

### Events

#### `on(event, callback)`

Subscribe to wallet events.

```typescript
p01.on('connect', (wallet) => {
  console.log('Connected:', wallet.publicKey);
});

p01.on('disconnect', () => {
  console.log('Wallet disconnected');
});

p01.on('accountChanged', (newAccount) => {
  console.log('Account changed:', newAccount);
});
```

#### `off(event, callback)`

Unsubscribe from events.

```typescript
p01.off('connect', myCallback);
```

## Error Handling

```typescript
import { P01Error, ErrorCodes } from '@p01/sdk';

try {
  await p01.connect();
} catch (error) {
  if (error instanceof P01Error) {
    switch (error.code) {
      case ErrorCodes.NOT_INSTALLED:
        console.log('Please install Protocol 01 extension');
        break;
      case ErrorCodes.USER_REJECTED:
        console.log('User rejected the request');
        break;
      case ErrorCodes.INSUFFICIENT_FUNDS:
        console.log('Insufficient balance');
        break;
      default:
        console.log('Error:', error.message);
    }
  }
}
```

## TypeScript Support

The SDK is written in TypeScript and includes full type definitions.

```typescript
import {
  P01SDK,
  WalletInfo,
  StreamInfo,
  PaymentParams,
  StreamParams
} from '@p01/sdk';
```

## React Integration

```tsx
import { useEffect, useState } from 'react';
import { P01SDK } from '@p01/sdk';

const p01 = new P01SDK();

function useP01() {
  const [connected, setConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);

  useEffect(() => {
    p01.on('connect', (wallet) => {
      setConnected(true);
      setPublicKey(wallet.publicKey);
    });

    p01.on('disconnect', () => {
      setConnected(false);
      setPublicKey(null);
    });
  }, []);

  return {
    connected,
    publicKey,
    connect: () => p01.connect(),
    disconnect: () => p01.disconnect(),
  };
}

function App() {
  const { connected, publicKey, connect, disconnect } = useP01();

  return (
    <div>
      {connected ? (
        <>
          <p>Connected: {publicKey}</p>
          <button onClick={disconnect}>Disconnect</button>
        </>
      ) : (
        <button onClick={connect}>Connect P-01</button>
      )}
    </div>
  );
}
```

## Examples

### Payment Button

```tsx
async function handlePayment() {
  const p01 = new P01SDK();

  if (!p01.isInstalled()) {
    window.open('https://protocol01.xyz/extension', '_blank');
    return;
  }

  try {
    await p01.connect();

    const signature = await p01.requestPayment({
      recipient: 'MERCHANT_ADDRESS',
      amount: 29.99,
      token: 'USDC',
      memo: 'Order #12345'
    });

    console.log('Payment successful:', signature);
  } catch (error) {
    console.error('Payment failed:', error);
  }
}
```

### Subscription Setup

```tsx
async function setupSubscription() {
  const p01 = new P01SDK();
  await p01.connect();

  const stream = await p01.createStream({
    recipient: 'SERVICE_ADDRESS',
    amount: 9.99,
    token: 'USDC',
    interval: 'monthly',
    metadata: {
      name: 'Pro Plan',
      tier: 'premium'
    }
  });

  // Save stream.id to your database
  await saveUserSubscription(stream.id);
}
```

## Best Practices

1. **Always check installation** before attempting to connect
2. **Handle errors gracefully** with user-friendly messages
3. **Store stream IDs** in your backend for tracking
4. **Use webhooks** for payment confirmations in production
5. **Test on devnet** before mainnet deployment

## Support

- Documentation: [docs.protocol01.xyz](https://docs.protocol01.xyz)
- GitHub Issues: [github.com/protocol-01/sdk/issues](https://github.com/protocol-01/sdk/issues)
- Discord: [discord.gg/protocol01](https://discord.gg/protocol01)
