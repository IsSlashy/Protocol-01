# @protocol-01/specter-js

Frontend SDK for Protocol 01 payments and subscriptions. Vanilla JS + React.

## Installation

```bash
npm install @protocol-01/specter-js
```

For React hooks, `react >= 17.0.0` is required as a peer dependency.

## Requirements

- **Protocol 01 wallet extension** -- [Install here](https://protocol01.com/wallet)
- **Solana network** -- Operates on `devnet` (default) or `mainnet-beta`

> Without the wallet extension installed, you can still build your UI -- the SDK provides `P01.isInstalled()`, `P01.waitForInstall()`, and `P01.onInstall()` to handle the missing-wallet case gracefully.

## Quick Start (Vanilla JS)

```typescript
import { P01 } from '@protocol-01/specter-js';

const p01 = new P01({ network: 'devnet' });

// Connect to the Protocol 01 wallet extension
await p01.connect();
console.log('Connected:', p01.getPublicKey());

// One-time payment
const payment = await p01.pay({
  recipient: 'wallet_address',
  amount: 10,
  token: 'USDC',
  private: true, // Use stealth address
});
console.log('Signature:', payment.signature);

// Create a subscription (Stream Secure)
const sub = await p01.subscribe({
  recipient: 'merchant_wallet',
  merchantName: 'Netflix',
  amount: 15.99,
  token: 'USDC',
  period: 'monthly',
  maxPayments: 12,
});
console.log('Subscription ID:', sub.subscriptionId);

// Manage subscriptions
const subscriptions = await p01.getSubscriptions();
await p01.pauseSubscription(subscriptions[0].id);
await p01.resumeSubscription(subscriptions[0].id);

// Listen for events
p01.on('paymentSent', (event) => {
  console.log('Payment sent:', event.data);
});
```

## React Integration

```tsx
import {
  SpecterProvider,
  useSpecter,
  usePayment,
  useSubscription,
  PayButton,
  SubscribeButton,
} from '@protocol-01/specter-js/react';

function App() {
  return (
    <SpecterProvider config={{ network: 'devnet' }}>
      <PaymentPage />
    </SpecterProvider>
  );
}

function PaymentPage() {
  const { connect, disconnect, isConnected, isInstalled, publicKey } = useSpecter();
  const { pay, isLoading: payLoading, error: payError, lastPayment } = usePayment();
  const { subscribe, pauseSubscription, resumeSubscription, subscriptions, isLoading: subLoading } = useSubscription();

  if (!isInstalled) {
    return (
      <div>
        <p>Protocol 01 wallet is required.</p>
        <a href="https://protocol01.com/wallet" target="_blank">Install Wallet</a>
      </div>
    );
  }

  const handlePay = async () => {
    const result = await pay({
      recipient: 'seller_wallet',
      amount: 25,
      token: 'USDC',
      private: true,
    });
    if (result) {
      console.log('Paid!', result.signature);
    }
  };

  const handleSubscribe = async () => {
    const result = await subscribe({
      recipient: 'merchant_wallet',
      merchantName: 'Netflix',
      amount: 15.99,
      period: 'monthly',
      maxPayments: 12,
    });
    if (result) {
      console.log('Subscribed!', result.subscriptionId);
    }
  };

  return (
    <div>
      {!isConnected ? (
        <button onClick={connect}>Connect Wallet</button>
      ) : (
        <button onClick={disconnect}>Disconnect ({publicKey})</button>
      )}
      <button onClick={handlePay} disabled={payLoading}>Pay $25</button>
      <button onClick={handleSubscribe} disabled={subLoading}>Subscribe</button>

      {/* Or use pre-built components: */}
      <PayButton
        recipient="seller_wallet"
        amount={25}
        token="USDC"
        onSuccess={(result) => console.log('Paid!', result)}
      />
      <SubscribeButton
        recipient="merchant_wallet"
        merchantName="Netflix"
        amount={15.99}
        period="monthly"
        onSuccess={(result) => console.log('Subscribed!', result)}
      />
    </div>
  );
}
```

## No cancellation, no refunds

A Protocol 01 subscription is a **one-way prepaid envelope**. Money that enters a
subscription vault can only ever leave it toward the merchant. The protocol has
no cancellation instruction and no refund path, so **the protocol cannot return
money to a subscriber under any circumstance**.

The subscriber has exactly two controls:

- **Pause** -- freezes the subscription clock and cuts access. Prepaid days are
  not lost while paused.
- **Resume** -- the clock picks up exactly where it stopped.

Over the life of a subscription the merchant receives exactly the amount
deposited, always, eventually. Pause changes *when*, never *how much*.

**A merchant remains free to refund off-band from its own wallet.** Nothing here
forbids a refund as a commercial act -- it simply is not something the protocol
executes, custodies or guarantees.

Tell the subscriber this **before** they pay. It is a condition of the payment,
not a detail of the account screen.

## Handling Missing Wallet

The wallet extension injects itself asynchronously. Use these methods to handle the case where it is not yet available:

```typescript
import { P01 } from '@protocol-01/specter-js';

// 1. Synchronous check
if (P01.isInstalled()) {
  // Ready to connect
}

// 2. Wait with timeout (useful on page load)
const installed = await P01.waitForInstall(5000); // wait up to 5s
if (!installed) {
  console.log('Install at:', P01.getInstallUrl());
}

// 3. Listen indefinitely (useful for SPAs)
const cleanup = P01.onInstall(() => {
  console.log('Wallet just became available!');
  enableConnectButton();
});
// Call cleanup() when your component unmounts
```

## Events

The `on()` method returns an unsubscribe function. Events and their payloads:

| Event | Payload | Description |
|---|---|---|
| `connect` | `{ publicKey, stealthAddress? }` | Wallet connected |
| `disconnect` | `{}` | Wallet disconnected |
| `accountChanged` | `{ publicKey }` | Active account changed |
| `paymentSent` | `PaymentOptions & { signature }` | Payment sent |
| `paymentReceived` | `{ signature, amount, from }` | Incoming payment detected |
| `subscriptionCreated` | `SubscriptionOptions & SubscriptionResult` | Subscription created |
| `subscriptionPaused` | `{ subscriptionId }` | Subscriber paused the subscription |
| `subscriptionResumed` | `{ subscriptionId }` | Subscriber resumed a paused subscription |
| `subscriptionPayment` | `{ subscriptionId, signature, periodsPaid }` | Recurring payment made |

```typescript
// Subscribe to events
const unsubPayment = p01.on('paymentSent', (event) => {
  console.log('TX signature:', event.data.signature);
});

const unsubConnect = p01.on('connect', (event) => {
  console.log('Connected:', event.data.publicKey);
});

// Clean up
unsubPayment();
unsubConnect();
```

Type-safe event payloads are available via `P01EventMap` and `P01TypedEvent`:

```typescript
import type { P01EventMap, P01TypedEvent } from '@protocol-01/specter-js';

// P01EventMap['paymentSent'] = PaymentOptions & { signature: string }
```

## Error Handling

All SDK errors are `P01Error` instances with a `code` property. Helper functions make it easy to categorize errors:

```typescript
import { P01, P01Error, P01ErrorCode, isUserRejection, isNetworkError, isTimeoutError } from '@protocol-01/specter-js';

try {
  await p01.pay({ recipient, amount: 10, token: 'USDC' });
} catch (error) {
  if (isUserRejection(error)) {
    // User clicked "Reject" in the wallet popup
    showMessage('Payment was declined.');
  } else if (isNetworkError(error)) {
    // RPC node unreachable, internet down, etc.
    showMessage('Network error. Check your connection and try again.');
  } else if (isTimeoutError(error)) {
    // Operation exceeded the configured timeout
    showMessage('Request timed out. Please try again.');
  } else if (error instanceof P01Error) {
    // Other SDK error
    switch (error.code) {
      case P01ErrorCode.NOT_INSTALLED:
        showInstallPrompt(P01.getInstallUrl());
        break;
      case P01ErrorCode.NOT_CONNECTED:
        await p01.connect();
        break;
      case P01ErrorCode.INSUFFICIENT_FUNDS:
        showMessage('Insufficient balance.');
        break;
      case P01ErrorCode.TRANSACTION_FAILED:
        showMessage('Transaction failed on-chain.');
        break;
    }
  }
}
```

All `P01Error` instances have `.code`, `.message`, `.details`, `.is(code)`, and `.toJSON()`.

## Network Configuration

The SDK defaults to `devnet`. Set the network at construction time or change it later:

```typescript
// At construction
const p01 = new P01({ network: 'mainnet-beta' });

// Or change later (before connect)
const p01 = new P01();
p01.setNetwork('mainnet-beta');
await p01.connect();

// Check current network
console.log(p01.getNetwork()); // 'mainnet-beta'
```

The network determines which token mint addresses are used (e.g., mainnet USDC vs devnet USDC). The wallet extension may have its own network setting; the client network affects SDK-side token resolution.

## API Reference

### P01 (Client)

| Method | Description |
|---|---|
| `constructor(config?: P01Config)` | Create a client (network, autoConnect, timeout, rpcEndpoint) |
| `static isInstalled()` | Check if the wallet extension is installed |
| `static waitForInstall(timeout?)` | Wait for the wallet to become available |
| `static onInstall(callback)` | Register callback for when wallet becomes available (returns cleanup fn) |
| `static getInstallUrl()` | Get the wallet install URL |
| `setNetwork(network)` | Set the active Solana network |
| `getNetwork()` | Get the current network |
| `connect()` | Connect to the wallet extension |
| `disconnect()` | Disconnect from the wallet |
| `isConnected()` | Check connection status |
| `getPublicKey()` | Get the connected wallet's public key |
| `getWalletInfo()` | Get wallet metadata |
| `pay(options)` | Send a one-time payment (private or public) |
| `subscribe(options)` | Create a Stream Secure subscription |
| `getSubscriptions()` | Get all subscriptions for the connected wallet |
| `pauseSubscription(id)` | Pause a subscription (freezes the clock, cuts access) |
| `resumeSubscription(id)` | Resume a paused subscription |
| `on(event, callback)` | Subscribe to events (returns unsubscribe function) |
| `off(event, callback)` | Unsubscribe from events |

### React Hooks

| Hook / Component | Description |
|---|---|
| `SpecterProvider` | Context provider -- wrap your app with this |
| `useSpecter()` | Access connection state: `{ specter, connect, disconnect, isConnected, isInstalled, publicKey, walletInfo, error }` |
| `usePayment()` | Payment hook: `{ pay, isLoading, error, lastPayment }` |
| `useSubscription()` | Subscription hook: `{ subscribe, pauseSubscription, resumeSubscription, getSubscriptions, subscriptions, isLoading, error }` |
| `PayButton` | Pre-built pay button component |
| `SubscribeButton` | Pre-built subscribe button component |

### DOM Button Helpers

```typescript
import { createPayButton, createSubscribeButton } from '@protocol-01/specter-js';

const { destroy } = createPayButton('#pay-container', {
  recipient: 'wallet_address',
  amount: 10,
  token: 'USDC',
  theme: 'dark',
  onSuccess: (result) => console.log('Paid!', result),
  onError: (error) => console.error(error),
});

const { destroy: destroySub } = createSubscribeButton('#sub-container', {
  recipient: 'merchant_wallet',
  merchantName: 'Netflix',
  amount: 15.99,
  period: 'monthly',
  theme: 'dark',
  showPrice: true,
  onSuccess: (result) => console.log('Subscribed!', result),
});
```

### Error Helpers

| Function | Description |
|---|---|
| `isUserRejection(error)` | Check if error is a user rejection |
| `isNetworkError(error)` | Check if error is a network/RPC failure |
| `isTimeoutError(error)` | Check if error is a timeout |

### Key Types

- `P01Config` -- Client configuration (network, autoConnect, timeout, rpcEndpoint)
- `PaymentOptions` -- Payment parameters (recipient, amount, token, private)
- `PaymentResult` -- Payment result (signature, isPrivate, confirmation)
- `SubscriptionOptions` -- Subscription parameters (recipient, merchantName, amount, period, maxPayments)
- `SubscriptionResult` -- Result (subscriptionId, address, signature)
- `SubscriptionPeriod` -- `'daily' | 'weekly' | 'monthly' | 'yearly'` or seconds as number
- `P01EventType` -- Union of all event names
- `P01EventMap` -- Type-safe mapping of event name to payload type
- `P01Error` / `P01ErrorCode` -- Structured error types

## License

MIT
