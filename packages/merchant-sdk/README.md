# @protocol-01/merchant-sdk

Server-side SDK for merchants integrating Protocol 01 subscriptions on Solana.

Register a service on-chain, detect incoming ZK payments, watch private subscription vaults, and issue signed access tokens — all framework-agnostic (Node.js, Next.js routes, Cloudflare Workers, Deno).

## Installation

```bash
npm install @protocol-01/merchant-sdk @solana/web3.js
# or
pnpm add @protocol-01/merchant-sdk @solana/web3.js
```

Requires Node.js >= 22.

## Quick start

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import {
  registerServiceOnChain,
  fetchService,
  pollPaymentsForRetailer,
  listVaultsForRetailer,
  issueAccessToken,
  verifyAccessToken,
  NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

const connection = new Connection('https://api.devnet.solana.com');
const merchantKp = Keypair.fromSecretKey(/* … */);
```

### 1. Register your service on-chain

Writes a `ServiceRegistry` PDA so every Protocol 01 client (mobile, extension, web) picks your service up automatically in the subscription UI.

```typescript
await registerServiceOnChain(connection, merchantKp, {
  slug: 'my-saas-pro',              // unique per owner, max 32 bytes, URL-safe
  name: 'My SaaS — Pro',            // display name
  iconKey: 'chatgpt',               // app maps this to an Ionicons glyph
  category: 'saas',
  metadataUri: 'https://my-saas.example/service.json',
  retailer: merchantKp.publicKey,   // who receives payments (can differ from owner)
  tokenMint: NATIVE_SOL_MINT,       // or an SPL mint (e.g. USDC) — required
  priceAtomic: 50_000_000n,         // 0.05 SOL in lamports (per billing period)
  intervalSlots: 6_480_000n,        // ≈ 30 days at 0.4 s/slot
  supportsOneshot: true,            // accepts single unshield payments
  supportsVault: true,              // accepts recurring subscription vaults
  skipIfExists: true,               // idempotent boot — don't re-register
});
```

The entry starts **unverified**. To be shown in the default client feed, ask the Protocol 01 team to attest it (`attest_service`) or call `buildAttestServiceIx` yourself if you hold the protocol authority key.

### 2. Poll for incoming one-shot payments

Subscribers can pay with a single ZK unshield — the client embeds an invoice memo `p01:<slug>:<periods>m` in the tx. The SDK parses every signature to the retailer and returns matching receipts.

```typescript
const receipts = await pollPaymentsForRetailer(connection, merchantKp.publicKey, {
  slugFilter: 'my-saas-pro',
  limit: 50,
});

for (const r of receipts) {
  console.log(`${r.signature.slice(0,8)}… +${r.sol} SOL — memo ${r.memo?.raw}`);
  // r.memo?.slug   → service slug ("my-saas-pro")
  // r.memo?.extras → optional [periods, nonce, ...] suffix the client tagged
  // → grant access for the configured intervalDays * (extras[0] ?? 1)
}
```

### 3. Watch recurring subscription vaults

Users who subscribe via the vault flow lock a shielded note and let the retailer pull at every billing period.

```typescript
const vaults = await listVaultsForRetailer(connection, merchantKp.publicKey, {
  includePaused: true,
});

for (const v of vaults) {
  console.log(
    `vault ${v.pda.toBase58().slice(0,12)}… ` +
    `rate=${Number(v.rate) / 1e9} SOL ` +
    `paused=${v.isPaused} private=${v.subscriberCommitment !== null}`,
  );
}
```

### 4. Issue signed access tokens

Minimal JWS-style token signed with the merchant Ed25519 key. Clients store it, send it back on each API call, and the server verifies in-memory — no session DB required.

```typescript
const token = issueAccessToken({
  merchantKeypair: merchantKp,
  subscriberId: 'user-42',
  serviceSlug: 'my-saas-pro',
  ttlSeconds: 60 * 60,          // 1 hour
  extraClaims: { tier: 'pro' },
});

// later, on an API route:
const result = verifyAccessToken(token, merchantKp.publicKey);
if (!result.valid) return Response.json({ error: result.reason }, { status: 401 });
// result.claims.sub / .svc / .tier / .exp
```

## API surface

```
// Registration (server-side, signs as the merchant)
registerServiceOnChain(connection, kp, config)        → MerchantRegistrationResult
updateServiceOnChain(connection, kp, args)            → TxSig
deregisterServiceOnChain(connection, kp, slug)        → TxSig
getRegisteredService(connection, ownerPubkey, slug)   → ServiceEntry | null

// Read (any caller)
fetchService(connection, owner, slug)                 → ServiceEntry | null
fetchServiceByPda(connection, pda)                    → ServiceEntry | null
fetchAllServices(connection, opts?)                   → ServiceEntry[]

// Payments + vaults
verifyOneShotPayment(connection, signature, opts?)    → PaymentReceipt | null
pollPaymentsForRetailer(connection, retailer, opts?)  → PaymentReceipt[]
parseInvoiceMemo(memo)                                → ParsedInvoiceMemo | null
listVaultsForRetailer(connection, retailer, opts?)    → SubscriptionVaultAccount[]
hasActiveVaultAccess(connection, retailer, subscriber)→ boolean

// Access tokens (Ed25519-signed, no DB required)
issueAccessToken(opts)                                → string
verifyAccessToken(token, merchantPubkey)              → { valid, claims?, reason? }
```

Instruction builders (`buildRegisterServiceIx`, `buildAttestServiceIx`, etc.) are re-exported from `@protocol-01/specter-sdk` for callers that need to assemble custom transactions.

## Design

- **Framework-agnostic.** No wallet adapter dependency; callers bring a `Keypair` or a `signTransaction` callback.
- **No side effects at import.** Connecting to an RPC is always explicit.
- **No server state required.** Access tokens are self-contained + signed — verify them anywhere.

## Example: complete Netflix-style integration

See [`examples/merchant-netflix`](../../examples/merchant-netflix/) in the repo for a runnable end-to-end script (register → poll payments → issue token → verify).

## License

Proprietary — see [LICENSE](../../LICENSE).
