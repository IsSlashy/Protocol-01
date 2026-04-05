# @protocol-01/p01-js

Merchant SDK for integrating Protocol 01 privacy-first crypto payments and Stream Secure subscriptions. Includes a vanilla JavaScript client, React components, a service registry, and built-in security primitives.

## Installation

```bash
npm install @protocol-01/p01-js
```

For React components, `react >= 17.0.0` is required as a peer dependency.

## Requirements

- **Protocol 01 wallet extension** -- Required for payments and subscriptions. [Install here](https://protocol01.com/wallet).
- **Node.js >= 22** -- The SDK uses modern JS features.
- **Solana network** -- Operates on `mainnet-beta` (default) or `devnet`.

> Without the wallet extension, you can still develop and test your integration using the built-in mock provider (see [Testing Without Wallet](#testing-without-wallet) below).

## Quick Start

### Vanilla JavaScript

```typescript
import { Protocol01 } from '@protocol-01/p01-js';

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
} from '@protocol-01/p01-js/react';

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
import { ServiceRegistry, detectService, isVerifiedService } from '@protocol-01/p01-js/registry';

// Detect a known service by domain
const service = detectService('netflix.com');
// => { name: 'Netflix', category: 'streaming', verified: true, ... }

// Verify a service
const verified = isVerifiedService('spotify.com'); // true

// Register your own service
ServiceRegistry.register({
  domain: 'mystreaming.com',
  name: 'My Streaming',
  logo: 'https://mystreaming.com/logo.png',
  category: 'streaming',
  description: 'My streaming platform',
  website: 'https://mystreaming.com',
  commonAmounts: [9.99, 14.99],
  defaultToken: 'USDC',
});
```

## Testing Without Wallet

During development, you can use the mock provider to test your integration logic without installing the wallet extension. Every method on the mock provider throws an informative error, letting you exercise your error-handling paths.

```typescript
import { Protocol01 } from '@protocol-01/p01-js';

// Check if the wallet extension is installed
if (!Protocol01.isInstalled()) {
  console.log('Wallet not installed, using mock for development');
  const mock = Protocol01.createMockProvider();

  try {
    await mock.connect();
  } catch (error) {
    // Protocol01Error: "Mock provider: connect not available.
    //   Install Protocol 01 wallet extension at https://protocol01.com/wallet
    //   for real transactions."
    console.log('Expected mock error:', error.message);
  }
}

// You can also wait for the wallet to appear (useful for async extension loading)
const installed = await Protocol01.waitForInstall(5000);
if (!installed) {
  console.log('Install at:', Protocol01.getInstallUrl());
}
```

## Error Handling

All SDK errors are instances of `Protocol01Error` with a `code` property for programmatic handling.

```typescript
import { Protocol01, Protocol01Error, Protocol01ErrorCode } from '@protocol-01/p01-js';

const p01 = new Protocol01({
  merchantId: 'my-app',
  merchantName: 'My App',
});

try {
  await p01.connect();
} catch (error) {
  if (error instanceof Protocol01Error) {
    switch (error.code) {
      case Protocol01ErrorCode.WALLET_NOT_INSTALLED:
        // Show install prompt with error.message (includes install URL)
        showInstallPrompt(Protocol01.getInstallUrl());
        break;
      case Protocol01ErrorCode.CONNECTION_REJECTED:
        // User clicked "reject" in the wallet popup
        showMessage('Connection was declined. Please try again.');
        break;
      case Protocol01ErrorCode.CONNECTION_TIMEOUT:
        showMessage('Connection timed out. Please check your wallet.');
        break;
      default:
        console.error('Unexpected error:', error.toJSON());
    }
  }
}

try {
  const payment = await p01.requestPayment({ amount: 10, description: 'Test' });
} catch (error) {
  if (error instanceof Protocol01Error) {
    switch (error.code) {
      case Protocol01ErrorCode.WALLET_NOT_CONNECTED:
        // Forgot to call connect() first
        await p01.connect();
        break;
      case Protocol01ErrorCode.PAYMENT_REJECTED:
        // User rejected the payment
        showMessage('Payment was declined.');
        break;
      case Protocol01ErrorCode.INSUFFICIENT_FUNDS:
        showMessage('Insufficient balance.');
        break;
      case Protocol01ErrorCode.PAYMENT_FAILED:
        // Transaction failed on-chain
        console.error('TX failed:', error.details);
        break;
      case Protocol01ErrorCode.TIMEOUT:
        showMessage('Payment timed out. Please try again.');
        break;
    }

    // All Protocol01Errors have a .recoverable flag
    if (error.recoverable) {
      showRetryButton();
    }
  }
}
```

## Network Switching

The SDK operates on `mainnet-beta` by default. Set the network at construction time:

```typescript
// Devnet for testing
const p01 = new Protocol01({
  merchantId: 'my-app',
  merchantName: 'My App',
  network: 'devnet',
});

// Mainnet for production
const p01Prod = new Protocol01({
  merchantId: 'my-app',
  merchantName: 'My App',
  network: 'mainnet-beta',
});

// Custom RPC endpoint
const p01Custom = new Protocol01({
  merchantId: 'my-app',
  merchantName: 'My App',
  network: 'mainnet-beta',
  rpcEndpoint: 'https://your-rpc.example.com',
});
```

Token mint addresses resolve automatically based on the network. For example, `'USDC'` maps to the mainnet USDC mint on `mainnet-beta` and the devnet USDC mint on `devnet`.

## URL Configuration

By default, the SDK uses Protocol 01's hosted infrastructure. You can override the URLs globally before creating instances:

```typescript
import { Protocol01 } from '@protocol-01/p01-js';

Protocol01.configure({
  walletUrl: 'https://my-domain.com/wallet',
  apiUrl: 'https://api.my-domain.com',
  apiDevnetUrl: 'https://api-devnet.my-domain.com',
  docsUrl: 'https://docs.my-domain.com',
});

// All instances created after this will use the custom URLs
const p01 = new Protocol01({ merchantId: 'my-app', merchantName: 'My App' });
```

## Webhook Integration

When you provide a `webhookUrl` in your merchant config, Protocol 01 sends `POST` requests to that URL for payment and subscription lifecycle events.

### Webhook Event Types

| Event | Description | Payload Data |
|---|---|---|
| `payment.completed` | One-time payment confirmed on-chain | `PaymentResult` |
| `payment.failed` | Payment transaction failed | `PaymentResult` (partial) |
| `subscription.created` | New subscription created | `Subscription` |
| `subscription.payment` | Recurring subscription payment made | `Subscription` |
| `subscription.cancelled` | Subscription cancelled by user | `Subscription` |
| `subscription.expired` | Subscription reached max payments | `Subscription` |

### Webhook Payload Structure

```typescript
interface WebhookPayload {
  event: WebhookEventType;      // e.g., 'payment.completed'
  merchantId: string;            // Your merchant ID
  timestamp: number;             // Unix ms
  signature: string;             // HMAC signature for verification
  data: PaymentResult | Subscription;
}
```

### Server-Side Handler Example

```typescript
app.post('/p01/webhook', (req, res) => {
  const payload: WebhookPayload = req.body;

  // Verify the signature before processing
  // (signature verification details in full docs)

  switch (payload.event) {
    case 'payment.completed':
      fulfillOrder(payload.data as PaymentResult);
      break;
    case 'subscription.created':
      activateSubscription(payload.data as Subscription);
      break;
    case 'subscription.cancelled':
      deactivateSubscription(payload.data as Subscription);
      break;
  }

  res.sendStatus(200);
});
```

## API Reference

### Protocol01 (Main Client)

| Method | Description |
|---|---|
| `constructor(config: MerchantConfig)` | Create with merchant configuration |
| `static isInstalled()` | Check if a compatible wallet is installed |
| `static waitForInstall(timeout?)` | Wait for wallet availability |
| `static getInstallUrl()` | Get the wallet install URL |
| `static configure(config)` | Override global URL configuration |
| `static getUrlConfig()` | Get the current URL configuration |
| `static createMockProvider()` | Create a mock provider for testing |
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

### Service Registry

| Method | Description |
|---|---|
| `ServiceRegistry.detect(origin)` | Detect a known service from URL or domain |
| `ServiceRegistry.isVerified(origin)` | Check if a domain is a verified service |
| `ServiceRegistry.getByCategory(cat)` | Get services filtered by category |
| `ServiceRegistry.search(query)` | Search services by name or description |
| `ServiceRegistry.register(entry)` | Register a custom service |
| `ServiceRegistry.unregister(domain)` | Remove a custom service |
| `ServiceRegistry.getAll()` | Get all services (built-in + custom) |

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
- `Protocol01UrlConfig` -- URL configuration overrides
- `ServiceEntry` -- Custom service registration entry
- `WebhookPayload` / `WebhookEventType` -- Webhook types

## License

MIT
