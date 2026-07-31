# Protocol 01 — Merchant Quickstart (5 minutes)

Two integration paths. Pick one or use both.

| Goal | Use | Time to first payment |
|---|---|---|
| Drop-in pay button on your existing site | `@protocol-01/p01-js` | ~5 min |
| Subscription backend (recurring billing, vault subscribers, access tokens) | `@protocol-01/merchant-sdk` | ~15 min |
| Authenticate users by wallet + active subscription | `@protocol-01/auth-sdk` | ~10 min |

All three packages are framework-agnostic and run on Node 22+, Next.js routes, Cloudflare Workers, Deno.

---

## Path A — Drop-in pay button (vanilla JS / React)

Install:

```bash
npm install @protocol-01/p01-js
```

Vanilla JS:

```html
<script type="module">
  import { Protocol01 } from '@protocol-01/p01-js';

  const p01 = new Protocol01({
    merchantId: 'acme-store',
    merchantName: 'Acme Store',
    defaultToken: 'USDC',
    network: 'devnet',
  });

  document.querySelector('#pay').addEventListener('click', async () => {
    await p01.connect();
    const result = await p01.requestPayment({
      amount: 9.99,
      description: 'Premium plan',
      orderId: 'order-123',
    });
    console.log('paid:', result.signature);
  });
</script>
<button id="pay">Pay 9.99 USDC privately</button>
```

React:

```tsx
import { P01Provider, PaymentButton, SubscriptionWidget } from '@protocol-01/p01-js/react';

export default function Pricing() {
  return (
    <P01Provider config={{ merchantId: 'acme-store', merchantName: 'Acme Store', network: 'devnet' }}>
      <PaymentButton amount={9.99} description="Premium plan" />
      <SubscriptionWidget
        tiers={[
          { id: 'pro', name: 'Pro', price: 19.99, interval: 'monthly', popular: true },
        ]}
      />
    </P01Provider>
  );
}
```

That's the whole frontend. The Protocol 01 mobile/extension wallet handles the privacy layer — you receive the payment signature, the user's privacy is preserved, and your business never sees the buyer's wallet history.

---

## Path B — Subscription backend (recurring billing + access tokens)

Install:

```bash
npm install @protocol-01/merchant-sdk @solana/web3.js
```

Three things, one file:

```typescript
import { Connection, Keypair, SystemProgram } from '@solana/web3.js';
import {
  registerServiceOnChain,
  pollPaymentsForRetailer,
  deriveSubscriptionVaultPda,
  hasActiveVaultAccessForVault,
  issueAccessToken,
  verifyAccessToken,
  NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

const connection = new Connection('https://api.devnet.solana.com', 'confirmed');
const merchantKp = Keypair.fromSecretKey(/* your hot wallet */);
const retailer   = merchantKp.publicKey; // wallet that receives the funds

// 1. Register your service once. Idempotent.
await registerServiceOnChain(connection, merchantKp, {
  slug:           'acme-pro',
  name:           'Acme — Pro',
  iconKey:        'chatgpt',
  category:       'saas',
  metadataUri:    'https://acme.example/p01/service.json',
  retailer,
  tokenMint:      NATIVE_SOL_MINT,   // or a USDC SPL mint
  priceAtomic:    50_000_000n,       // 0.05 SOL per period
  intervalSlots:  6_480_000n,        // ~30 days at 0.4s/slot
  supportsOneshot: true,
  supportsVault:   true,
  skipIfExists:    true,
});

// 2. Poll for payments. Run on a 30s interval (cron, setInterval, queue worker).
const receipts = await pollPaymentsForRetailer(connection, retailer, {
  slugFilter: 'acme-pro',
  limit: 25,
});
for (const r of receipts) {
  // Grant access; the memo `r.memo?.slug` ties the payment to your service.
}

// 3. Vault subscribers (recurring private subscriptions). Check the ONE vault
//    the request is about — derive its address from things you already know.
const [vaultPda] = deriveSubscriptionVaultPda(
  retailer,
  subscriberIdBytes,   // 32 bytes: wallet pubkey (normal) or commitment (private)
  NATIVE_SOL_MINT,
);
const vault = await hasActiveVaultAccessForVault(
  connection, vaultPda, retailer, subscriberIdBytes,
  // ALWAYS pass `service`. Anyone can create a vault naming you as retailer for
  // one lamport at a rate they choose; the scope is what checks it against the
  // price and interval YOU registered. See the merchant-sdk README, section 3.
  { service: { retailer, tokenMint: NATIVE_SOL_MINT, priceAtomic: 50_000_000n, intervalSlots: 6_480_000n } },
);
if (!vault) return; // no current subscription — do not serve
// `vault.subscriberCommitment` is non-null when the subscription is private (ZK).
//
// `listVaultsForRetailer` still returns your whole subscriber book for
// reconciliation, on a timer. It is deprecated for per-request checks: it
// hydrates every subscriber to answer a question about one of them.

// 4. Issue a session token your frontend stores. No DB required.
const token = issueAccessToken({
  merchantKeypair: merchantKp,
  subscriberId:    'user-42',
  serviceSlug:     'acme-pro',
  ttlSeconds:      60 * 60,
});
// Later, on an API route:
const { valid, claims } = verifyAccessToken(token, merchantKp.publicKey);
```

A complete runnable end-to-end demo lives at [`examples/merchant-netflix`](../examples/merchant-netflix/).

---

## Path C — Login with Protocol 01 (optional)

Install:

```bash
npm install @protocol-01/auth-sdk @solana/web3.js
```

Frontend:

```typescript
import { P01AuthClient } from '@protocol-01/auth-sdk/client';

const auth = new P01AuthClient({
  serviceId:   'acme-store',
  serviceName: 'Acme Store',
  callbackUrl: 'https://acme.example/auth/callback',
});

const session = await auth.createSession();
document.getElementById('qr').innerHTML = session.qrCodeSvg;
const result = await auth.waitForCompletion(session.sessionId);
// result.wallet, result.subscriptionActive
```

Backend:

```typescript
import { P01AuthServer } from '@protocol-01/auth-sdk/server';

const auth = new P01AuthServer({
  serviceId:        'acme-store',
  network:          'devnet',
  subscriptionMint: 'SUBSxxxx...',  // optional — gate by active subscription
});

app.post('/auth/callback', async (req, res) => {
  const r = await auth.verifyCallback(req.body);
  if (!r.success) return res.status(401).json({ error: r.error });
  res.json({ wallet: r.wallet, subscriptionActive: r.subscriptionActive });
});
```

---

## Devnet test checklist

Before pitching a customer:

1. `solana airdrop 2 --url devnet` — fund your merchant signer.
2. Register the service (Path B step 1) and confirm the PDA address printed in the result.
3. Open the Protocol 01 mobile app on devnet, go to **Streams** tab — your service should appear in the merchant list within ~10 minutes (SWR cache).
4. From the app: **Subscribe Private** → you'll see your service flow into `pollPaymentsForRetailer` (Path B step 2) within one block.
5. From the app: **Cancel** → confirm `listVaultsForRetailer` reflects the change.

If a step fails, check that:
- Your `tokenMint` matches what the app is configured to send (native SOL = `SystemProgram.programId`).
- Your RPC endpoint is reachable (`devnet.helius-rpc.com` recommended over the public devnet).
- Your `priceAtomic` is in the smallest unit of `tokenMint` (lamports for SOL, USDC base units etc.).

---

## What the user actually sees

- **Their wallet history stays opaque** to your backend and to chain analytics — the payment lands at a stealth address.
- **You receive native SOL or USDC** in the retailer wallet — no token swaps, no custody changes.
- **The notes are quantum-proof**: STARK-based, hash-only, no trusted setup, no elliptic-curve-only security.

You consume payments like any normal Solana stream. The privacy layer is below you.

---

## Where to go next

| You want | Read |
|---|---|
| Full SDK API surfaces | [`packages/merchant-sdk/README.md`](../packages/merchant-sdk/README.md), [`packages/p01-js/README.md`](../packages/p01-js/README.md), [`packages/auth-sdk/README.md`](../packages/auth-sdk/README.md) |
| Lower-level primitives (stealth, shielded pool, MPC) | [`packages/privacy-sdk/README.md`](../packages/privacy-sdk/README.md) |
| End-to-end runnable example | [`examples/merchant-netflix/`](../examples/merchant-netflix/) |
| Chain layout (programs, deployed addresses) | [`README.md`](../README.md) |
| Privacy/security model | [`docs/security-model.md`](./security-model.md) |
