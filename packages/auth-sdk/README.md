# @protocol-01/auth-sdk

Authentication SDK for "Login with Protocol 01". Users scan a QR code with the P01 mobile app, confirm with biometrics, and authenticate using their blockchain wallet and subscription status. Includes both a client SDK (for frontends) and a server SDK (for backend verification).

## Installation

```bash
npm install @protocol-01/auth-sdk @solana/web3.js
```

## Quick Start

### Client Side (Frontend)

```typescript
import { P01AuthClient } from '@protocol-01/auth-sdk/client';

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
import { P01AuthServer } from '@protocol-01/auth-sdk/server';

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

## Devnet Testing

Use the `network` shorthand to connect to devnet without looking up the RPC URL:

```typescript
import { P01AuthServer } from '@protocol-01/auth-sdk/server';

const auth = new P01AuthServer({
  serviceId: 'my-service',
  network: 'devnet', // auto-selects https://api.devnet.solana.com
});
```

Or pass the URL explicitly:

```typescript
const auth = new P01AuthServer({
  serviceId: 'my-service',
  rpcUrl: 'https://api.devnet.solana.com',
});
```

Available networks: `'mainnet-beta'`, `'devnet'`, `'testnet'`, `'localnet'`.

## Production Deployment

### Custom Session Storage

The server has **no default session store**. Without a `sessionStore` (and without a `session` passed to `verifyCallback`), the server has no session to check: it never returns `"Session not found"` or `"Session expired"`, and one signed callback verifies again and again within `maxTimestampAge` (a replay). Provide a persistent store via `sessionStore` (server) or `sessionStorage` (client), and set `requireSession: true` so that a callback with no session to check is refused (`"Session not found"`) instead of verified. `requireSession` defaults to `false` only to keep existing integrations working (audit v1 F78):

```typescript
import { createClient } from 'redis';
import { P01AuthServer, type ServerSessionStore } from '@protocol-01/auth-sdk/server';

const redis = createClient();
await redis.connect();

const sessionStore: ServerSessionStore = {
  async get(sessionId) {
    const data = await redis.get(`p01:session:${sessionId}`);
    return data ? JSON.parse(data) : null;
  },
  async set(session) {
    const ttl = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    await redis.set(
      `p01:session:${session.sessionId}`,
      JSON.stringify(session),
      { EX: ttl }
    );
  },
  async delete(sessionId) {
    await redis.del(`p01:session:${sessionId}`);
  },
};

const auth = new P01AuthServer({
  serviceId: 'my-service',
  sessionStore,
  requireSession: true, // refuse a callback that has no session to check
});
```

### HTTPS Requirement

Auth callbacks contain wallet signatures. Always serve your callback endpoint over HTTPS in production. The `x-p01-auth` header used by the middleware is base64-encoded -- HTTPS ensures it cannot be intercepted.

### CORS Setup

If your frontend and backend are on different origins, configure CORS to allow the callback:

```typescript
import cors from 'cors';

app.use(cors({
  origin: ['https://myservice.com'],
  methods: ['POST'],
  allowedHeaders: ['Content-Type', 'x-p01-auth'],
}));
```

### Complete Express.js Example

```typescript
import express from 'express';
import cors from 'cors';
import { P01AuthServer } from '@protocol-01/auth-sdk/server';

const app = express();
app.use(express.json());
app.use(cors({
  origin: ['https://myservice.com'],
  allowedHeaders: ['Content-Type', 'x-p01-auth'],
}));

const auth = new P01AuthServer({
  serviceId: 'my-service',
  subscriptionMint: 'SUBSxxxx...',
  network: 'mainnet-beta',
  maxTimestampAge: 60_000,
});

// Option 1: Explicit callback endpoint
app.post('/auth/callback', async (req, res) => {
  const result = await auth.verifyCallback(req.body);
  if (result.success) {
    // Issue your own session token / JWT here
    res.json({ token: createJwt(result.wallet!), wallet: result.wallet });
  } else {
    res.status(401).json({ error: result.error });
  }
});

// Option 2: Middleware on protected routes
app.use('/api', auth.middleware());

app.get('/api/profile', (req, res) => {
  if (!req.p01Auth) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  res.json({ wallet: req.p01Auth.wallet });
});

app.listen(3000);
```

## Error Handling

`verifyCallback()` never throws. It returns `{ success: false, error: string }` on failure. Common errors:

| Error | Cause | Fix |
|---|---|---|
| `"Timestamp expired or invalid"` | Auth response is older than `maxTimestampAge` (default 60s) | Ensure client and server clocks are roughly synced. Increase `maxTimestampAge` if needed. |
| `"Invalid signature"` | Ed25519 signature does not match the challenge | The signing wallet does not match `publicKey`, or the challenge was tampered with. |
| `"Subscription not active"` | Wallet does not hold the required SPL token | User needs to purchase/renew their subscription token. |
| `"Session not found"` | Session ID does not exist in the `sessionStore` (or differs from the `session` passed), or `requireSession: true` and there is no session to check. Never returned without a `sessionStore`, a `session` or `requireSession`. | Session may have expired or been cancelled. Create a new session. |
| `"Session expired"` | Session TTL has elapsed. Only checked with a `sessionStore` or a `session` passed. | Default TTL is 5 minutes. User needs to scan a fresh QR code. |
| `"Session already completed"` | The session in the `sessionStore` was already verified once (a replay). | Create a new session. |
| `"Invalid callback: missing required fields ..."` | Callback body is missing `sessionId`, `wallet`, `signature`, or `publicKey` | Ensure the mobile app is sending the complete `AuthResponse` object. |

Network errors during on-chain subscription verification are caught internally and result in `"Subscription not active"`. Check your RPC URL if verification consistently fails.

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
| `constructor(config: P01AuthServerConfig)` | Create with service ID, subscription mint, and RPC URL or network |
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
- `SolanaNetwork` -- `'mainnet-beta' | 'devnet' | 'testnet' | 'localnet'`

### Sub-path Imports

```typescript
import { P01AuthClient } from '@protocol-01/auth-sdk/client';
import { P01AuthServer } from '@protocol-01/auth-sdk/server';
```

## License

PolyForm Strict License 1.0.0 — see [LICENSE](LICENSE). The package is
source-available: anyone may read, build, run and verify it for noncommercial
purposes. Commercial use (including production deployment by a business),
changes or derivative works, and redistribution need a written license from
Volta Team ([styx.cash/licenses](https://styx.cash/licenses)).
PolyForm Strict is not an open-source license.

The versions already published to npm (0.1.0 to 0.1.1) were released under the
MIT License and remain MIT, as does every commit of this repository before the
one that replaced the MIT License with PolyForm Strict
([LICENSE-MIT-BEFORE-POLYFORM](../../LICENSE-MIT-BEFORE-POLYFORM)). Versions
published from 2026-09-22 on ship under PolyForm Strict 1.0.0.
