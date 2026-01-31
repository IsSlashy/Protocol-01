# p-01

Merchant SDK for integrating Protocol 01 privacy-first crypto payments and Stream Secure subscriptions. Includes a vanilla JavaScript client, React components, a service registry, and built-in security primitives.

## Installation

```bash
npm install p-01
```

For React components, `react >= 17.0.0` is required as a peer dependency.

## Quick Start

### Vanilla JavaScript

```typescript
import { Protocol01 } from 'p-01';

const p01 = new Protocol01({
  merchantId: 'your-merchant-id',
  merchantName: 'Your Business',
  defaultToken: 'USDC',
  network: 'mainnet-beta',
  webhookUrl: 'https://api.yourbusiness.com/p01/webhook',
});

// Connect to the user's wallet
const { publicKey } = await p01.connect();

// One-time payment
const payment = await p01.requestPayment({
  amount: 9.99,
  description: 'Premium Feature',
  orderId: 'order-123',
  token: 'USDC',
});
console.log('Payment signature:', payment.signature);

// Create a subscription with Stream Secure
const sub = await p01.createSubscription({
  amount: 15.99,
  interval: 'monthly',
  maxPayments: 12,
  description: 'Pro Plan',
  suggestedPrivacy: {
    amountNoise: 5,
    timingNoise: 2,
    useStealthAddress: true,
  },
});
console.log('Subscription ID:', sub.subscriptionId);

// Manage subscriptions
const subscriptions = await p01.getSubscriptions();
await p01.cancelSubscription(subscriptions[0].id);

// Listen for events
const unsubscribe = p01.on('paymentComplete', (event) => {
  console.log('Payment completed:', event.data);
});
```

### React Components

```tsx
import {
  P01Provider,
  WalletButton,
  PaymentButton,
  SubscriptionWidget,
  SubscriptionButton,
  SubscriptionCard,
  useP01,
  useP01Wallet,
} from 'p-01/react';

function App() {
  return (
    <P01Provider config={{ merchantId: 'your-id', merchantName: 'Your Business' }}>
      <WalletButton />
      <SubscriptionWidget
        tiers={[
          { id: 'basic', name: 'Basic', price: 9.99, interval: 'monthly' },
          { id: 'pro', name: 'Pro', price: 19.99, interval: 'monthly', popular: true },
        ]}
      />
      <PaymentButton amount={9.99} description="One-time purchase" />
      <SubscriptionButton
        amount={15.99}
        interval="monthly"
        description="Premium Plan"
      />
    </P01Provider>
  );
}
```

### Service Registry

```typescript
import { ServiceRegistry, detectService, isVerifiedService } from 'p-01/registry';

// Detect a known service by domain
const service = detectService('netflix.com');
// => { name: 'Netflix', category: 'streaming', verified: true, ... }

// Verify a service
const verified = isVerifiedService('spotify.com'); // true
```

## API Reference

### Protocol01 (Main Client)

| Method | Description |
|---|---|
| `constructor(config: MerchantConfig)` | Create with merchant configuration |
| `static isInstalled()` | Check if a compatible wallet is installed |
| `static waitForInstall(timeout?)` | Wait for wallet availability |
| `static getInstallUrl()` | Get the wallet install URL |
| `connect()` | Connect to the user's wallet |
| `disconnect()` | Disconnect from the wallet |
| `isConnected()` | Check connection status |
| `getPublicKey()` | Get the connected wallet's public key |
| `getWalletInfo()` | Get wallet features and metadata |
| `requestPayment(options)` | Request a one-time payment |
| `createSubscription(options)` | Create a Stream Secure subscription |
| `getSubscriptions()` | Get all subscriptions with this merchant |
| `getSubscription(id)` | Get a specific subscription by ID |
| `cancelSubscription(id)` | Cancel a subscription |
| `on(event, callback)` | Subscribe to events (returns unsubscribe function) |
| `off(event, callback)` | Unsubscribe from events |
| `getMerchantConfig()` | Get the current merchant configuration |
| `updateConfig(updates)` | Update merchant configuration |

### React Components

| Export | Description |
|---|---|
| `P01Provider` | Context provider wrapping your app |
| `useP01()` | Access the Protocol01 client instance |
| `useP01Wallet()` | Access wallet connection state |
| `WalletButton` | Connect/disconnect wallet button |
| `PaymentButton` | One-click payment button |
| `SubscriptionButton` | Subscription creation button |
| `SubscriptionWidget` | Full pricing tier widget with plan selection |
| `SubscriptionCard` | Single subscription card display |

### Utilities

| Export | Description |
|---|---|
| `resolveTokenMint(symbol, network)` | Resolve a token symbol to its mint address |
| `toRawAmount(amount, mint, network)` | Convert a display amount to raw token units |
| `fromRawAmount(raw, mint, network)` | Convert raw token units to display amount |
| `formatAmount(amount)` | Format an amount for display |
| `validateAmount(amount)` | Validate a payment amount |
| `validateMerchantConfig(config)` | Validate merchant configuration |
| `generateId()` | Generate a unique identifier |
| `detectService(origin)` | Detect a known service from a URL or domain |
| `isVerifiedService(origin)` | Check if a domain is a verified service |
| `searchServices(query)` | Search the service registry by name |
| `getServicesByCategory(category)` | Get services filtered by category |

### Security Module

| Export | Description |
|---|---|
| `SecurityManager` | Orchestrates stealth addresses, encryption, and confidential transactions |
| `StealthKeyPair` / `StealthAddress` | Stealth address types |
| `EncryptedPayload` | End-to-end encrypted payload type |
| `ConfidentialAmount` | Confidential transaction amount type |

### Key Types

- `MerchantConfig` -- Merchant setup (merchantId, merchantName, webhookUrl, defaultToken, network)
- `PaymentRequestOptions` -- Payment parameters (amount, token, description, orderId)
- `PaymentResult` -- Payment result with transaction signature
- `SubscriptionOptions` -- Subscription parameters (amount, interval, maxPayments, suggestedPrivacy)
- `SubscriptionResult` -- Result with subscriptionId
- `Protocol01Error` / `Protocol01ErrorCode` -- Structured error types

## License

MIT
