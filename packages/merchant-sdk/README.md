# @protocol-01/merchant-sdk

Server-side SDK for merchants integrating Protocol 01 subscriptions on Solana.

Register a service on-chain, detect incoming ZK payments, check a subscriber's
entitlement, collect the recurring revenue, and issue signed access tokens — all
framework-agnostic (Node.js, Next.js routes, Cloudflare Workers, Deno).

**If you are integrating today, read [section 3](#3-check-a-subscription-on-a-request--read-one-account) first.**
An entitlement check reads one account rather than your whole subscriber book
(which does not make that book private — see the note at the end of section 3),
and it does not trust the vault's `is_active` flag.

## Subscriptions are one-way: no cancellation, no protocol refund

Read this before you write your billing copy.

A Protocol 01 subscription is a **prepaid envelope**. The subscriber deposits
into a vault up front and that money can only ever leave the vault toward you.
**The protocol has no cancellation instruction and no refund path**, so there is
no call -- in this SDK or anywhere else -- that returns a lamport to a
subscriber. Over the life of a vault you receive exactly `total_deposited`,
always, eventually. `claim_period` sweeps it period by period and closes the
vault on the final claim, paying you the sub-period remainder and the rent.

The subscriber's only controls are **pause** and **resume**. Pause freezes the
subscription clock and cuts access; prepaid days are not lost while paused, and
resume picks the clock back up where it stopped. Pause changes *when* you are
paid, never *how much*.

**You remain free to refund a customer off-band, from your own wallet.** Nothing
here forbids refunds as a commercial policy -- offer them, advertise them, honour
them on whatever terms you like. What the protocol will not do is execute,
custody, escrow or guarantee that refund for you. If you promise refunds, you are
promising them as a merchant, and you pay them yourself.

Two consequences for your integration:

1. **Disclose it at checkout, before the subscriber pays.** "No cancellation, no
   refund from the protocol; you may pause at any time and resume later, and your
   prepaid days are not lost while paused." It is a condition of the payment, not
   a detail of the account screen. The Protocol 01 mobile app and browser
   extension both state it on the paying screen; a third-party checkout must do
   the same.
2. **Do not build a cancel button.** There is nothing behind it. Offer pause and
   resume, and -- if you offer refunds -- a support path that you settle yourself.

## Status

**This package is not yet published to npm.**

The programs are currently live on **devnet only** — mainnet deployment is pending.  Until the packages are published, use one of the two paths below to install:

### Option A — npm pack (recommended for integration testing)

`@protocol-01/merchant-sdk` is **self-contained**: the service-registry
instruction builders and account decoders from specter-sdk are bundled into its
dist — JS and type declarations both — so the merchant tarball alone installs
and typechecks. Install specter-sdk as well only if you want its wider surface
(stealth addresses, shielded transfers, client-side proving).

```bash
# From the repo root
pnpm --filter @protocol-01/specter-sdk build
pnpm --filter @protocol-01/merchant-sdk build

cd packages/specter-sdk  && npm pack   # produces protocol-01-specter-sdk-*.tgz
cd packages/merchant-sdk && npm pack   # produces protocol-01-merchant-sdk-*.tgz

# In your project — merchant-sdk alone:
npm install /path/to/protocol-01-merchant-sdk-0.x.y.tgz @solana/web3.js

# ...or both:
npm install /path/to/protocol-01-specter-sdk-0.x.y.tgz \
            /path/to/protocol-01-merchant-sdk-0.x.y.tgz \
            @solana/web3.js
```

Both shapes are exercised against a clean out-of-workspace project (install,
CJS `require` + ESM `import`, and `tsc --noEmit` over the imports this README
uses) — last verified 2026-08-04. If your `tsconfig` sets `skipLibCheck:
false`, your project needs `@types/node` >= 22.7: the SDK's declarations use
the generic `Buffer` type introduced there.

### Option B — workspace reference (monorepo consumers)

If your project is inside this monorepo (or a pnpm workspace that links to it):

```json
{
  "dependencies": {
    "@protocol-01/merchant-sdk": "workspace:*"
  }
}
```

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

> ⚠️ **No shipped client writes this memo today.** Read this section as a
> parser you can target, not as a flow that already works end to end.
> MEASURED 2026-08-04: the only memo any Protocol 01 client has ever written is
> `P01_SUB_V1:` (`apps/mobile/app/(main)/(streams)/subscribe.tsx`,
> `apps/extension/src/shared/services/onchain-sync.ts`), it describes a
> subscription rather than an invoice, and it is attached only on the
> cleartext-wallet branch — the ZK unshield branch attaches no memo at all.
> A ZK one-shot payment also leaves nothing on chain to hang a slug on, so no
> parser change alone would make this work. Until a client writes
> `MEMO_INVOICE_PREFIX`, `pollPaymentsForRetailer` returns an empty array.
> That silence is now reported: pass `onSkipped` (below) to see what was
> dropped instead of guessing.

The intended shape: the payer embeds an invoice memo `p01:<slug>:<periods>m` in
the transaction, and the SDK parses every signature to the retailer and returns
the matching receipts.

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

First, build your **service scope** — once, at boot, from your own registry
entry. It is the only check that refuses a self-minted vault (explained below),
so treat it as required in production, not as a multi-product convenience:

```typescript
import {
  fetchService,
  serviceScopeFromRegistry,
  deriveSubscriptionVaultPda,
  hasActiveVaultAccessForVault,
  NATIVE_SOL_MINT,
} from '@protocol-01/merchant-sdk';

// The scope is the four facts a vault is compared against: retailer, mint,
// price and interval. Read them back from the entry you registered in step 1 —
// retailer and mint are immutable after registration, so caching this for the
// process lifetime is safe.
const entry = await fetchService(connection, merchantKp.publicKey, 'my-saas-pro');
if (!entry) throw new Error('service not registered — run registerServiceOnChain first');
const myServiceScope = serviceScopeFromRegistry(entry);

// No registry entry (yet)? The scope is plain data — you can state the same
// four facts yourself. What matters is that they come from YOU, not from the
// vault being checked:
//   const myServiceScope: ServiceScope = {
//     retailer: merchantKp.publicKey,
//     tokenMint: NATIVE_SOL_MINT,
//     priceAtomic: 50_000_000n,
//     intervalSlots: 6_480_000n,
//   };
```

Then, per request:

```typescript
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
  { service: myServiceScope, requireService: true },
);

if (!vault) return Response.json({ error: 'no current subscription' }, { status: 402 });
```

(`requireService: true` makes the omission of a scope an error instead of a
silently weaker check.)

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
longer than the merchant will exist. (The attacker no longer gets the deposit
back -- cancellation was removed -- but a self-minted vault costs them the
denomination either way, and the point is that it reads "current" to you.)

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
`start_slot` so it does not survive a close-and-resubscribe on the same PDA
(a vault whose funded periods are exhausted is closed by `claim_period`, and
the subscriber may then subscribe again at the same address).

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
subscription which ended or was paused since the token was minted.

### 5. Collect the revenue — `claimPeriod`

Subscribers prepay into the vault; nothing reaches you until `claim_period`
runs. It is a **pull, not a drip**: the program derives how many periods have
accrued from the clock and pays them all in one transaction, and nothing on
chain schedules it. Claim on whatever cadence suits your books — a daily cron,
end of month, or once, much later. The money cannot go anywhere else in the
meantime: there is no cancellation and the vault PDA is the only authority over
the funds.

```typescript
import { claimPeriod } from '@protocol-01/merchant-sdk';

// Self-claim: the retailer signs and pays its own ~5,000-lamport fee.
const res = await claimPeriod(connection, vaultPda, merchantKp);
console.log(`swept ${res.periodsClaimed} periods, ${res.amountClaimed} lamports — ${res.signature}`);
```

`claimPeriod` preflights every failure shape that was measured on devnet and
throws a message naming the real cause, instead of letting the runtime or the
token program produce the misleading one (several of those on-chain errors name
the wrong account, or no account, or — in one SPL case — report success while
paying nothing; see the `assertRetailerCanReceiveClaim` docs).

**The claim is permissionless. You do not need the retailer's key.** The
program pins the *destination*, not the sender: `claim_period` takes the
retailer as a plain account constrained by `retailer.key() == vault.retailer`.
So pass the retailer's **address** and let any funded key sign:

```typescript
// A keeper, the subscriber, or anyone else triggers the payout. The money
// still lands on the vault's retailer address and nowhere else — the payer
// only picks the timing and pays the transaction fee.
const res = await claimPeriod(connection, vaultPda, retailerAddress, {
  payer: keeperKp,
});
```

Proven on devnet 2026-08-04: a third-party signer holding no retailer secret
pushed a claim and the vault's retailer was paid. This is what makes a lost
retailer key a nuisance rather than a fund loss — payouts keep landing on the
address whether or not the key that once controlled it still exists. (It is
also why the SDK accepts a bare `PublicKey` here: requiring a `Signer` would
re-impose, client-side, exactly the constraint the program removed.)

**The final claim closes the vault.** The claim that collects the last funded
period also deletes the account and pays its rent (~0.003 SOL) to the retailer;
the result reports it as `closesVault: true` with `rentReleasedLamports`. A
vault that is already exhausted — every period collected, nothing accruing — is
still worth one last claim for the rent alone, but because that claim deletes
the account, sending it is an explicit opt-in:

```typescript
// Releases the sub-period remainder + the account's rent, and closes the vault.
const res = await claimPeriod(connection, vaultPda, retailerAddress, {
  payer: keeperKp,
  closeExhausted: true,
});
```

**Native SOL has a first-claim rent floor.** The payout must leave the
retailer's system account at or above rent exemption (890,880 lamports).
Measured on devnet: the program *succeeds* and the runtime then rejects the
transaction with "insufficient funds for rent" naming an account index — which
reads as though the vault were empty. The preflight catches it first. A
merchant onboarding with an empty payout wallet either funds the address once
or waits until enough periods accrue for a single claim to clear the floor.

**SPL vaults need both token accounts:**

```typescript
const res = await claimPeriod(connection, vaultPda, retailerAddress, {
  payer: keeperKp,
  vaultTokenAccount,     // its SPL owner MUST be the vault PDA
  retailerTokenAccount,  // its SPL owner must be vault.retailer — unless the retailer co-signs
});
```

To pay into a treasury token account that `vault.retailer` does not own, the
retailer really must sign: pass the retailer as a `Keypair` (or `Signer`) plus
`retailerSigns: true`. That is the one thing the retailer's signature still
buys since the claim went permissionless.

### On not asking `isActive`

`SubscriptionVault.is_active` is written `true` when the subscription is
created and `false` nowhere in the program, so it is `true` on every vault that
exists. Nothing flips it: cancellation was removed from the protocol, and the
one thing that does end a vault -- `claim_period` closing it once its funded
periods are exhausted -- makes the account stop existing rather than flip a
flag. Running out of money before that final claim lands is what the flag
cannot express.

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

// Entitlement math (pure, no network) — packages/merchant-sdk/src/period-math.ts
subscriptionIsCurrent(vault, currentSlot)             boolean   <- gate on THIS
entitlementStatus(vault, currentSlot)                 'current' | 'ended' | 'paused' | 'inactive' | 'unknown'
periodsPaidFor(vault) / periodsElapsed(vault, slot)   bigint
fundedPeriodsRemaining(vault)                         bigint    <- money, not access
subscriptionEndSlot(vault)                            bigint | null
claimablePeriods(vault, slot) / claimableAmount(...)  bigint

// Revenue leg — section 5. `retailer` is a PublicKey OR a Signer: an address
// plus opts.payer is the permissionless claim, a Signer is the self-claim.
claimPeriod(connection, vaultPda, retailer, opts?)     ClaimPeriodResult
buildClaimPeriodInstruction(vaultPda, retailer, opts?) TransactionInstruction
assertRetailerCanReceiveClaim(conn, retailer, payout)  throws naming the real cause

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

The service-registry instruction builders and account decoders are shared with
`@protocol-01/specter-sdk` — one source of truth in that package's tree,
**bundled into this package's dist at build time** (JS and type declarations
both), so installing merchant-sdk does not require specter-sdk. The mobile and
extension clients consume the same source through specter-sdk, so nothing is
duplicated by hand.

## License

Proprietary — see [LICENSE](../../LICENSE).
