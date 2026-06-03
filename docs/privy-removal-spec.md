All adversarial findings are verified against ground truth. The `p01_zk_seed` random-mnemonic fallback (line 730, `generateMnemonic`) is a real, separate orphaning source. HKDF signature confirmed. I have everything needed to write the authoritative spec.

---

# PROTOCOL 01 â€” UNIFIED WALLET ARCHITECTURE SPEC
## Privy Removal + Classic/Hardware Wallets + HKDF Identity Derivation
### (Mobile + Extension + privacy-sdk) â€” Authoritative Implementation Spec, 2026-06-03

This is the single source of truth. It supersedes the five per-subsystem specs where they conflict, incorporates all 16 verified adversarial findings, and resolves the software-vs-hardware portability question explicitly.

---

## 0. EXECUTIVE SUMMARY (the five locked decisions)

1. **Derivation is TIERED, never universal.** Three derivation methods, selected by wallet kind, with the kind **persisted per-account** so it can never silently flip (closes the divergence footgun). Method per kind is locked in Â§1.
2. **Hardware (Ledger) NEVER derives a long-lived key from a signature.** It uses a **random local spending seed, encrypted at rest, with the Ledger only co-signing on-chain txs.** The sentinel-tx is demoted to an explicitly experimental, opt-in, twice-sign-gated power-user shim â€” OFF by default.
3. **The 8-byte entropy ceiling is a protocol-level finding, documented and scoped separately.** On-chain owner identity is ~64 bits regardless of derivation. We do NOT market HKDF outputs as 256-bit, and we do NOT let the spend/view HKDF separation imply circuit-level separation (it collapses to 8 bytes). A circuit/note-format migration to widen it is scoped but NOT in this work.
4. **No secret at rest in plaintext, ever.** Spending seeds, HKDF outputs, passwords, and signatures are zeroized after use; persisted material is AES-GCM (extension) / SecureStore (mobile) with **PBKDF2 â‰¥600k** (no 100k, no cleartext fallback).
5. **Privy removal is a data-loss event for several seed classes.** Five distinct orphaning sources exist (not one). All require an explicit pre-removal migration or an accepted, surfaced data-loss warning. Enumerated in Â§2 RISK-12.

---

## 1. FINAL CRYPTO DESIGN

### 1.1 The portability invariant (resolved explicitly)

> **"Same user â†’ same shielded identity everywhere" holds ONLY when (a) the underlying secret is byte-identical AND (b) the derivation is deterministic.**

This is guaranteed for exactly two tiers and explicitly NOT guaranteed for hardware. The software-vs-hardware portability question is therefore resolved by **abandoning the goal of a single derivation** and instead making the derivation method a **stable per-account property** carried by an encrypted, portable backup for the one case (hardware) where signature-determinism fails.

### 1.2 Locked derivation method per wallet kind

| Kind | `walletKind` value | Spending-seed source | Determinism | Portability mechanism |
|---|---|---|---|---|
| **Seed / local (GOLD PATH, default)** | `'local-seed'` | `HKDF(sha256, ikm=secretKey[0:32], salt=HKDF_SALT, info=SPEND_INFO, 32)` | Guaranteed (offline, no network) | Same BIP39 recovery phrase â†’ same key, any device |
| **Software-injected** (Phantom/Solflare extension, Android MWA, web adapter) | `'software'` | `HKDF(sha256, ikm=signMessage(IDENTITY_DOMAIN), salt=HKDF_SALT, info=SPEND_INFO, 32)` | Guaranteed **only for software ed25519** (RFC 8032) â€” enforced by twice-sign gate at enrollment | Same wallet + same ASCII domain message â†’ same signature â†’ same key |
| **Hardware (Ledger)** | `'hardware'` | **CSPRNG 32-byte seed**, generated once, encrypted at rest. NOT signature-derived. | N/A (random) | **Opt-in encrypted P01-identity backup** (Â§1.7) is the ONLY recovery/portability path |
| **Watch-only / QR remote** | `'watch-only'` | none (`canSign=false`) | N/A | Cannot derive identity; gated to transparent-only with honest copy |

**Rationale for the hardware decision (research-backed):** Ledger off-chain `signMessage` is blocked through Phantom, flaky through Solflare, requires app â‰¥1.8.0, and â€” critically â€” EdDSA nonce-hedging on hardware/MPC means `sha256(sig)` is **not guaranteed reproducible**. A signature-derived spending key on such a signer silently strands funds on the next session. We therefore never derive a long-lived key from a Ledger signature.

### 1.3 HKDF parameters (LOCKED, single source of truth)

Defined ONCE in `packages/privacy-sdk/src/identity/constants.ts`, imported by mobile + extension (no per-client reimplementation â€” closes the cross-client drift risk, RISK-06):

```
IDENTITY_DOMAIN = 'protocol01:identity:v1'   // utf8, the message signed for software/MWA paths
HKDF_SALT       = utf8('protocol01:hkdf:v1') // fixed public salt (RFC-5869-legal)
SPEND_INFO      = utf8('p01:spend:v1')       // domain separator â†’ spendingKey
VIEW_INFO       = utf8('p01:view:v1')        // domain separator â†’ viewingKey
HKDF hash       = sha256
L               = 32 bytes each
```

Derivation, given a 32-byte IKM (seed bytes OR signature bytes):
```
spendingKey = hkdf(sha256, ikm, HKDF_SALT, SPEND_INFO, 32)   // â†’ asSpendingKey
viewingKey  = hkdf(sha256, ikm, HKDF_SALT, VIEW_INFO,  32)   // â†’ asViewingKey
```

`hkdf(hash, ikm, salt, info, length)` arg order is **verified** against `stealth.ts:166` and `@noble/hashes@2.2.0`. No new dependency.

> **HKDF was confirmed sound at the HKDF layer.** The spend/view separation is cryptographically real in the 32-byte outputs. See RISK-01 for why that separation does NOT survive to the circuit.

### 1.4 The 8-byte entropy ceiling (MUST be documented, NOT marketed away)

Verified in repo: `bytesToGoldilocks` (`goldilocks.ts:23-29`) builds the field element from **only bytes[0..8) little-endian**, then reduces mod `p = 2^64 âˆ’ 2^32 + 1`. `ShieldModule` (`shield.ts:209-210`) does `spendingKeyGl = bytesToGoldilocks(spendingKey); ownerPubkeyGl = goldilocksHash2to1(spendingKeyGl, 0n)`. Mobile/extension fold identically.

**Consequences locked into the design:**
- On-chain **owner identity entropy is ~64 bits (â‰ˆ63.9 after mod-p)**, regardless of how the 32-byte key was produced.
- `spendingKey â‰  viewingKey` at 32 bytes, but **both collapse to 8 bytes at the circuit boundary** â€” the HKDF separation gives a *false* impression of 256-bit on-chain separation. Two distinct 32-byte outputs collide on-chain iff their low-8-bytes reduce equal.
- The 8-byte slice is from a uniform region of a crypto hash (sha256/HKDF output), so it is not low-entropy â€” but it is brute-forceable for a targeted owner and birthday-collidable at user-base scale.

**Policy:** documentation states "~64-bit on-chain owner entropy; spend/view separation does not hold at the circuit." A circuit input re-encoding (absorb all 32 bytes via a Poseidon sponge into â‰¥2 Goldilocks limbs) is a **separate, deliberately-scoped circuit + note-format migration** (new `ownerPubkeyGl` â†’ old notes invisible). Tracked in Â§6 OPEN-Q, NOT built here.

### 1.5 No-at-rest policy (zeroization)

- **In-memory cache only** for derived `spendingKey`/`viewingKey`, keyed by `publicKey.toBase58()`. Never written to disk/SecureStore/AsyncStorage.
- The seed/signature IKM, the derived sub-keys, the wallet password, and the keypair secret are **zeroized (`.fill(0)`)** after use, on lock, and on logout. `clearP01Identity(pubkey?)` / `clearAllP01Identities()` fill-then-delete.
- Persisted material (only the **hardware** random spending seed, and the opt-in identity backup) is AES-GCM (extension `crypto.ts`) / SecureStore `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (mobile), key-derived with **PBKDF2 â‰¥600k**. The cleartext-seed fallback (`shielded.ts:495-496`) is **removed**; missing password fails loudly.

### 1.6 The signature-determinism enrollment gate (ENFORCED, not documented)

For ANY path that uses a signature as IKM (software `signMessage`, MWA `signMessages`, and the experimental sentinel-tx):
1. At enrollment, sign the canonical message **TWICE**.
2. If the two signatures differ â†’ **refuse to derive a key**; for software wallets surface "this wallet's signer is non-deterministic; shielded features unavailable"; for hardware route to the random-local-seed model.
3. Persist `deterministicSigner: true` per-account only after the check passes; re-run opportunistically.
4. Never persist or trust a signature-derived seed from an unverified signer.

### 1.7 Hardware recovery: opt-in encrypted P01-identity backup (near-mandatory UX)

Because the Ledger recovery phrase does NOT regenerate the random `p01SpendingSeed`, losing device app-data = losing all shielded notes. Mitigation:
- Extend the existing backup service (`apps/mobile/services/backup/index.ts`; build the extension equivalent) to **v2**: add `p01SpendingSeed: string(base64)`, `walletKind`, `ledgerPath`, `publicKey`; keep v1 read-compat.
- Encryption: passphrase â†’ PBKDF2 â‰¥600k â†’ XSalsa20-Poly1305 (mobile) / AES-GCM (extension). Pubkey stays *inside* ciphertext (L7 metadata-min).
- Prompted immediately after Ledger connect and re-prompted on first shield; declining is an explicit, friction-ful choice.
- Restore: import blob â†’ write seed to encrypted store â†’ `rescanPool` rebuilds notes from chain.

### 1.8 Sentinel transaction â€” experimental opt-in ONLY (hardened if kept)

Built but **NEVER broadcast**. Demoted to a reachability shim for the narrow "must extract some Ledger-derived value" case, behind the Â§1.6 twice-sign gate AND the Â§1.4/Â§1.2 understanding that it is not the recovery guarantee. If kept, it MUST (RISK-03):
- Pin tx **version explicitly** (legacy vs v0 â€” never let the wallet choose; they serialize to different message bytes).
- Use a documented constant `SENTINEL_BLOCKHASH` that **decodes to exactly 32 bytes** (assert `length === 32`).
- Single SPL-Memo ix, empty `keys`, `data = utf8(IDENTITY_DOMAIN) || pubkey.toBytes()` (pubkey-bound, anti-replay).
- `feePayer = signer.publicKey`.
- After signing: assert exactly one signature entry for the fee-payer; assert the signed message bytes equal the pre-sign bytes (reject if the wallet mutated blockhash / added a priority-fee or compute-budget ix); ed25519-verify the signature against pubkey over those exact bytes. Only then trust as IKM, and only after the twice-sign reproducibility check.

---

## 2. RISK REGISTER

Severity: **C**ritical / **H**igh / **M**edium / **L**ow. Every entry is a verified-real finding.

| # | Sev | Finding | Resolution (mitigate / accept) |
|---|---|---|---|
| **R-01** | **C** | **8-byte entropy collapse** â€” only low 8 bytes reach the circuit; on-chain owner â‰ˆ64 bits; spend/view HKDF separation defeated at circuit boundary. (Verified `goldilocks.ts:23`, `shield.ts:209`.) | **ACCEPT short-term + scope migration.** Document ~64-bit ceiling; never market HKDF outputs as 256-bit; never imply on-chain spend/view separation. **Scoped circuit/note-format migration** (Poseidon sponge over all 32 bytes â†’ multi-limb owner preimage) tracked in OPEN-Q. Ensure the 8-byte slice always comes from a crypto-hash region (it does). |
| **R-02** | **H** | **Software vs hardware paths yield DIFFERENT keys for the same user** â€” IKM differs (message-sig vs tx-sig vs random); silent transport switch strands notes. | **MITIGATE â€” hard gate.** `walletKind` + derivation method is a **persisted, per-account property**. Refuse silent re-derivation via a different path; require an explicit warned migration ("sweep notes before switching transport"). Hardware uses random-seed (no signature divergence at all). |
| **R-03** | **H** | **Sentinel-tx non-deterministic at the message layer** â€” tx version, blockhash-as-32-bytes, fee-payer/priority-fee mutation, extra signers, blind-sign all break determinism *before* nonce-hedging. | **MITIGATE if kept (else AVOID).** Default product = random local seed; sentinel is experimental opt-in only, hardened per Â§1.8 (pin version, assert 32-byte blockhash, verify no mutation, ed25519-verify, twice-sign). Prefer avoiding entirely for hardware. |
| **R-04** | **H** | **EdDSA non-determinism on hardware/MPC** â€” hedged nonces â†’ unreproducible sig â†’ unrecoverable notes. | **MITIGATE â€” enforced gate (Â§1.6).** Twice-sign at enrollment for every signature-IKM path; refuse derivation on mismatch; persist `deterministicSigner` only after pass. Seed-direct gold path unaffected. |
| **R-05** | **M** | **Legacy `sha256(sig)` vs new `HKDF(sig)` yield different keys** â€” similarly-named exported fns invite a drop-in swap that orphans existing notes; 8-byte collapse can mask divergence as partial failure. | **MITIGATE.** Keep `deriveSpendingKeyFromSignature` byte-for-byte. Name the new SDK fn **`deriveP01Identity`** (distinct), add lint/dev-warning if both constructed for one account in a session, loud "NON-INTERCHANGEABLE" doc. Provide explicit one-time sweep migration for any legacy cohort. |
| **R-06** | **M** | **Cross-client constant drift** â€” "same key everywhere" depends on 4 byte-identical constants (IDENTITY_DOMAIN, salt, 2 info strings) + identical IKM across SDK/mobile/extension, today implemented 3 different ways. | **MITIGATE.** Single `constants.ts` in privacy-sdk; mobile+extension import it. Add a **cross-client parity test** (mirror `goldilocks-poseidon.parity.test.ts`) asserting byte-identical HKDF outputs for a fixed IKM. Forbid per-client reimplementation. |
| **R-07** | **L** | **Tiered architecture is correct** (confirmation, not defect). | **ADOPT** as specified with R-01..R-06 hardening. Seed-direct default whenever raw key reachable. |
| **R-08** | **H** | **Heap residue** â€” seed (`denominatedPool:218`), HKDF keys (`noteCrypto:71`), keypair, password (`sessionCrypto:163`) linger; no wipe. | **MITIGATE.** Zeroize all secret buffers after use; clear identity cache + password on lock/logout (Â§1.5). |
| **R-09** | **H** | **Privy removal strands Privy-seed notes** â€” `deriveSeedFromSigner` notes (`shielded:481`) unreconstructable post-removal. | **MITIGATE or ACCEPT-with-warning.** Run a one-time export/migration of `p01_note_seed_v1_*` before deleting helpers; OR surface explicit data-loss warning. See R-12 for the *full* orphaning set. |
| **R-10** | **M** | **Weak KDF + cleartext fallback** â€” 100k not 600k (`crypto:21`, `backup:89`); cleartext seed when no password (`shielded:496`). | **MITIGATE.** PBKDF2 â‰¥600k everywhere; **remove** cleartext fallback (`shielded:495`); missing password fails loudly. |
| **R-11** | **H** | **Mobile spec missed `subscriptionVaultStore.ts` (own `getWalletSignerIfPrivy` + 10 sites) and `arcium/mpcClient.ts`** (`getPrivySigner`+`isPrivyWallet`, `getWalletInfo` tries Privy first). Verified present. | **MITIGATE â€” add both files.** Delete `subscriptionVaultStore` `getWalletSignerIfPrivy` (line ~234), collapse its 10 sites (300/398/520/556/590/625/659/739/825/875) to local-keypair; drop `mpcClient` imports (~17) and collapse `getWalletInfo` (46-58) to the `getKeypair` branch. |
| **R-12** | **C** | **Premise "only NOTE_SEED notes are lost" is FALSE.** `services/zkspl/index.ts` (`ZK_SEED_KEY='p01_zk_seed'`, `generateMnemonic` line 730) and `services/stark/index.ts` generate a **random 12-word mnemonic** for keyless wallets and derive the zkSPL/stark keypair from it â€” a separate, untouched orphaning source. Extension mirrors: `getOrCreatePrivyZkSeed` (`shielded:451`, deterministic-from-address) + `deriveSpendingKeyForPrivy` (`zkspl:124`, random `p01_zkspl_privy_seed`). | **MITIGATE.** Audit `zkspl/index.ts` + `stark/index.ts`; decide keep-vs-remove the `p01_zk_seed` random-mnemonic fallback (note: it's reachable for **local** wallets too when `getKeypair`+mnemonic both miss). **Enumerate ALL orphaning seed classes in the data-loss warning:** (a) mobile `p01_note_seed_v1_*`, (b) mobile `p01_zk_seed`, (c) extension `p01_privy_zk_seed`, (d) extension `p01_zkspl_privy_seed_*`. No literal find-replace until each is migrated or accepted. |
| **R-13** | **H** | **Mobile spec missed `streams.ts` and `private-send.tsx` signing paths.** `streams.ts` (834/839/862-867) dynamically imports `getPrivySigner`, branches keypair/privy/throw. `private-send.tsx` (146-148) builds the transfer signer **ONLY** from `getPrivySigner` with NO keypair branch â†’ post-removal every private-send throws "No wallet signer available." Verified present. | **MITIGATE.** `streams.ts`: drop `getPrivySigner` import (834) + else-if (862-867). `private-send.tsx`: replace `getPrivySigner` (146-147) with `const kp = await getKeypair(); if(!kp) throw; signTx = async (tx)=>{tx.sign(kp); return tx;}`. |
| **R-14** | **H** | **Extension fund-loss understated + mobile dangling refs.** Extension `getOrCreatePrivyZkSeed` (`shielded:451-507`) + `deriveSpendingKeyForPrivy` (`zkspl:124-174`) hold keys to existing extension shielded/zkSPL notes â€” deleting them silently orphans those notes. Mobile `resetStores.ts` imports+calls `clearNoteSeedCache` (12/45) â€” not in spec's importer list (dangles). `denominatedPoolStore.ts` calls `getWalletSignerIfPrivy` at **1785/1943/2206** not in spec's site list. | **MITIGATE.** Add extension data-loss warning (R-12 c/d). Add `resetStores.ts` to `clearNoteSeedCache` importer cleanup. List **all 9** `getWalletSignerIfPrivy` sites incl 1785/1943/2206; collapse 1785/1943 to `useWalletStore.getState().publicKey`. |
| **R-15** | **M** | **`deriveP01Identity` naming collision** â€” mobile-removal spec returns `noteSeed=secretKey.slice(0,32)`; sdk-foundation returns HKDF `{spendingKey, viewingKey}`; external/ui specs reference other shapes. Same symbol, 3 semantics. Plus: deleting `getPrivyMessageSigner` must first remove BOTH builders (`denominatedPoolStore:441` + missed `subscriptionVaultStore`) or `WalletSigner.signMessage` (`denominatedPool/index.ts:1410-1415`) orphans. Grep gate trips on comment-only refs. `relayerWrapper.ts`/`v3RelayerWrapper.ts` gate the v0-LUT path on `keypair!=null` â†’ post-removal all wallets shift to versioned. `streams.test.ts` mocks `getPrivySigner`. | **MITIGATE.** **Rename the mobile app-local helper `deriveLocalNoteSeed`; reserve `deriveP01Identity` for the SDK only.** Remove both `getPrivyMessageSigner` builders before deleting the global. Scope the zero-match grep to **identifiers, not comments** (whitelist: `QuantumWalletBootProvider:82`, `auth-confirm:51/56/74`, `confidentialStore:58/250`, `stark/index:407/711`, `shieldedStore`). **Confirm the versioned-path shift is intended** (OPEN-Q). Clean `streams.test.ts` mock (52-53). |
| **R-16** | **M** | **Watch-only/QR wallet ships a signer that silently can't sign** (known bug). | **ACCEPT-by-deletion.** Delete the QR watch-only path in extension (`isRemoteWallet`); model as `walletKind:'watch-only'`, `canSign:false`, honest gating. Re-add later only as a real remote-sign channel. |

---

## 3. ORDERED IMPLEMENTATION PLAN

Strict dependency order. Each step is shippable/tsc-green before the next. **STOP-GATE before Step 2:** run the R-12 migration/decision on all four orphaning seed classes.

### PHASE 0 â€” Foundation (privacy-sdk) â€” *blocks everything*

**0.1 â€” `packages/privacy-sdk/src/identity/constants.ts`** (NEW)
Export `IDENTITY_DOMAIN`, `HKDF_SALT`, `SPEND_INFO`, `VIEW_INFO`. Single source (R-06).

**0.2 â€” `packages/privacy-sdk/src/identity/signer.ts`** (NEW)
`interface UnifiedSigner { publicKey; kind: 'seed'|'software'|'hardware'; signTransaction; signMessage? }`, `type SignerKind`, `toUnifiedSigner(signer: Signer): UnifiedSigner`, exported `isKeypair` (promoted from `spendingKey.ts:57`). Classification: Keypairâ†’`seed`; WalletAdapter w/ `signMessage`â†’`software`; WalletAdapter w/oâ†’`hardware`.

**0.3 â€” `packages/privacy-sdk/src/types.ts`** (MODIFY)
Add optional `signMessage?: (msg: Uint8Array) => Promise<Uint8Array>` to `WalletAdapter` (after line 13). `Signer = Keypair | WalletAdapter` unchanged.

**0.4 â€” `packages/privacy-sdk/src/identity/spendingKey.ts`** (MODIFY)
Add `ViewingKey = Uint8Array & {__brand:'ViewingKey'}` + `asViewingKey`. Re-export `isKeypair` from `signer.ts` (drop the private dup). **Leave `deriveSpendingKeyFromSignature` / `SPENDING_KEY_DOMAIN` / `asSpendingKey` byte-for-byte unchanged** (R-05).

**0.5 â€” `packages/privacy-sdk/src/identity/deriveIdentity.ts`** (NEW)
`deriveP01Identity(signer, opts?) â†’ { spendingKey, viewingKey }`:
- `toUnifiedSigner`; obtain IKM: `seed`â†’`ed25519.sign(IDENTITY_DOMAIN, secretKey[0:32])`; `software`â†’`signMessage(IDENTITY_DOMAIN)`; `hardware`â†’sentinel (Â§1.8, experimental).
- **Twice-sign determinism gate (R-04)** for signature paths.
- HKDF per Â§1.3 â†’ `asSpendingKey`/`asViewingKey`.
- In-memory cache `Map<base58, {spendingKey, viewingKey}>`; `opts: {forceRefresh?, cache?}`; `clearP01Identity(pubkey?)`/`clearAllP01Identities()` zeroize-then-delete (R-08).
- JSDoc: ~64-bit ceiling (R-01), NON-INTERCHANGEABLE with legacy (R-05).

**0.6 â€” `packages/privacy-sdk/src/identity/sentinel.ts`** (NEW, experimental)
`MEMO_PROGRAM_ID`, `SENTINEL_BLOCKHASH` (assert 32-byte decode), `buildSentinelTransaction(pubkey, version)`, `extractFeePayerSignature`, plus the Â§1.8 post-sign verification (mutation check + ed25519-verify).

**0.7 â€” `packages/privacy-sdk/src/index.ts`** (MODIFY)
Export `deriveP01Identity`, `clearP01Identity`, `clearAllP01Identities`, `toUnifiedSigner`, `asViewingKey`, constants, types `UnifiedSigner`/`SignerKind`/`ViewingKey`. Optionally `buildSentinelTransaction`/`MEMO_PROGRAM_ID`.

**0.8 â€” `packages/privacy-sdk/src/identity/__tests__/parity.test.ts`** (NEW)
Cross-client parity (R-06): fixed IKM â†’ assert byte-identical HKDF spend/view vs mobile+extension vectors. Plus 8-byte-fold determinism, zeroize, twice-sign gate.

> Phase 0 is **purely additive** â€” zero forced downstream changes. `gold path` still wins whenever raw key reachable.

---

### PHASE 1 â€” Mobile Privy removal â€” *depends on Phase 0 for the SDK identity API; app-local seed stays `secretKey.slice(0,32)`*

**STOP-GATE (R-12):** migrate/decide all four orphaning seed classes first.

Ordered edits (broken-intermediate-safe):
1. **`services/solana/wallet.ts`** â€” add `deriveLocalNoteSeed()` (RENAMED per R-15, NOT `deriveP01Identity`) returning `{keypair, publicKey, noteSeed: secretKey.slice(0,32)}`. Add hardware/Ledger branch stub + `getSpendingSeed()` (used in Phase 4).
2. **`services/quantumWallet/signer.ts`** â€” delete Privy branch in `getCurrentWalletSigner` (27-44); body = `keypairToSigner(await getKeypair())`. Add `signMessage?` to `WalletSigner` for Phase 3.
3. **`stores/walletStore.ts`** â€” remove `isPrivyWallet`, `initializeWithPrivy` (242-332), the 4 privy-signer globals + **both** `getPrivyMessageSigner` builders are downstream (R-15); collapse `sendTransaction` dispatch (526-533) to `sendSol`. Drop `isPrivyWallet` from create/logout/initial state.
4. **`services/solana/transactions.ts`** â€” delete `sendSolWithSigner` (125-204).
5. **`stores/denominatedPoolStore.ts`** â€” delete `getWalletSignerIfPrivy` (436); collapse **all 9 sites incl 1785/1943/2206** (R-14, collapse 1785/1943 to `getState().publicKey`); collapse seed sites (839/891/2196) to `deriveLocalNoteSeed().noteSeed`.
6. **`stores/subscriptionVaultStore.ts`** (R-11, MISSED) â€” delete its own `getWalletSignerIfPrivy` (~234); collapse 10 sites (300/398/520/556/590/625/659/739/825/875); drop `getPrivySigner`/`getPrivyMessageSigner` imports (~46).
7. **`services/arcium/mpcClient.ts`** (R-11, MISSED) â€” drop `getPrivySigner`+`isPrivyWallet` imports (~17); collapse `getWalletInfo` (46-58) to `getKeypair` branch.
8. **`services/solana/streams.ts`** (R-13, MISSED) â€” drop dynamic `getPrivySigner` import (834); delete else-if (862-867), keep keypair+throw.
9. **`app/(main)/(privacy)/private-send.tsx`** (R-13, MISSED) â€” replace `getPrivySigner`-only signer (146-148) with keypair signer (else every private-send throws).
10. **`stores/autoShieldStore.ts`** â€” collapse `getCachedNoteSeed` ternary (225-235) to `mainKp.secretKey.slice(0,32)`.
11. **`stores/resetStores.ts`** (R-14, MISSED) â€” remove `clearNoteSeedCache` import+call (12/45) when the helper is deleted.
12. **`services/denominatedPool/index.ts`** â€” after importers fixed: delete `signMessage?` (1410-1415), `deriveSeedFromSigner`, `getPersistedNoteSeed`, `getCachedNoteSeed`, `clearNoteSeedCache`, `noteSeedCache`, `NOTE_SEED_*`.
13. **`services/zkspl/index.ts` + `services/stark/index.ts`** (R-12) â€” audit `p01_zk_seed` random-mnemonic fallback (730); keep-or-remove decision; add to data-loss warning.
14. **Per-screen dispatch** (Â§8 of mobile spec): subscribe/[id]/create/swap/shielded/shielded-transfer/send-split/backup/wallet-index/settings-index/denominated-shield â€” delete Privy branch, keep keypair.
15. **Auth UI**: rebuild `AuthScreen.tsx`, `(auth)/login.tsx`, `(onboarding)/index.tsx`, `components/auth/index.ts`; delete `PrivyLoginButton.tsx` (+ `EmailLoginForm` if orphaned). `auth-confirm.tsx` is **comment-only Privy** â†’ edit copy, not rebuild (R-15).
16. **`app/_layout.tsx`** â€” unwrap `<P01PrivyProvider>`.
17. **Delete**: `providers/PrivyProvider.tsx`, `config/privy.ts`.
18. **`services/auth/p01Auth.ts`** â€” drop HMAC fallback (259-274).
19. **Tests/env/metro/i18n/package.json** + clean `streams.test.ts` mock (R-15); `pnpm install`.
20. **Verify**: scope grep to identifiers (whitelist comment-only refs R-15); `pnpm tsc --noEmit`.

---

### PHASE 2 â€” Extension Privy removal â€” *depends on Phase 0; mirrors Phase 1*

1. **`shared/store/wallet.ts`** â€” remove Privy block (150-160), flags (`isPrivyWallet`/`isRemoteWallet`), `initializeWithPrivy`, collapse `sendTransaction` (542-614) to keypair, fix partialize/migrate (**bump versionâ†’2**; strip legacy flags; force re-onboard if `isPrivyWallet && !encryptedSeedPhrase` â€” fixes the keyless-"initialized" bug). Add `getActiveKeypair()`.
2. **(Recommended) `shared/services/signer.ts`** (NEW) â€” `getActiveSigner()`/`getWalletSeed()`.
3. **Signing services** â€” `zkspl.ts` (delete `deriveSpendingKeyForPrivy` 124-174 + data-loss warning R-14), `shielded.ts` (delete `getOrCreatePrivyZkSeed` 451-507 + `PRIVY_ZK_SEED_KEY` + cleartext fallback 495 per R-10 + data-loss warning), `denominatedPool.ts`, `subscriptionVault.ts`, `stream.ts` â€” drop `getPrivySigner`, collapse forks.
4. **`zk.ts`** â€” verify-only (no change).
5. **Delete** `providers/PrivyProvider.tsx`, `config/privy.ts`, `store/authAdapter.ts` (dead).
6. **Entry/routing** â€” `main.tsx`, `App.tsx`.
7. **Pages** â€” `Welcome.tsx` (drop email/OTP/**QR watch-only** R-16), `Settings.tsx`, `CreateSubscription.tsx` (158, 346-379), `Home.tsx`, `Unlock.tsx`, `DenominatedImport.tsx` (comment-only).
8. **`background/index.ts`** â€” `isWalletInitialized = !!encryptedSeedPhrase` (closes keyless-connect bug).
9. **Config** â€” `package.json` (drop `@privy-io/react-auth`), `vite-env.d.ts`, `.env*`.
10. **Tests** â€” Welcome/Settings/Unlock mocks + `setup.ts`.
11. **Verify** â€” `pnpm install`, `tsc`, `eslint`, `vitest`, `vite build`; resolve dangling refs.

---

### PHASE 3 â€” External connectors (Phantom/Solflare + Android MWA + iOS deeplink) â€” *depends on Phase 0 (UnifiedSigner + deriveP01Identity software path)*

**Mandatory shared change:** route external-wallet shielded identity through `deriveP01Identity` (software `signMessage` over `IDENTITY_DOMAIN`). Split each ZK service's `initialize(seedPhrase)` into `initializeWithSpendingKey(bytes)`; external path feeds HKDF spendingKey, legacy local path kept for back-compat/migration.

- **Mobile Android**: NEW `services/wallet/mwa.ts` (`connectMwa`, `makeMwaSigner` w/ `signMessages`), `services/wallet/connectExternal.ts` (platform router), `services/wallet/signer.ts`. MWA packages already resolved + autolinked; add to `package.json` deps explicitly. **Determinism test** asserting `sha256(MWA sig)` parity.
- **Mobile iOS**: NEW `services/wallet/phantomDeeplink.ts` (x25519 box handshake, `expo-linking` scheme `p01`, `app/onphantom.tsx` return route). `signMessage` deeplink â†’ full shielded; warn high-frequency.
- **Extension**: seed-import is PRIMARY (relabel honestly "Import wallet â€” Phantom/Solflare/any Solana seed"). Optional `https` bridge-tab for the one-shot identity ceremony only (popup-to-extension `window.solana` is **architecturally impossible** â€” do not attempt). NEW `shared/services/identity.ts` calling `deriveP01Identity`.
- **`walletKind`** persisted (`local-seed`/`software`/`hardware`/`watch-only`) with the R-02 per-account lock.
- **Web** (`apps/web`): already wired; reference model. No change.

---

### PHASE 4 â€” Hardware (Ledger) â€” *depends on Phase 0 (UnifiedSigner `hardware` kind) + Phase 3 (walletKind model)*

- **Spending seed**: CSPRNG 32-byte, encrypted at rest (R-02/R-04: never signature-derived). Extension `shared/services/spendingSeed.ts` (AES-GCM via `crypto.ts`, PBKDF2 â‰¥600k); mobile `services/ledger/spendingSeed.ts` (SecureStore).
- **Extension** (WebHID primary, WebUSB fallback â€” popup/connect-tab, NEVER service worker): NEW `shared/services/ledger/{transport,solanaApp,signer,sentinel,path}.ts`, `popup/pages/ConnectLedger.tsx`, `popup/components/LedgerReviewModal.tsx`. Packages: `@ledgerhq/hw-transport-webhid`, `-webusb`, `hw-app-solana`, `errors`.
- **Mobile** (BLE Nano X only; mutually-exclusive with note-sharing `BleManager`): NEW `services/ledger/{transport,solanaApp,signer,sentinel,spendingSeed}.ts`, `app/(main)/(settings)/connect-ledger.tsx`, `components/LedgerReviewSheet.tsx`. Packages: `@ledgerhq/react-native-hw-transport-ble`, `hw-app-solana`, `errors` (`react-native-ble-plx` present).
- **`Signer{kind:'hardware'}`**: `signTransaction` round-trips to device; **NO `signMessage`** (throws typed `LedgerNoMessageSigningError`). `getSpendingSeed()` returns decrypted local seed.
- **Integration seam**: every `getWalletSeed()`/`secretKey.slice(0,32)` site â†’ `await signer.getSpendingSeed()` (no-op for local).
- **Backup v2** (Â§1.7) â€” near-mandatory UX, prompted on connect + first shield.
- **Blind-sign**: pool program ix blind-signs (no clear-signing plugin) â€” one-time "enable blind signing" explainer gate.
- **Sentinel**: experimental opt-in only, Â§1.8 hardened, twice-sign gated.

---

### PHASE 5 â€” UI reshape â€” *depends on Phase 0 (wallet-kind model from 0.2) + the removal phases for the surfaces*

Driven by the work-units in Â§4. Critical path: U0a â†’ U0b â†’ (U1/U2/U3 âˆ¥ U4 âˆ¥ U6/U7) â†’ (U8/U9/U10/U11) â†’ U12 â†’ U13.

---

## 4. UI WORK-UNITS (prioritized, parallelizable â€” for the follow-up workflow)

**Tier 0 â€” shared foundation (do first; ~2 units parallel):**
- **U0a â€” Wallet-kind model + signer abstraction.** Replace `isPrivyWallet`/`isRemoteWallet`/`privySigner` with `walletKind`/`canSign`/`signer` in both `walletStore`s; **persist `walletKind` per-account with the R-02 lock**; generalize seed derivation to accept the abstraction; add the Ledger `getSpendingSeed` seam. *(Blocks all UI.)*
- **U0b â€” Wallet connection provider.** Extension: wallet-standard / seed-import provider. Mobile: MWA provider (Android) + Phantom deeplink (iOS). Replaces both `PrivyProvider.tsx`.

**Tier 1 â€” entry UI (parallel after Tier 0):**
- **U1 â€” Mobile Welcome/connection chooser** (`(onboarding)/index.tsx` + chooser). [U0a]
- **U2 â€” Mobile AuthScreen/login rebuild** (`(auth)/login.tsx`; delete `AuthScreen`/`PrivyLoginButton`/`EmailLoginForm`). [U0a, U0b]
- **U3 â€” Extension Welcome rebuild** (`Welcome.tsx` + test; drop email/OTP/QR-watch-only). [U0a, U0b]

**Tier 2 â€” identity & recovery UI (parallel):**
- **U4 â€” "Derive P01 identity" sign sheet** (shared, both apps): one-time + per-session re-prompt; wallet-kind-aware copy; Ledger explainer ("Ledger never sees your shielded balances"); honest message "only sign in the P01 app." [U0a]
- **U5 â€” RecoveryBootModal copy + signer re-point** (mobile): "nothing is signed" is FALSE for external wallets â€” make wallet-kind-aware. [U0a, U4]
- **U6 â€” Encrypted P01-identity export** (Settings â†’ Security; passphrase â‰¥ min, reveal/QR, screenshot guard, PBKDF2 â‰¥600k). Replaces (not hides) seed-backup for external/hardware wallets. [U0a]
- **U7 â€” P01-identity restore** (Welcome + Settings; paste/scan `p01id1:` blob â†’ rescan). [U0a, U6 format]

**Tier 3 â€” settings & flow cleanup (parallel):**
- **U8 â€” Mobile Settings** (single disconnect, drop Privy logout, backup row wallet-kind-aware). [U0a]
- **U9 â€” Extension Settings** (gate backup/change-password by `walletKind==='local-seed'`; disconnect copy; logoutâ†’adapter). [U0a]
- **U10 â€” Extension App.tsx routing gates** (4 Privy branches â†’ `isConnected`/`walletKind`). [U0a]
- **U11 â€” CreateSubscription signer + remote-wallet messaging** (ext `CreateSubscription.tsx:346-379` + mobile equivalents). [U0a, U0b]

**Tier 4 â€” sweep:**
- **U12 â€” Dependency + env + i18n cleanup** (remove `@privy-io/*`, `config/privy.ts`, `.env*` Privy keys, OTP/Privy i18n; add wallet-adapter/MWA/Ledger deps; `pnpm-lock.yaml`).
- **U13 â€” Test + static-gate pass** (tsc/vitest/build/lint both apps; update `Welcome.test.tsx`/`Settings.test.tsx`/`Unlock.test.tsx`/`streams.test.ts`).

---

## 5. KEY COMPATIBILITY INVARIANTS (must not break)

- `bytesToGoldilocks` reads bytes `[0..8)` LE, reduces mod `p=2^64âˆ’2^32+1` â€” HKDF leading 8 bytes become on-chain identity (deterministic).
- `ownerPubkeyGl = goldilocksHash2to1(spendingKeyGl, 0n)` (cycle-0, circuit 5) â€” unchanged.
- `SpendingKey`/`ViewingKey` exactly 32 bytes.
- `hkdf(sha256, ikm, salt, info, length)` arg order â€” verified.
- `deriveSpendingKeyFromSignature` byte-for-byte unchanged; `deriveP01Identity` is a NEW, NON-INTERCHANGEABLE key.
- Local seed path (`secretKey.slice(0,32)` â†’ HKDF) â€” gold path, untouched, default whenever raw key reachable.

---

## 6. OPEN QUESTIONS (need human decision)

1. **8-byte entropy widening (R-01):** Ship the circuit/note-format migration (Poseidon sponge over all 32 bytes â†’ multi-limb owner) to lift on-chain owner from ~64 to ~128+ bits? This is a hard note-migration (old notes invisible). Decision: scope now, or accept ~64 bits and only fix doc/marketing?
2. **R-12 orphaning seed classes â€” migrate or accept loss?** Four classes (mobile `p01_note_seed_v1_*`, mobile `p01_zk_seed`, ext `p01_privy_zk_seed`, ext `p01_zkspl_privy_seed_*`). Do any production users hold balances under these? If yes, build the one-time export/re-key migration **before** Phase 1/2 STOP-GATE; if no, accept with surfaced warning. **Hard blocker for the removal phases.**
3. **`p01_zk_seed` random-mnemonic fallback (R-12):** Keep it (reachable even for local wallets when `getKeypair`+mnemonic both miss) or remove it as a footgun? Affects zkSPL/stark recoverability.
4. **Versioned-tx path shift (R-15):** `relayerWrapper.ts`/`v3RelayerWrapper.ts` gate the v0-LUT path on `keypair!=null`; post-Privy all wallets become keypair-backed â†’ all shift to the versioned path. Confirm this is intended (it removes the legacy-tx branch for everyone).
5. **Sentinel-tx â€” ship at all?** Keep as experimental opt-in (hardened Â§1.8) for power users who insist on Ledger-derived keys, or drop entirely and rely solely on random-seed + opt-in backup? (Recommendation: drop unless a concrete user demands it.)
6. **iOS external-wallet scope:** Phantom deeplink `signMessage` has reported `-32603` flakiness. Ship iOS external-connect in this cycle, or restrict iOS to local-seed + Ledger-BLE and defer Phantom deeplink?
7. **Extension `https` bridge-tab (Phase 3 optional):** Build the non-custodial Phantom/Solflare bridge-tab for the identity ceremony, or ship extension with seed-import + Ledger only and defer true external-connect?
8. **PBKDF2 600k migration (R-10):** Re-wrap existing 100k-encrypted material on next unlock (transparent upgrade) or only apply 600k to new wallets?

---

**Verified-real findings incorporated:** all 16. **Files cross-checked against ground truth:** `goldilocks.ts:23`, `spendingKey.ts` (legacy `sha256(sig)`), `stealth.ts:166` (HKDF arg order), `zkspl/index.ts:730` (`generateMnemonic` random fallback), and the full mobile Privy-touchpoint set (`subscriptionVaultStore`, `arcium/mpcClient`, `streams`, `private-send`, `resetStores`, `streams.test`, `shieldedStore`) â€” all confirmed present and under-covered by the original per-subsystem specs, now folded into the plan.
