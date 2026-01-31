# @p01/specter-js

Frontend SDK and React hooks for integrating Protocol 01 payments and Stream Secure subscriptions into dApps. Communicates with the Protocol 01 browser wallet extension.

## Installation

```bash
npm install @p01/specter-js
```

For React hooks, `react >= 17.0.0` is required as a peer dependency.

## Quick Start

### Vanilla JavaScript

```typescript
import { P01 } from '@p01/specter-js';

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
await p01.cancelSubscription(subscriptions[0].id);

// Listen for events
p01.on('paymentSent', (event) => {
  console.log('Payment sent:', event.data);
});
```

### React Hooks

```tsx
import {
  SpecterProvider,
  useSpecter,
  usePayment,
  useSubscription,
  PayButton,
  SubscribeButton,
} from '@p01/specter-js/react';

function App() {
  return (
    <SpecterProvider>
      <PaymentPage />
    </SpecterProvider>
  );
}

function PaymentPage() {
  const { connect, isConnected, publicKey } = useSpecter();
  const { pay, isLoading, error, lastPayment } = usePayment();
  const { subscribe, cancelSubscription, subscriptions } = useSubscription();

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
      {!isConnected && <button onClick={connect}>Connect Wallet</button>}
      <button onClick={handlePay} disabled={isLoading}>Pay $25</button>
      <button onClick={handleSubscribe} disabled={isLoading}>Subscribe</button>
    </div>
  );
}
```

## API Reference

### P01 (Client)

| Method | Description |
|---|---|
| `constructor(config?: P01Config)` | Create a client (network, autoConnect, timeout, rpcEndpoint) |
| `static isInstalled()` | Check if the Protocol 01 wallet extension is installed |
| `static waitForInstall(timeout?)` | Wait for the wallet to become available |
| `connect()` | Connect to the wallet extension |
| `disconnect()` | Disconnect from the wallet |
| `isConnected()` | Check connection status |
| `getPublicKey()` | Get the connected wallet's public key |
| `getWalletInfo()` | Get wallet metadata |
| `pay(options)` | Send a one-time payment (private or public) |
| `subscribe(options)` | Create a Stream Secure subscription |
| `getSubscriptions()` | Get all subscriptions for the connected wallet |
| `cancelSubscription(id)` | Cancel a subscription |
| `on(event, callback)` | Subscribe to events (returns unsubscribe function) |
| `off(event, callback)` | Unsubscribe from events |

### React Hooks

| Hook / Component | Description |
|---|---|
| `SpecterProvider` | Context provider -- wrap your app with this |
| `useSpecter()` | Access connection state: `{ specter, connect, disconnect, isConnected, publicKey }` |
| `usePayment()` | Payment hook: `{ pay, isLoading, error, lastPayment }` |
| `useSubscription()` | Subscription hook: `{ subscribe, cancelSubscription, getSubscriptions, subscriptions, isLoading, error }` |
| `PayButton` | Pre-built pay button component |
| `SubscribeButton` | Pre-built subscribe button component |

### Key Types

- `P01Config` -- Client configuration (network, autoConnect, timeout, rpcEndpoint)
- `PaymentOptions` -- Payment parameters (recipient, amount, token, private)
- `PaymentResult` -- Payment result (signature, isPrivate, confirmation)
- `SubscriptionOptions` -- Subscription parameters (recipient, merchantName, amount, period, maxPayments)
- `SubscriptionResult` -- Result (subscriptionId, address, signature)
- `SubscriptionPeriod` -- `'daily' | 'weekly' | 'monthly' | 'yearly'` or seconds as a number

## License

MIT
