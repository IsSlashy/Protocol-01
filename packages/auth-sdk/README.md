# @p01/auth-sdk

Authentication SDK for "Login with Protocol 01". Users scan a QR code with the P01 mobile app, confirm with biometrics, and authenticate using their blockchain wallet and subscription status. Includes both a client SDK (for frontends) and a server SDK (for backend verification).

## Installation

```bash
npm install @p01/auth-sdk @solana/web3.js
```

## Quick Start

### Client Side (Frontend)

```typescript
import { P01AuthClient } from '@p01/auth-sdk/client';

const auth = new P01AuthClient({
  serviceId: 'my-service',
  serviceName: 'My Streaming Service',
  callbackUrl: 'https://myservice.com/auth/callback',
  logoUrl: 'https://myservice.com/logo.png',
  subscriptionMint: 'SUBSxxxx...', // Optional: require active subscription
  sessionTtl: 300_000, // 5 minutes
});

// Create a login session with QR code
const session = await auth.createSession();

// Display the QR code in your UI
document.getElementById('qr').innerHTML = session.qrCodeSvg;
// Or use as an image: <img src={session.qrCodeDataUrl} />

// Wait for the user to scan and confirm
const result = await auth.waitForCompletion(session.sessionId, {
  pollInterval: 2000,
  timeout: 300_000,
});

if (result.success) {
  console.log('Authenticated wallet:', result.wallet);
  console.log('Subscription active:', result.subscriptionActive);
}

// Listen for session events
const unsubscribe = auth.onSessionEvent(session.sessionId, (event) => {
  if (event.type === 'session_completed') {
    console.log('Login successful:', event.wallet);
  }
});
```

### Server Side (Backend)

```typescript
import { P01AuthServer } from '@p01/auth-sdk/server';

const auth = new P01AuthServer({
  serviceId: 'my-service',
  subscriptionMint: 'SUBSxxxx...', // Optional
  rpcUrl: 'https://api.mainnet-beta.solana.com',
  maxTimestampAge: 60_000, // 60 seconds
});

// In your callback endpoint (Express/Fastify)
app.post('/auth/callback', async (req, res) => {
  const result = await auth.verifyCallback(req.body);

  if (result.success) {
    // Create a session for the authenticated user
    req.session.wallet = result.wallet;
    req.session.subscriptionActive = result.subscriptionActive;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: result.error });
  }
});

// Or use as Express middleware
app.use(auth.middleware());
// Adds req.p01Auth = { wallet, subscriptionActive } when valid

// Direct subscription check
const status = await auth.checkSubscription('wallet_address');
console.log('Active:', status.active, 'Balance:', status.balance);
```

## API Reference

### P01AuthClient (Frontend)

| Method | Description |
|---|---|
| `constructor(config: P01AuthClientConfig)` | Create a client with service configuration |
| `createSession(options?)` | Create a new auth session with QR code (returns sessionId, qrCodeSvg, qrCodeDataUrl, deepLink, expiresAt) |
| `getSession(sessionId)` | Get a session by ID |
| `updateSession(sessionId, updates)` | Update session status |
| `handleCallback(body)` | Process the auth callback from the mobile app |
| `waitForCompletion(sessionId, options?)` | Poll or wait for session completion |
| `onSessionEvent(sessionId, callback)` | Subscribe to session events (returns unsubscribe function) |
| `cancelSession(sessionId)` | Cancel and clean up a session |

### P01AuthServer (Backend)

| Method | Description |
|---|---|
| `constructor(config: P01AuthServerConfig)` | Create with service ID, subscription mint, and RPC URL |
| `verifyCallback(response, session?)` | Verify an authentication callback |
| `verifySignature(response, challenge?)` | Verify a wallet signature |
| `verifySubscription(wallet, proof?)` | Verify on-chain subscription status |
| `validateSubscriptionProof(proof)` | Validate a subscription proof structure |
| `middleware()` | Express/Fastify middleware for auth header verification |
| `checkSubscription(wallet)` | Directly check if a wallet has an active subscription |

### Auth Flow Types

- `AuthSession` -- Session state (sessionId, challenge, status, walletAddress, signature)
- `SessionStatus` -- `'pending' | 'scanned' | 'confirmed' | 'completed' | 'expired' | 'rejected' | 'failed'`
- `AuthQRPayload` -- QR code payload (protocol version, service, session, challenge, callback)
- `AuthResponse` -- Response from the mobile app (wallet, signature, publicKey, subscriptionProof)
- `VerificationResult` -- Verification outcome (success, wallet, subscriptionActive, error)
- `SubscriptionProof` -- On-chain subscription proof (mint, balance, expiresAt, slot)
- `AuthEvent` -- Session lifecycle events

### Sub-path Imports

```typescript
import { P01AuthClient } from '@p01/auth-sdk/client';
import { P01AuthServer } from '@p01/auth-sdk/server';
```

## License

MIT
