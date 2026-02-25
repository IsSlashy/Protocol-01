# Migration Plan: Shielded Pool v2 + SDK Wiring

> **Date:** Feb 2026
> **Scope:** Mobile + Extension frontend wiring to new denominated pool system
> **Status:** Analysis complete — no code changes yet

---

## Table of Contents

1. [Current State Audit — Mobile](#1-current-state-audit--mobile)
2. [Current State Audit — Extension](#2-current-state-audit--extension)
3. [Gap Analysis](#3-gap-analysis)
4. [Migration Plan by Action](#4-migration-plan-by-action)
5. [What Can Be Migrated Without UX Changes](#5-what-can-be-migrated-without-ux-changes)
6. [What Changes the UX — Fixed Denominations](#6-what-changes-the-ux--fixed-denominations)
7. [Priority Order](#7-priority-order)

---

## 1. Current State Audit — Mobile

**App:** `apps/mobile/` (Expo/React Native)

### 1.1 Shielded Wallet (`(privacy)/shielded.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Shield** (deposit) | `zk_shielded` (`8dK17Nx...`) | None (no proof) | N/A | None — amount is public |
| **Unshield** (withdraw) | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness: note amounts, owner pubkeys, randomness, merkle paths (20 levels), spending key, nullifiers |
| **Transfer** (shielded→shielded) | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness: 2 input notes, 2 output notes, merkle proofs, spending key |

**Service:** `ZkService` in `apps/mobile/services/zk/index.ts` (~44,000 lines)
**Store:** `useShieldedStore` in `stores/shieldedStore.ts`
**Proof flow:** `generateProofClientSide()` → `generateProofViaBackend()` → POST `{relayerUrl}/prove` → Rust ark-circom. Fallback: local snarkjs WASM (~3 min, effectively unusable on mobile).

### 1.2 Shielded Transfer (`(privacy)/shielded-transfer.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Transfer to ZK address** | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness (same as above) |

Recipient format: `zk:<base64(pubkey + viewingKey)>`. Recipient note data shared out-of-band.

### 1.3 Confidential Balance (`(privacy)/confidential.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Deposit** | `p01_zkspl` (`EqppogL...`) | `confidential_balance.circom` | **Server-side (relayer)** | old_balance, new_balance, old_salt, new_salt, spending_key, is_debit |
| **Withdraw** | `p01_zkspl` | `confidential_balance.circom` | **Server-side (relayer)** | Same as deposit |
| **Transfer** | `p01_zkspl` | `confidential_balance.circom` | **Server-side (relayer)** | Same + amount, amount_salt |
| **Apply Pending** | `p01_zkspl` | `confidential_balance.circom` | **Server-side (relayer)** | amount, amount_salt, balance, salt |
| **Sweep to Main** | `p01_zkspl` + `zk_shielded` | Both circuits | **Both server-side** | Both witnesses |

**Service:** `ZkSplService` in `apps/mobile/services/zkspl/index.ts` (~604 lines)
**Store:** `useConfidentialStore` in `stores/confidentialStore.ts`
**Proof flow:** POST `{relayerUrl}/api/zkspl/prove/{operation}` → Rust prover. No usable client-side fallback.

### 1.4 ZK Private Subscription

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **processZkPayment** | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness |
| **processFullyPrivatePayment** | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness + stealth derivation |
| **processZkStreamPayment** | `zk_shielded` | `transfer.circom` | **Server-side (relayer)** | Full witness |

**Service:** `apps/mobile/services/solana/privateSubscription.ts` (157 lines) — thin wrapper around `ZkService`.

### 1.5 Mobile Summary

| System | Proof Location | Relayer Sees Spending Key | Relayer Sees Balances |
|--------|---------------|--------------------------|----------------------|
| Shielded Pool | Server (relayer) | **YES** | **YES** (note amounts) |
| zkSPL | Server (relayer) | **YES** | **YES** (balance + salt) |
| Denominated Pool | **NOT WIRED** | — | — |

**CRITICAL:** On mobile, ALL proving is server-side. The relayer is a fully trusted party for both systems.

---

## 2. Current State Audit — Extension

**App:** `apps/extension/` (React + Vite + Tailwind)

### 2.1 Shielded Wallet (`ShieldedWallet.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Shield** | `zk_shielded` | None | N/A | None |
| **Unshield** | `zk_shielded` | `transfer.circom` | **Client-side (Web Worker)** | **None — stays local** |
| **Transfer** | `zk_shielded` | `transfer.circom` | **Client-side (Web Worker)** | **None — stays local** |

**Service:** `ZkServiceExtension` in `apps/extension/src/shared/services/zk.ts` (~1,900 lines)
**Proof flow:** Web Worker (`zkProver.worker.ts`) → snarkjs in-browser. Circuit files bundled at `public/circuits/transfer.wasm` + `transfer_final.zkey`.

### 2.2 Shielded Transfer (`ShieldedTransfer.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Transfer to ZK address** | `zk_shielded` | `transfer.circom` | **Client-side (Web Worker)** | **None** |

### 2.3 Stealth Payments (`StealthPayments.tsx`)

| Action | On-Chain Program | Circuit | Proving | Notes |
|--------|------------------|---------|---------|-------|
| **Scan** | Read-only | N/A | N/A | Blockchain scan with viewing key |
| **Sweep** | `zk_shielded` | `transfer.circom` | **Client-side** | Recovers stealth UTXOs |

### 2.4 Confidential Wallet (`ConfidentialWallet.tsx`)

| Action | On-Chain Program | Circuit | Proving | Private Inputs to Relayer |
|--------|------------------|---------|---------|---------------------------|
| **Deposit** | `p01_zkspl` | None (no proof) | N/A | None |
| **Withdraw** | `p01_zkspl` | `confidential_balance.circom` | **Server-side (relayer)** | balance, salt, owner_pubkey, mint, new values |
| **Transfer** | `p01_zkspl` | `confidential_balance.circom` | **Server-side (relayer)** | Same + amount_salt, recipient |

**Service:** `apps/extension/src/shared/services/zkspl.ts`
**Store:** `apps/extension/src/shared/store/confidential.ts`
**Relayer:** `VITE_RELAYER_URL` → `https://p01-relayer-production.up.railway.app`

### 2.5 Extension Summary

| System | Proof Location | Relayer Sees Spending Key | Relayer Sees Balances |
|--------|---------------|--------------------------|----------------------|
| Shielded Pool | **Client-side (Web Worker)** | **NO** | **NO** |
| zkSPL | Server (relayer) | **YES** | **YES** |
| Denominated Pool | **NOT WIRED** | — | — |

**KEY DIFFERENCE:** Extension does shielded pool proving client-side. Mobile does not. This is an inconsistency — the extension is more secure for the shielded pool.

---

## 3. Gap Analysis

### 3.1 What Exists But Isn't Wired

| Component | Status | Where |
|-----------|--------|-------|
| Denominated Pool program | **Deployed on devnet** | `zk_shielded` program, `init_denominated_pool` / `shield_denominated` / `unshield_denominated` instructions |
| Denominated Pool circuit | **Built, tested** | `circuits/denominated_pool.circom` (4,273 constraints) |
| Denominated Pool VK | **Uploaded to devnet** | Via `scripts/upload-vk.mjs` |
| USDC pools (1/10/100/1000) | **Created on devnet** | Via `scripts/setup-usdc-denominated-pools.mjs` |
| Dynamic Time Delay | **Code written** (Agent 1) | `programs/zk_shielded/src/state/pool.rs` — NOT deployed (pools need recreation with new state size) |
| SDK shielded-pool module | **Written** (Agent 2) | `packages/p01-js/src/shielded-pool.ts` — has Poseidon placeholder (SHA-256) |
| Private Stream SDK | **Written** (Agent 3) | `packages/p01-js/src/private-stream.ts` — platform-agnostic, needs wiring |
| Private Subscription SDK | **Written** (Agent 4) | `packages/p01-js/src/private-subscription.ts` — platform-agnostic, needs wiring |

### 3.2 What's Missing

| Gap | Impact | Effort |
|-----|--------|--------|
| No mobile/extension UI for denominated pools | Users can't use fixed-denomination privacy | Large — new screens + denomination picker |
| No client-side proving for denominated_pool on mobile | Would need relayer (same trust issue as today) OR WASM prover | Medium — circuit is 4,273 constraints, ~250ms in browser |
| No USDC support in mobile shielded wallet | Only SOL deposits/withdrawals | Medium — ATA derivation + token account handling |
| SDK Poseidon placeholder | SDK can't generate real commitments | Small — add circomlibjs as peer dep |
| Dynamic delay not deployed | Old pools don't have new state fields | Small — recreate pools on devnet |
| Private Stream/Subscription SDK not wired to mobile | SDK exists but mobile still uses old direct ZkService calls | Medium — callback wiring |

### 3.3 Trust Model Inconsistency

```
                        Shielded Pool        zkSPL
Mobile proving:         SERVER (relayer)     SERVER (relayer)
Extension proving:      CLIENT (Web Worker)  SERVER (relayer)
Denominated Pool:       NOT WIRED            N/A
```

The extension is strictly more secure than mobile for the shielded pool. Both platforms have the same relayer-trust issue for zkSPL.

---

## 4. Migration Plan by Action

### 4.1 Shielded Pool → Denominated Pool

| Action | Current | Target | Effort | Impact | UX Change |
|--------|---------|--------|--------|--------|-----------|
| **Shield (deposit)** | Variable amount → `zk_shielded` pool | Fixed denomination → `denominated_pool` | **Medium** | High | **BREAKING** — user must pick denomination (1/10/100/1000 USDC or equivalent SOL) |
| **Unshield (withdraw)** | Variable amount, `transfer.circom` proof | Fixed denomination, `denominated_pool.circom` proof | **Medium** | High | **Visible** — user withdraws exact denomination, delay depends on anonymity set |
| **Transfer (shielded→shielded)** | Direct transfer via `transfer.circom` | **Two-step: unshield → re-shield** (no direct transfer in denominated pool) | **Large** | High | **BREAKING** — no direct shielded-to-shielded transfer in denominated pools |
| **ZK Subscription** | `processZkPayment()` → unshield to recipient | Same flow but via denominated pool unshield | **Medium** | Medium | **Invisible** if denomination matches subscription amount |
| **Stealth payments** | `unshieldStealth()` → stealth address | Same but via denominated pool + stealth address derivation | **Medium** | Medium | **Invisible** |

### 4.2 zkSPL (Confidential Balances) — No Migration Needed

zkSPL is a separate system (account-model, not UTXO). No migration required. The only action item is migrating to client-side proving (see `docs/trust-model-zkspl.md`).

### 4.3 Proving Migration

| Platform | Current | Target | Effort | Impact |
|----------|---------|--------|--------|--------|
| **Mobile — shielded pool** | Server (relayer) | Client-side snarkjs WASM or native Rust module | **Large** | **Invisible** — same UX, better security |
| **Extension — shielded pool** | Client (Web Worker) | Already correct | **None** | N/A |
| **Mobile — denominated pool** | Not wired | Client-side snarkjs WASM (4,273 constraints → ~250ms warm) | **Medium** | N/A (new feature) |
| **Extension — denominated pool** | Not wired | Client-side Web Worker (same approach as current shielded) | **Medium** | N/A (new feature) |
| **Both — zkSPL** | Server (relayer) | Client-side WASM (1,382 constraints → should be fast) | **Large** | **Invisible** — same UX, removes relayer trust |

---

## 5. What Can Be Migrated Without UX Changes

These changes swap the backend while keeping the UI identical. **Priority: do these first.**

### 5.1 Mobile: Client-Side Proving for Shielded Pool

**Current:** Mobile sends full witness to relayer for `transfer.circom` proof.
**Target:** Generate proof locally (like the extension already does).

**What changes:**
- `ZkService.generateProofViaBackend()` → `ZkService.generateProofLocally()` using snarkjs WASM
- Bundle `transfer.wasm` + `transfer_final.zkey` in the mobile app assets
- Remove the relayer `/prove` call from the shielded pool flow

**Why it's invisible:** User sees the same shield/unshield/transfer screens. The proof takes ~3s locally (vs ~3s via relayer). No UX difference.

**Effort:** Medium — snarkjs WASM works in React Native but needs testing. The extension proves it's fast enough (~200ms in browser). Mobile WASM may be slower but manageable for 4,000-constraint circuit.

**Risk:** snarkjs WASM performance on low-end Android. Mitigation: keep relayer as opt-in fallback.

### 5.2 Extension: Already Correct

The extension already does client-side proving for the shielded pool. No migration needed.

### 5.3 ZK Subscription Backend Swap

**Current:** `processZkPayment()` calls `zkService.unshield()` → relayer proof → `zk_shielded` program.
**Target:** `processZkPayment()` calls denominated pool unshield → client-side proof → `zk_shielded` `unshield_denominated` instruction.

**Why it's invisible:** The subscription UI shows "Payment processing..." and a progress bar. The user doesn't see which program or circuit is used. The payment amount must match a denomination — this is the constraint that may require UX changes for non-standard amounts.

**Effort:** Medium — need to map subscription amounts to denominations. A 10 USDC/month subscription maps cleanly to the 10 USDC pool. A 7 USDC/month subscription does NOT map cleanly — would need 1+1+1+1+1+1+1 USDC or a different approach.

### 5.4 zkSPL Deposit (No Proof Needed)

**Current:** zkSPL deposit creates account + transfers tokens. No ZK proof involved.
**Target:** Same. No changes needed.

---

## 6. What Changes the UX — Fixed Denominations

### 6.1 The Fundamental UX Shift

**Old system (variable amounts):**
```
User: "Shield 3.7 SOL"
→ One transaction, 3.7 SOL goes into shielded pool
→ One note: { amount: 3.7 SOL, commitment: ... }
```

**New system (fixed denominations):**
```
User: "I want to shield 3.7 SOL"
→ Cannot shield 3.7 SOL directly
→ Must choose: 3× 1 SOL notes + 0.7 SOL unshieldable
→ Or: rethink the amount
```

This is a fundamental UX change. The user can no longer deposit arbitrary amounts. They must think in denominations.

### 6.2 Proposed UI: Denomination Picker

#### Shield (Deposit) Screen — Textual Wireframe

```
┌─────────────────────────────────────┐
│  SHIELD INTO PRIVACY POOL           │
│                                     │
│  Token: [SOL ▼]  [USDC ▼]          │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  Pick denomination:          │    │
│  │                              │    │
│  │  [ 1 USDC ]  [ 10 USDC ]   │    │
│  │  [100 USDC]  [1000 USDC]   │    │
│  │                              │    │
│  │  Selected: 10 USDC          │    │
│  │  Quantity: [  3  ] [-] [+]  │    │
│  │                              │    │
│  │  Total: 30 USDC              │    │
│  │  Pool size: 847 notes        │    │
│  │  Est. delay: ~1 epoch (1h)   │    │
│  └─────────────────────────────┘    │
│                                     │
│  Your USDC balance: 156.42          │
│  After shield: 126.42              │
│                                     │
│  ┌─────────────────────────────┐    │
│  │     [ SHIELD 30 USDC ]      │    │
│  └─────────────────────────────┘    │
│                                     │
│  ℹ All notes in a pool look        │
│    identical. Larger pools =        │
│    more privacy.                    │
└─────────────────────────────────────┘
```

**Key UX elements:**
- Token selector (SOL / USDC)
- Denomination buttons (1 / 10 / 100 / 1000) — greyed out if balance insufficient
- Quantity spinner — how many notes of that denomination
- Pool info — shows anonymity set size and estimated withdrawal delay
- Total amount calculated automatically
- Educational hint about why fixed denominations exist

#### Unshield (Withdraw) Screen — Textual Wireframe

```
┌─────────────────────────────────────┐
│  UNSHIELD FROM PRIVACY POOL        │
│                                     │
│  Your shielded notes:               │
│  ┌─────────────────────────────┐    │
│  │  3× 10 USDC  (pool: 847)   │    │
│  │  1× 100 USDC (pool: 312)   │    │
│  │  2× 1 USDC   (pool: 2,401) │    │
│  └─────────────────────────────┘    │
│                                     │
│  Select notes to unshield:          │
│  ┌─────────────────────────────┐    │
│  │ [✓] 10 USDC note #1         │    │
│  │     Shielded: 2h ago        │    │
│  │     Delay: ready now ✓      │    │
│  │                              │    │
│  │ [✓] 10 USDC note #2         │    │
│  │     Shielded: 2h ago        │    │
│  │     Delay: ready now ✓      │    │
│  │                              │    │
│  │ [ ] 10 USDC note #3         │    │
│  │     Shielded: 15 min ago    │    │
│  │     Delay: ~45 min ⏳       │    │
│  └─────────────────────────────┘    │
│                                     │
│  Total to unshield: 20 USDC        │
│  Recipient: [main wallet ▼]        │
│                                     │
│  ┌─────────────────────────────┐    │
│  │    [ UNSHIELD 20 USDC ]     │    │
│  └─────────────────────────────┘    │
└─────────────────────────────────────┘
```

**Key UX elements:**
- Grouped by denomination — user sees their note inventory
- Per-note status — ready vs waiting (dynamic delay)
- Checkboxes for selecting which notes to unshield
- Pool size shown for privacy context
- Cannot select notes that haven't met delay requirement

### 6.3 Migration Path for Existing Shielded Balances

Users with existing variable-amount notes in the old `zk_shielded` pool need a migration path:

```
Old note (3.7 SOL in variable pool)
  → Unshield to public wallet (old system)
  → Re-shield as denominated notes (new system):
    3× 1 SOL into 1-SOL pool
    + 0.7 SOL stays public
```

**UI for migration:**
```
┌─────────────────────────────────────┐
│  ⚠ MIGRATE SHIELDED BALANCE        │
│                                     │
│  You have 3.7 SOL in the old        │
│  privacy pool. The new system uses  │
│  fixed denominations for stronger   │
│  privacy.                           │
│                                     │
│  Suggested migration:               │
│  → Unshield 3.7 SOL (old pool)     │
│  → Re-shield as:                    │
│    3× 1 SOL (new denominated pool) │
│    0.7 SOL stays in public wallet  │
│                                     │
│  [ MIGRATE NOW ]  [ LATER ]        │
└─────────────────────────────────────┘
```

### 6.4 Transfer UX Changes

**Old:** "Transfer 2.5 SOL to zk:abc123..." — single transaction.

**New:** No direct shielded-to-shielded transfer in denominated pools. Two options:

**Option A: Unshield → Public transfer → Recipient shields**
- Breaks privacy (public transfer visible)
- Simple UX

**Option B: Unshield → Re-shield to recipient's stealth address** (via denominated pool)
- Maintains privacy
- User selects notes → unshields → auto-shields to recipient
- UX shows multi-step progress

**Option C: Keep old shielded pool for transfers, use denominated pool only for storage**
- Best of both worlds but increases complexity
- Two pool systems running simultaneously

**Recommendation:** Option B for privacy-critical flows, Option A as fallback. Hide the complexity behind a "Private Transfer" button that handles the multi-step flow automatically.

---

## 7. Priority Order

### Phase 1 — Invisible Backend Improvements (No UX Changes)

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 1.1 | **Mobile client-side proving for shielded pool** — bundle transfer.wasm + zkey, generate proofs locally like extension does | Medium | Removes relayer trust for shielded pool on mobile |
| 1.2 | **Recreate devnet pools** with new state size (dynamic delay fields) | Small | Unblocks Agent 1 work |
| 1.3 | **Add Poseidon to p01-js SDK** — circomlibjs as peer dependency, replace SHA-256 placeholder | Small | Unblocks real SDK integration |

### Phase 2 — New Denominated Pool UI

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 2.1 | **Denomination picker component** — shared between mobile and extension | Medium | New UX paradigm for shielding |
| 2.2 | **Note inventory component** — shows user's denominated notes grouped by pool | Medium | New UX for managing shielded funds |
| 2.3 | **Shield flow (denominated)** — mobile + extension | Medium | Users can deposit into denominated pools |
| 2.4 | **Unshield flow (denominated)** — mobile + extension, with delay status | Medium | Users can withdraw from denominated pools |
| 2.5 | **Client-side proving for denominated_pool.circom** — bundle WASM + zkey | Medium | 4,273 constraints, ~250ms in browser |

### Phase 3 — SDK Wiring

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 3.1 | **Wire Private Stream SDK** to mobile — callback implementation using denominated pool unshield | Medium | Enables recurring private payments |
| 3.2 | **Wire Private Subscription SDK** to mobile — same callback pattern | Medium | Enables private subscriptions via SDK |
| 3.3 | **Wire both to extension** | Medium | Extension parity |

### Phase 4 — zkSPL Client-Side Proving

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 4.1 | **snarkjs WASM for confidential_balance.circom** on mobile | Large | Removes relayer trust for zkSPL |
| 4.2 | **Same for extension** (Web Worker, like shielded pool already does) | Medium | Extension zkSPL goes trustless |
| 4.3 | **Remove /api/zkspl/prove/* endpoints** from relayer (or make opt-in) | Small | Reduces attack surface |

### Phase 5 — Migration + Polish

| # | Task | Effort | Impact |
|---|------|--------|--------|
| 5.1 | **Old balance migration flow** — UI to help users move from variable to denominated | Medium | Smooth transition for existing users |
| 5.2 | **USDC support in mobile/extension** — token selector, ATA derivation | Medium | Multi-token privacy |
| 5.3 | **Private transfer via denominated pool** — multi-step unshield→re-shield flow | Large | Enables private p2p transfers |
| 5.4 | **Deprecate old shielded pool UI** — hide or remove variable-amount screens | Small | Simplifies codebase |

---

## Appendix A: Proving Trust Model by Platform × System

```
                    Shielded Pool           zkSPL              Denominated Pool
                    (transfer.circom)       (conf_balance)     (denom_pool.circom)
                    ─────────────────       ──────────────     ───────────────────
Mobile NOW:         SERVER (relayer)        SERVER (relayer)   NOT WIRED
Mobile TARGET:      CLIENT (WASM)           CLIENT (WASM)      CLIENT (WASM)

Extension NOW:      CLIENT (Web Worker)     SERVER (relayer)   NOT WIRED
Extension TARGET:   CLIENT (Web Worker)     CLIENT (Worker)    CLIENT (Web Worker)
```

## Appendix B: Circuit Comparison

| Circuit | Constraints | Proving (WASM) | Proving (Rust) | Public Inputs | Private Inputs |
|---------|-------------|-----------------|----------------|---------------|----------------|
| `transfer.circom` | ~4,000 | ~200ms (browser) | ~50ms | 7 (root, nullifiers, commitments, amount, mint) | ~30 (notes, paths, keys) |
| `denominated_pool.circom` | 4,273 | ~250ms (browser) | ~50ms | 4 (root, nullifier, min_epoch, mint) | 33 (secret, paths, epoch) |
| `confidential_balance.circom` | 1,382 | ~100ms (browser) | ~30ms | 7 (commitments, credit/debit, mint, nonce) | 8 (balances, salts, key) |
| `balance_proof.circom` | 644 | ~50ms (browser) | ~20ms | 3 (commitment, threshold, mint) | 3 (balance, salt, key) |

All circuits are small enough for client-side WASM proving on modern devices. The `transfer.circom` already proves this in the extension (~200ms).

## Appendix C: Private Inputs Sent to Relayer — Complete Inventory

### Routes That Send Private Inputs (CURRENT)

| Route | Fields | Includes Spending Key |
|-------|--------|-----------------------|
| `POST /prove` (shielded pool, mobile only) | Full witness (~30 fields) | **YES** |
| `POST /api/zkspl/prove/deposit` | 15 fields | **YES** |
| `POST /api/zkspl/prove/withdraw` | 15 fields | **YES** |
| `POST /api/zkspl/prove/transfer` | 15 fields | **YES** |
| `POST /api/zkspl/prove/balance-proof` | 6 fields | **YES** |

### Routes That Do NOT Send Private Inputs

| Route | Purpose | Data Sent |
|-------|---------|-----------|
| `POST /relay` (shielded pool, extension) | Submit pre-built tx | Signed transaction only |
| `GET /api/pool/:mint/info` | Pool metadata | None |
| `GET /api/commitments/:pool` | Merkle tree sync | None |

### Target State (After Migration)

All proof generation routes should be eliminated or made opt-in. Every route should look like the extension's current shielded pool model: client generates proof, sends only the signed transaction to the relayer for submission.
