# SDK Migration Guide

Protocol 01 is consolidating around a single canonical SDK: **`@protocol-01/privacy-sdk`**.

The older SDK packages remain installable and functional during the deprecation window, but emit a console warning at import time and should no longer be used in new code.

---

## Canonical package

| | |
|---|---|
| Name | `@protocol-01/privacy-sdk` |
| Status | Active (canonical) |
| Entry point | `import { PrivacySDK } from '@protocol-01/privacy-sdk'` |

All new applications, examples, and docs should import from `@protocol-01/privacy-sdk` (or one of its sub-path exports: `/shield`, `/stealth`, `/confidential`, `/streams`, `/subscriptions`, `/vault`, `/registry`, `/relay`, `/mpc`, `/compliance`, `/airdrop`, `/otc`, `/payroll`, `/treasury`, `/react`).

---

## Deprecated packages

| Deprecated package | Status | Canonical replacement |
|---|---|---|
| `@protocol-01/streams` (path: `packages/sdk`) | Deprecated | `@protocol-01/privacy-sdk` (streams, shielded-pool, relay, subscriptions modules) |
| `@protocol-01/p01-js` | Deprecated | `@protocol-01/privacy-sdk` (+ `@protocol-01/privacy-sdk/react` for React widgets) |
| `@protocol-01/specter-sdk` | **Retained** (see below) | `@protocol-01/privacy-sdk/stealth` for most stealth ops; fall back to `specter-sdk` for granular stealth helpers and PQ claim proofs |
| `@protocol-01/specter-js` | Deprecated | `@protocol-01/privacy-sdk` (+ `@protocol-01/privacy-sdk/react`) |

### Why is `specter-sdk` retained?

`@protocol-01/specter-sdk` is **not deprecated yet** because it still owns functionality that `@protocol-01/privacy-sdk` does not expose:

- **Granular stealth helpers** (individual functions, not the `StealthModule` wrapper): `generateMultipleStealthAddresses`, `createStealthAnnouncement`, `parseStealthAnnouncement`, `generateStealthTransferData`, `deriveStealthPublicKeyFromEncoded`, `deriveStealthPrivateKey`, `verifyStealthOwnership`, `computeStealthAddress`.
- **`StealthScanner` class** and helpers: `scanForPayments`, `createScanner`, `subscribeToPayments` (real-time subscription/event-based stealth scanning — privacy-sdk only ships a one-shot `scan()`).
- **Post-quantum stealth claim proofs** (P4.3): `deriveStealthWotsKeypair`, `deriveStealthWotsFromRecipient`, `buildClaimProofPQ`, `verifyClaimProofPQ`, along with `PQClaimContext` and `PQClaimProof` types. These use WOTS+ signatures derived from the stealth seed for hybrid Ed25519 + hash-based claim proofs.
- **`ClientProver`** (legacy zkSPL prover, also exposed as `proving`) — privacy-sdk wraps proofs inside modules rather than exposing this class directly. The hot-path zkSPL prover is now STARK-based; this class is retained for the legacy Groth16 surfaces (compliance + auction escrow) until they migrate.
- **`CommitmentIndexer` / `StealthIndexer`** and cache backends (`MemoryCache`, `LocalStorageCache`).
- **Standalone wallet utilities** (`createWallet`, `generateMnemonic`, `importFromSeedPhrase`, `recoverAddresses`, etc.).

These must be absorbed into `@protocol-01/privacy-sdk` before `specter-sdk` can be deprecated. Tracked as follow-up work.

---

## Removal timeline

- **Now (v0.x)**: deprecated packages emit a console warning at import time in non-production environments. They still publish and install. `npm install` shows a `deprecated` notice pulled from each package's `package.json`.
- **v1.0**: deprecated packages will be removed from the monorepo. Imports will fail at install time.
- **specter-sdk**: remains supported until its unique functionality (granular stealth helpers, PQ claim proofs, `StealthScanner`, `ClientProver`, indexers, wallet utils) is merged into `privacy-sdk`. It will then be deprecated on the same v1.0 timeline.

Silence the console warning by setting `NODE_ENV=production` (the warning already respects `process.env.NODE_ENV`).

---

## Migration examples

### 1. Client construction

**Before** (`@protocol-01/p01-js`):
```ts
import { Protocol01 } from '@protocol-01/p01-js';

const p01 = new Protocol01({
  merchantId: 'your-merchant-id',
  merchantName: 'Your Business',
});
await p01.connect();
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK } from '@protocol-01/privacy-sdk';
import { Connection } from '@solana/web3.js';

const sdk = new PrivacySDK({
  connection: new Connection('https://api.devnet.solana.com'),
  wallet: myKeypair, // or WalletAdapter
  network: 'devnet',
});
```

**Before** (`@protocol-01/specter-js`):
```ts
import { P01 } from '@protocol-01/specter-js';

const p01 = new P01();
await p01.connect();
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, wallet, network: 'devnet' });
```

---

### 2. Stealth payments

**Before** (`@protocol-01/specter-sdk`):
```ts
import { P01Client } from '@protocol-01/specter-sdk';

const client = new P01Client({ cluster: 'devnet' });
await client.connect(wallet);
await client.sendPrivate(recipientStealthAddress, 1.5, { level: 'enhanced' });
const payments = await client.scanForIncoming();
await client.claimStealth(payments[0]);
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, wallet, network: 'devnet' });

await sdk.stealth.send({
  to: recipientStealthAddress,
  amount: 1.5e9, // lamports
  token: 'SOL',
});

const payments = await sdk.stealth.scan(viewingPrivateKey, spendingPubKey);
await sdk.stealth.claim(payments[0], spendingPubKey, viewingPrivateKey);
```

> If you need the granular stealth helpers (`StealthScanner`, `createStealthAnnouncement`, `verifyStealthOwnership`, PQ claim proofs) keep importing from `@protocol-01/specter-sdk` until the privacy-sdk absorbs them.

---

### 3. Shielded pool (shield / unshield)

**Before** (`@protocol-01/streams` aka `packages/sdk`):
```ts
import { shield, unshield, getPoolInfo, STANDARD_DENOMINATIONS } from '@protocol-01/streams';

const receipt = await shield({ amount: 1e9, denomination: STANDARD_DENOMINATIONS[0] });
const info = await getPoolInfo(poolId);
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK, DENOMINATIONS } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, wallet, network: 'devnet' });

const receipt = await sdk.shield.shield({ amount: 1e9, token: 'SOL' });
const info = await sdk.shield.getPoolInfo(DENOMINATIONS.SOL[0]);
```

---

### 4. Payment streams

**Before** (`@protocol-01/streams` aka `packages/sdk`):
```ts
import { createDevnetClient } from '@protocol-01/streams';

const client = createDevnetClient();
client.connect(wallet);
const sig = await client.createStream({ recipient, amount, duration });
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, wallet, network: 'devnet' });
const receipt = await sdk.streams.create({ recipient, amount, duration });
```

---

### 5. Subscriptions

**Before** (`@protocol-01/p01-js`):
```ts
import { Protocol01 } from '@protocol-01/p01-js';

const p01 = new Protocol01({ merchantId, merchantName });
await p01.connect();
const sub = await p01.createSubscription({
  amount: 15.99,
  interval: 'monthly',
  description: 'Pro Plan',
});
```

**After** (`@protocol-01/privacy-sdk`):
```ts
import { PrivacySDK } from '@protocol-01/privacy-sdk';

const sdk = new PrivacySDK({ connection, wallet, network: 'devnet' });
const receipt = await sdk.subscriptions.create({
  recipient: merchantAddress,
  amount: 15.99e6,    // USDC base units
  interval: 'monthly',
  token: 'USDC',
});
```

---

### 6. React widgets

**Before** (`@protocol-01/p01-js/react`):
```tsx
import { P01Provider, SubscriptionWidget, WalletButton } from '@protocol-01/p01-js/react';

function App() {
  return (
    <P01Provider config={{ merchantId, merchantName }}>
      <WalletButton />
      <SubscriptionWidget tiers={[...]} />
    </P01Provider>
  );
}
```

**After** (`@protocol-01/privacy-sdk/react`):
```tsx
import { PrivacyProvider, useShield, useStealth } from '@protocol-01/privacy-sdk/react';

function App() {
  return (
    <PrivacyProvider config={{ connection, wallet, network: 'devnet' }}>
      <YourComponent />
    </PrivacyProvider>
  );
}
```

> The widget-level components (`SubscriptionWidget`, `WalletButton`, `PayButton`) were merchant-specific. Build them on top of the hooks exposed by `@protocol-01/privacy-sdk/react` or keep using `@protocol-01/p01-js` until v1.0.

---

## FAQ

### How do I silence the deprecation warning?

Set `NODE_ENV=production`. The warning uses `Symbol.for(...)` so it fires at most once per process.

### Can I install a deprecated package alongside `privacy-sdk`?

Yes. Both can coexist; they use independent entry points. Migrate module-by-module.

### I need `ClientProver` / `StealthScanner` / PQ claim proofs.

Keep `@protocol-01/specter-sdk` installed. It is not deprecated; see "Why is specter-sdk retained?" above.

### Where do I report gaps?

Open an issue with the missing API surface (function name, intended signature) so it can be folded into `privacy-sdk` before v1.0.

---

## Migration completed 2026-04-29

The STARK migration described above is **delivered**.
Round 1, Round 2, and Round 3 are all merged.
The only outstanding task is the npm publish wave for the eight migrated SDKs, which is paused on user OTP and not on any technical work.

### Packages where the STARK migration is shipped

The following eight workspace packages have moved off Groth16 on the hot path and now produce or consume STARK proofs end-to-end:

- `@protocol-01/stark-prover`
- `@protocol-01/privacy-toolkit`
- `@protocol-01/zkspl-sdk`
- `@protocol-01/zk-sdk`
- `@protocol-01/p01-js`
- `@protocol-01/specter-sdk`
- `@protocol-01/react-native-zk`
- `@protocol-01/privacy-sdk`

### On-chain hot path

`zk_shielded` and `p01_zkspl` are STARK-only on devnet.
Shield, transfer, unshield, subscribe, cancel-subscription, and merkle-update all route through `p01_stark_verifier` (`DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` — what `declare_id!` names, and the only address a `.so` built from this tree can execute at).
The legacy Groth16 instruction handlers have been deleted from these programs, and `p01_trustless` has been removed from the workspace.

### Retained Groth16 surfaces (by design, off hot path)

Two narrow Groth16 surfaces remain and are intentional:

- **Compliance overlay** in `privacy-sdk` (`compliance.ts`), used for opt-in audit attestations where merchants need selective disclosure to a regulator. Sits outside the shielded pool flow.
- **Escrow auction** (`escrow_bid` circuit), used by the OTC primitive for sealed-bid resolution. Also off the hot path.

These are the only Groth16 code paths still in production. All other surfaces previously listed under "Groth16 (Circom)" have been replaced by STARK AIRs.

### Current source of truth

For the deployed program addresses, the post-migration architecture, and the Frontier IE positioning, see `docs/colosseum-frontier-submission.md`.
