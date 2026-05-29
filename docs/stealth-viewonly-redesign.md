# Stealth scheme redesign — real view-only keys

Status: DESIGN (no implementation). Written 2026-05-29 after the View Keys audit.

## Problem

The current ECDH stealth scheme **couples viewing and spending**: anyone who can
detect an incoming payment can also spend it. So there is no such thing as a
view-only key today, and the "Incoming Viewing Key" the app exports is in fact a
spend-capable secret.

### Why (current derivation)

`utils/crypto/stealth.ts`:

```
sharedSecret = ECDH(viewingSecret, ephemeralPub)        // ephemeralPub is on-chain
stealthSeed  = HKDF(sharedSecret, spendingPubKey)       // spendingPubKey is PUBLIC
stealthKey   = ed25519.fromSeed(stealthSeed)            // .secretKey SPENDS the funds
```

The one-time address's **secret key** is a deterministic function of:
`viewingSecret` + `spendingPubKey` (public) + `ephemeralPub` (on-chain).

Confirmed spend usage: `denominatedPoolStore.ts:1276`, `services/zk/index.ts:3515`
both do `Keypair.fromSecretKey(scanResult.privateKey)` and sign.

Consequences:
- The "IVK" (= X25519 viewing secret) + the public spending key = full spend control.
- The **sender** can also recompute the one-time secret (they know the shared secret
  via their ephemeral secret + the public spending key) — i.e. the sender retains
  spend control over funds they sent. This is a separate soundness problem.

The shipped mitigation (commit after this doc): keep the export but warn loudly that
the key can spend, and gate Copy/Share behind an explicit confirmation. The real fix
is below.

## Goal

A dual-key stealth scheme where an **incoming viewing key detects payments but cannot
spend them**, matching the Monero/Zcash model.

## Proposed scheme (dual-key, spend ≠ view)

Each user holds two independent keypairs over the same curve:
- Spend keypair: `a` (secret), `A = a·G` (public)
- View keypair:  `b` (secret), `B = b·G` (public)

Meta-address = `(A, B)` (both public; safe to publish).

### Send (sender knows only `A`, `B`)
```
r  = random scalar;  R = r·G            // ephemeral, published on-chain
s  = H( r·B )                           // shared secret via VIEW public
P  = A + H(s)·G                         // one-time stealth ADDRESS (public)
viewTag = s[0]
```
The sender can compute `P` (an address) but **not** its secret key, because the
one-time secret is `a + H(s)` and the sender does not know `a`.

### Detect (recipient, view secret `b`)
```
s  = H( b·R )                           // same shared secret, via VIEW secret
P' = A + H(s)·G                         // recompute address using own public A
found = (P' == on-chain recipient)      // detection only — needs b + A, both non-spend
```
This requires `b` (view secret) + `A` (spend **public**). It yields **no** spend key.

### Spend (recipient, spend secret `a`)
```
p = a + H(s)   (mod l)                  // one-time SECRET — requires spend secret a
sign with p
```
Only the holder of `a` can spend. View-only parties never see `a`.

### View-only key to share
`viewKey = (b, A)` — the view secret plus the spend **public** key. Lets an auditor
scan and recompute `P'` for every payment, compute balances, but never derive `p`.

## What changes in code

- `utils/crypto/stealth.ts`
  - `generateStealthAddress`: derive `P = A + H(s)·G` (point add), not `HKDF(seed)→keypair`.
  - `scanStealthPayment`: split into **detect** (returns address + shared secret, no key)
    and **deriveSpendKey** (requires spend secret `a`).
  - Meta-address stays `(A, B)`; add a separate exportable `viewKey = (b, A)`.
- Spend call sites (`denominatedPoolStore.ts`, `services/zk/index.ts`) must obtain the
  one-time secret via `deriveSpendKey(a, s)` using the **wallet's spend secret**, instead
  of reading `scanResult.privateKey`.
- View Keys screen: IVK export becomes `(b, A)` and is genuinely view-only; re-enable
  Share without the spend warning once this lands.
- Watch-only scanner (the blocked feature): import `(b, A)` → detect-only loop →
  read-only balance/history. No spend path exists, so it's safe by construction.

## Migration / breaking change

Address derivation changes, so **stealth notes created under the old scheme are not
recoverable by the new one**. Required:
- Version the stealth format (e.g. `st:03…` meta + a scheme byte on each payment).
- Dual-scan during transition: scan both old (legacy `HKDF` seed) and new (point-add)
  derivations until legacy in-flight payments are drained.
- ed25519 point arithmetic for `A + H(s)·G` — use `@noble/curves/ed25519` (already a dep);
  current code only does seed→keypair, so this is new.
- Audit the sender-can-spend soundness gap as part of the same change.

## Effort estimate

Crypto core + both spend call sites + meta-address v3 + dual-scan migration + tests:
~4–6 focused days, plus a security pass on the new derivation. This is a protocol
change, not a polish item — schedule deliberately.

## Until then

- View-only keys are **not** safe to share (see the in-app warning).
- The watch-only IVK scanner is **blocked** on this redesign.
