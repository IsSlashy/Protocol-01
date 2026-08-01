# @protocol-01/merchant-sdk

Server-side SDK for merchants integrating Protocol 01 subscriptions on Solana.

Register a service on-chain, detect incoming ZK payments, check a subscriber's
entitlement, collect the recurring revenue, and issue signed access tokens — all
framework-agnostic (Node.js, Next.js routes, Cloudflare Workers, Deno).

**If you are integrating today, read [section 3](#3-check-a-subscription-on-a-request--read-one-account) first.**
An entitlement check reads one account rather than your whole subscriber book
(which does not make that book private — see the note at the end of section 3),
and it does not trust the vault's `is_active` flag.

## Status

**This package is not yet published to npm.**

The programs are currently live on **devnet only** — mainnet deployment is pending.  Until both `@protocol-01/merchant-sdk` and its dependency `@protocol-01/specter-sdk` are published, use one of the two paths below to install:

### Option A — npm pack (recommended for integration testing)

```bash
# From the repo root
pnpm --filter @protocol-01/specter-sdk build
pnpm --filter @protocol-01/merchant-sdk build

cd packages/specter-sdk  && npm pack   # produces protocol-01-specter-sdk-*.tgz
cd packages/merchant-sdk && npm pack   # produces protocol-01-merchant-sdk-*.tgz

# In your project
npm install /path/to/protocol-01-specter-sdk-0.x.y.tgz \
            /path/to/protocol-01-merchant-sdk-0.x.y.tgz \
            @solana/web3.js
```

### Option B — workspace reference (monorepo consumers)

If your project is inside this monorepo (or a pnpm workspace that links to it):

```json
{
  "dependencies": {
    "@protocol-01/merchant-sdk": "workspace:*",
    "@protocol-01/specter-sdk":  "workspace:*"
  }
}
```

> Note: `@protocol-01/specter-sdk` must be published (or vendored) alongside
> merchant-sdk because it provides the on-chain instruction builders and account
> decoders for the service registry.  It is not bundled into merchant-sdk to
> avoid duplicating ~670 LOC that are also used by mobile and extension clients.

## Configuration

### RPC endpoint

**Never hardcode API keys.**  Pass the RPC URL via an environment variable:

```bash
# .env
RPC_URL=https://devnet.helius-rpc.com/?api-key=YOUR_KEY
```

```typescript
import { Connection } from '@solana/web3.js';

const connection = new Connection(
  process.env.RPC_URL ?? 'https://api.devnet.solana.com',
  'confirmed',
);
```

### Program IDs and cluster

By default the SDK targets **devnet**.  Use `MerchantSdkConfig` to point at
a different cluster or to override individual program IDs:

```typescript
import { type MerchantSdkConfig } from '@protocol-01/merchant-sdk';

// Devnet — default, no config needed.
const devnetConfig: MerchantSdkConfig = { cluster: 'devnet' };

// Mainnet — requires explicit program ID overrides until the programs ship.
const mainnetConfig: MerchantSdkConfig = {
  cluster: 'mainnet-beta',
  programIds: {
    zkShielded: new PublicKey('YOUR_MAINNET_ZK_SHIELDED_PROGRAM_ID'),
    registry:   new PublicKey('YOUR_MAINNET_REGISTRY_PROGRAM_ID'),
  },
};
```

Pass the config to any SDK function that accepts it:

```typescript
await registerServiceOnChain(connection, kp, { ...args, sdkConfig: mainnetConfig });
await hasActiveVaultAccessForVault(connection, vaultPda, retailer, subId, { sdkConfig: mainnetConfig });
await updateServiceOnChain(connection, kp, args, mainnetConfig);
await deregisterServiceOnChain(connection, kp, slug, mainnetConfig);
await getRegisteredService(connection, kp.publicKey, slug, mainnetConfig);
```

If you omit `sdkConfig` the devnet defaults apply, so existing code continues
to work unchanged.

## Quick start

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import {
  registerServiceOnChain,
  fetchService,
  pollPaymentsForRetailer,
  deriveSubscriptionVaultPda,
  hasActiveVaultAccessForVault,
  verifyLicenseAgainstVault,
  issueAccessToken,
  issueSubscriptionAccessToken,
  verifyAccessToken,
  subscriptionIsCurrent,
  NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

const connection = new Connection(
  process.env.RPC_URL ?? 'https://api.devnet.solana.com',
);
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
  intervalSlots: 6_480_000n,        // ~30 days at 0.4 s/slot
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
  console.log(`${r.signature.slice(0,8)}... +${r.sol} SOL — memo ${r.memo?.raw}`);
  // r.memo?.slug   -> service slug ("my-saas-pro")
  // r.memo?.extras -> optional [periods, nonce, ...] suffix the client tagged
  // grant access for the configured intervalDays * (extras[0] ?? 1)
}
```

### 3. Check a subscription on a request — read ONE account

Users who subscribe via the vault flow lock a shielded note and let the retailer
pull at every billing period. To decide whether to serve a request, read the one
vault that request is about.

You need the vault's address. Either the client presents it (it is in the
subscription receipt), or you derive it yourself from three things you already
know — the payout key you registered, the subscriber ID you have in session, and
your service's mint:

```typescript
import {
  deriveSubscriptionVaultPda,
  hasActiveVaultAccessForVault,
  NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

const [vaultPda] = deriveSubscriptionVaultPda(
  merchantKp.publicKey,   // retailer
  subscriberIdBytes,      // 32 bytes: wallet pubkey (normal) or commitment (private)
  NATIVE_SOL_MINT,        // the mint your service is priced in
);

const vault = await hasActiveVaultAccessForVault(
  connection,
  vaultPda,
  merchantKp.publicKey,
  subscriberIdBytes,
  { service: myServiceScope },  // optional but recommended — see below
);

if (!vault) return Response.json({ error: 'no current subscription' }, { status: 402 });
```

The same shape exists for license keys, when the subscriber authenticates with a
key instead of a session:

```typescript
const res = await verifyLicenseAgainstVault(
  connection, presentedKey, vaultPda, merchantKp.publicKey, 'my-saas-pro',
  { service: myServiceScope },
);
if (!res.valid) return Response.json({ error: res.reason }, { status: 401 });
```

**What "current" means.** Both functions gate on `subscriptionIsCurrent`, not on
the vault's `is_active` flag. The program writes `is_active = true` at subscribe
time and `false` nowhere, so a subscription that has spent every lamport it
deposited still reports `true` for ever. Measured on devnet 2026-08-01: of the 18
live subscription vaults, 14 had run past the periods they were funded for — and
all 18 reported `is_active: true`. `subscriptionIsCurrent` asks the only question
that has an answer: is the period we are in one the subscriber paid for?

**Pass a `service` scope. Not only if you sell more than one thing.** A vault
records no service ID — its address is `[retailer, subscriber, mint]` — and
subscribing is permissionless. `subscribe_private_stark`, now the only
instruction that can create a vault, declares the retailer as an unsigned
`AccountInfo` carrying `/// CHECK: Any pubkey can be a retailer`
(`subscribe_private_stark.rs:81-83`) and takes `rate` and `interval_slots`
straight from the instruction data, requiring only that each be greater than
zero (`:181-182`). So a stranger can have the program create a genuine vault, at
the canonical PDA, naming **you** as retailer, at a rate of one atomic unit per
period. That vault passes every check the SDK can make from the account alone —
owner, discriminator, retailer field, canonical PDA, subscriber ID,
`subscriptionIsCurrent` — because none of them is forged. The program wrote it.

Removing `subscribe_normal` raised the price of that from one lamport, and did
not close it. The deposit is no longer a caller-chosen `amount`: it is fixed to
the pool's denomination (`:187`, `:390`). But the attacker still picks the rate,
and a rate of 1 turns that denomination into `periodsPaidFor` — 100,000,000
periods for the 0.1 SOL pools live on devnet — so the vault reads "current" for
longer than the merchant will exist, and `cancel_private_stark` gives the
deposit back when the attacker is done with it.

The only thing that refuses it is `service`, because only the registry knows
what you charge. `ServiceScope` compares the vault's `rate` and `interval_slots`
against the price and interval your service registered; a rate of 1 fails on
price whatever interval it copies from you. Without a scope you are not checking
a subscription, you are checking that an account exists. (Pinned in
`src/self-minted-vault.test.ts`, both directions, for both the legacy
wallet-keyed shape and the commitment-keyed shape the surviving instruction
writes.)

Two products at the same price are a separate matter: if two of your services
agree on retailer, mint, price *and* interval, the chain cannot tell them apart
at all; `verifyLicenseAgainstVault` reports that as `ambiguousService: true`.
Give each product its own `retailer` key if you need them separated.

### 3b. Reconcile the whole book — on a schedule, not per request

`listVaultsForRetailer` returns every vault that pays you. It is deprecated for
entitlement checks and supported for reconciliation:

```typescript
// e.g. in a cron job, every 30–60s — not in a request handler.
const vaults = await listVaultsForRetailer(connection, merchantKp.publicKey, {
  includePaused: true,
});
```

Measured on devnet (2026-08-01), one entitlement check for one subscriber of a
merchant with 4 vaults:

| path | RPC calls | request B | response B | accounts returned |
|---|---|---|---|---|
| `hasActiveVaultAccessForVault` | 2 (`getAccountInfo`, `getSlot`) | 309 | 813 | 1 |
| `hasActiveVaultAccess` (enumerating) | 2 (`getProgramAccounts`, `getSlot`) | 492 | 2,750 | 4 |
| `verifyLicenseAgainstVault` | 2 | 309 | 813 | 1 |
| `verifyLicenseKey` (enumerating) | 2 | 492 | 2,750 | 4 |
| `fetchVaultByAddress` alone (you pass `currentSlot`) | 1 | 191 | 733 | 1 |

The call *count* is the same. What differs is the payload, and it grows with your
subscriber count (~650 response bytes each) rather than with the question asked.

> **This is not a privacy control.** Preferring the single-account path does not
> stop anyone enumerating your subscribers. `retailer` sits at a fixed offset in
> a public, unencrypted account, so the same `getProgramAccounts` runs from curl
> with no SDK involved — verified on devnet 2026-08-01, a raw JSON-RPC call
> filtered only on the account discriminator returned all 17 `SubscriptionVault`
> accounts across 6 retailers. Using the single-account path costs *you* less and
> leaks nothing extra to your own server; it does not hide anything from anyone
> else. Only not putting the retailer in the clear on chain would do that, and
> that is a program change, not an SDK one.

### 4. Issue signed access tokens

Minimal JWS-style token signed with the merchant Ed25519 key. Clients store it, send it back on each API call, and the server verifies in-memory — no session DB required.

Issue it from the vault, not from a bare TTL. `issueSubscriptionAccessToken`
clamps `exp` to the end of the funded window, so a 30-day session token cannot
be handed to a subscriber with two days left, and pins the token to the vault's
`start_slot` so it does not survive a cancel-and-resubscribe on the same PDA.

```typescript
const token = issueSubscriptionAccessToken({
  merchantKeypair: merchantKp,
  subscriberId: 'user-42',
  serviceSlug: 'my-saas-pro',
  ttlSeconds: 60 * 60,          // ceiling, not a promise
  vault,                        // freshly fetched SubscriptionVaultAccount
  currentSlot: BigInt(await connection.getSlot('confirmed')),
  extraClaims: { tier: 'pro' },
});
// throws if the subscription is not current — there is no honest token to mint

// later, on an API route:
const result = verifyAccessToken(token, merchantKp.publicKey, {
  expectedService: 'my-saas-pro',
});
if (!result.valid) return Response.json({ error: result.reason }, { status: 401 });
// result.claims.sub / .svc / .tier / .exp
```

Pass `expectedService`. Without it the `svc` claim is not compared and a token
minted for one of your services authenticates against every other one;
`result.serviceChecked` tells you which happened. Pass `subscription` too when
you want the chain re-consulted — that is the only thing that notices a
subscription which ended, was paused, or was cancelled since the token was
minted.

### On not asking `isActive`

`SubscriptionVault.is_active` is written `true` when the subscription is
created and `false` nowhere in the program, so it is `true` on every vault that
exists. Cancellation is not the exception — both cancel instructions `close`
the account, so a cancelled subscription stops existing rather than flipping a
flag. Running out of money is what the flag cannot express.

Gate on `subscriptionIsCurrent(vault, currentSlot)`, which asks whether the
period the subscription is in is one the subscriber paid for. `hasActiveVaultAccess`
and `verifyLicenseKey` already do.

Do not substitute `fundedPeriodsRemaining > 0` either: that stays positive
while you simply have not got round to claiming, and would keep serving a
subscriber whose term ended.

## API surface

```
// Config
MerchantSdkConfig                                 { cluster?, programIds?, rpcUrl? }

// Registration (server-side, signs as the merchant)
registerServiceOnChain(connection, kp, config)        MerchantRegistrationResult
updateServiceOnChain(connection, kp, args, cfg?)      TxSig
deregisterServiceOnChain(connection, kp, slug, cfg?)  TxSig
getRegisteredService(connection, owner, slug, cfg?)   ServiceEntry | null

// Read (any caller)
fetchService(connection, owner, slug)                 ServiceEntry | null
fetchServiceByPda(connection, pda)                    ServiceEntry | null
fetchAllServices(connection, opts?)                   ServiceEntry[]

// Payments
verifyOneShotPayment(connection, signature, opts?)    PaymentReceipt
pollPaymentsForRetailer(connection, retailer, opts?)  PaymentReceipt[]
parseInvoiceMemo(memo)                                ParsedInvoiceMemo | null

// Subscriptions — PRIMARY, one account per check
deriveSubscriptionVaultPda(retailer, subId, mint)     [PublicKey, bump]
fetchVaultByAddress(connection, vaultPda, opts?)      { ok, vault } | { ok:false, reason }
hasActiveVaultAccessForVault(conn, vaultPda, retailer, subId, opts?)
                                                      SubscriptionVaultAccount | null
verifyLicenseAgainstVault(conn, key, vaultPda, merchant, serviceId, opts?)
                                                      { valid, vault?, reason?, ambiguousService? }
vaultMatchesService(vault, scope, opts?)              { matches, reason?, ambiguous? }
serviceScopeFromRegistry(entry)                       ServiceScope

// Subscriptions — FALLBACK, hydrates the whole subscriber book (deprecated
// for per-request use; fine on a schedule for reconciliation)
listVaultsForRetailer(connection, retailer, opts?)    SubscriptionVaultAccount[]
hasActiveVaultAccess(connection, retailer, subId)     SubscriptionVaultAccount | null
verifyLicenseKey(conn, key, merchant, serviceId, opts?) VerifyLicenseKeyResult

// Subscription math (pure, no network)
subscriptionIsCurrent(vault, currentSlot)             boolean   <- gate on this
claimablePeriods(vault, currentSlot)                  bigint
claimableAmount(vault, currentSlot)                   bigint
fundedPeriodsRemaining(vault)                         bigint
periodsPaidFor(vault) / periodsElapsed(vault, slot)   bigint

// Revenue leg
buildClaimPeriodInstruction(vaultPda, retailer, opts?) TransactionInstruction
assertRetailerCanReceiveClaim(conn, retailer, payout)  throws on the rent floor

// Entitlement (pure, no network) — packages/merchant-sdk/src/period-math.ts
subscriptionIsCurrent(vault, currentSlot)             boolean   <- gate on THIS
entitlementStatus(vault, currentSlot)                 'current' | 'ended' | 'paused' | 'inactive' | 'unknown'
periodsPaidFor(vault) / periodsElapsed(vault, slot)   bigint
fundedPeriodsRemaining(vault)                         bigint    <- money, not access
subscriptionEndSlot(vault)                            bigint | null
claimablePeriods(vault, slot) / claimableAmount(...)  bigint

// Claiming revenue
buildClaimPeriodInstruction(vaultPda, retailer, opts?) TransactionInstruction
assertRetailerCanReceiveClaim(conn, retailer, payout)  void (throws on rent floor)

// Access tokens (Ed25519-signed, no DB required)
issueSubscriptionAccessToken(opts)                    string  <- clamps exp to the subscription
issueAccessToken(opts)                                string
verifyAccessToken(token, merchantPubkey, opts?)       { valid, claims?, reason?, serviceChecked, subscriptionChecked }

// Constants
ZK_SHIELDED_PROGRAM_ID_DEVNET
REGISTRY_PROGRAM_ID_DEVNET
NATIVE_SOL_MINT
```

Instruction builders (`buildRegisterServiceIx`, `buildAttestServiceIx`, etc.) are re-exported from `@protocol-01/specter-sdk` for callers that need to assemble custom transactions.

## Design

- **Framework-agnostic.** No wallet adapter dependency; callers bring a `Keypair` or a `signTransaction` callback.
- **No side effects at import.** Connecting to an RPC is always explicit.
- **No server state required.** Access tokens are self-contained and signed — verify them anywhere.
- **Configurable programs.** `MerchantSdkConfig` lets mainnet merchants supply the correct program IDs without forking the package.
- **One account per question.** The default entitlement path reads the vault the request is about. The enumerating helpers are still there, deprecated for per-request use and supported for reconciliation.
- **Nothing is trusted because a client sent it.** An account presented by a client is only decoded once its owner is confirmed to be `zk_shielded`. `hasActiveVaultAccessForVault` additionally requires the account to sit at the canonical PDA for the retailer, subscriber and mint in question; `verifyLicenseAgainstVault` cannot — it is given no subscriber ID, so it has no seed set to derive from, and the license commitment is what binds. Owner-checked and program-written is not the same as sold-by-you: see the `service` scope note in section 3.

## Example: complete Netflix-style integration

See [`examples/merchant-netflix`](../../examples/merchant-netflix/) in the repo for a runnable end-to-end script (register, poll payments, issue token, verify).

## Dependency note

This SDK depends on `@protocol-01/specter-sdk` for the service-registry instruction builders and account decoders.  That package must be published (or vendored) before this one can be installed from npm.  The ~670 LOC of service-registry code is intentionally not bundled here to avoid duplication with the mobile and extension clients.

## License

Proprietary — see [LICENSE](../../LICENSE).
