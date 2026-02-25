# Trust Model: zkSPL Confidential Balances

> **Status:** Current architecture (Feb 2026)
> **Severity:** Critical — the relayer receives private inputs including spending keys
> **Migration plan:** Client-side proving (see §4)

---

## 1. Summary

The zkSPL confidential balance system uses server-side proof generation via the Rust prover (relayer). This means **all private circuit inputs, including the user's spending key**, are sent to the relayer in plaintext over HTTPS.

This is a **trust-based privacy model**, not a cryptographic privacy model. The relayer is a trusted third party that must be assumed honest for confidentiality and fund safety guarantees to hold.

The denominated pool (shielded pool / Tornado Cash model) does NOT have this problem — proof generation happens client-side.

---

## 2. Comparison: Denominated Pool vs zkSPL

| Property | Denominated Pool (shielded) | zkSPL (confidential balances) |
|---|---|---|
| **Proving** | Client-side (snarkjs WASM or Rust prover locally) | Server-side (Rust prover via relayer) |
| **Private inputs** | Stay on the device | Sent to the relayer in plaintext |
| **Spending key** | N/A (nullifier_preimage + secret, not a spending key) | Sent to the relayer (`spending_key` field) |
| **Trust model** | Trustless — relayer only submits pre-built tx | Relayer = trusted third party |
| **Risk if relayer compromised** | Censorship only (can refuse to relay) | **Potential fund theft** (spending key leaked) |
| **Risk if relayer logs requests** | No privacy impact (only public data) | **Full deanonymization** (balances, amounts, identities) |
| **Network interception (no TLS)** | No impact on privacy | **Total privacy breach** |
| **Proof generation time** | ~3s (client-side via computeNewRootFromSubtrees) | ~3s (server-side Rust prover) |
| **Circuit** | `denominated_pool.circom` (4,273 constraints) | `confidential_balance.circom` (1,382 constraints) |

---

## 3. What the Relayer Receives — Complete Field List

### 3.1 POST /api/zkspl/prove/deposit

| Field | Type | Classification |
|---|---|---|
| `old_commitment` | Field element | Public input |
| `new_commitment` | Field element | Public input |
| `amount_hash` | Field element | Public input |
| `public_credit` | Amount deposited | Public input |
| `public_debit` | Always 0 | Public input |
| `token_mint` | Field element | Public input |
| `nonce` | Counter | Public input |
| `old_balance` | User's current balance | **PRIVATE — SECRET** |
| `old_salt` | Balance salt | **PRIVATE — SECRET** |
| `new_balance` | User's new balance | **PRIVATE — SECRET** |
| `new_salt` | New balance salt | **PRIVATE — SECRET** |
| `amount` | 0 for deposit | **PRIVATE** |
| `amount_salt` | 0 for deposit | **PRIVATE** |
| `spending_key` | User's spending key | **PRIVATE — CRITICAL SECRET** |
| `is_debit` | 0 for deposit | **PRIVATE** |

### 3.2 POST /api/zkspl/prove/withdraw

Same fields as deposit, except:
- `public_credit` = 0
- `public_debit` = amount withdrawn

### 3.3 POST /api/zkspl/prove/transfer

Same fields as deposit, except:
- `public_credit` = 0, `public_debit` = 0
- `amount` = transfer amount (**PRIVATE — SECRET**)
- `amount_salt` = amount salt (**PRIVATE — SECRET**)
- `is_debit` = 1 for sender, 0 for receiver

### 3.4 POST /api/zkspl/prove/balance-proof

| Field | Type | Classification |
|---|---|---|
| `balance_commitment` | Field element | Public input |
| `threshold` | Minimum balance | Public input |
| `token_mint` | Field element | Public input |
| `balance` | User's actual balance | **PRIVATE — SECRET** |
| `salt` | Balance salt | **PRIVATE — SECRET** |
| `spending_key` | User's spending key | **PRIVATE — CRITICAL SECRET** |

### 3.5 Why spending_key Cannot Be Removed

`spending_key` is a **required private input** in both circuits:

- **`confidential_balance.circom` (line 188):** `signal input spending_key;`
  Used in `OwnerDerivation()` → `owner_pubkey = Poseidon(spending_key)`
  The circuit verifies that the balance commitment belongs to the correct owner.

- **`balance_proof.circom` (line 94):** `signal input spending_key;`
  Same derivation — proves the prover knows the spending key for the committed balance.

Without `spending_key`, the circuit cannot verify ownership and proof generation fails.

---

## 4. Migration Plan: Client-Side Proving

### 4.1 Target Architecture

```
CURRENT (server-side):
  Mobile → [all private inputs] → Relayer → Rust Prover → proof → Mobile → on-chain

TARGET (client-side):
  Mobile → [local WASM prover] → proof → Relayer (optional, for tx submission only) → on-chain
```

### 4.2 Options

| Option | Latency | Trust | Complexity | Status |
|---|---|---|---|---|
| **A. snarkjs WASM on mobile** | ~60-180s | Trustless | Low | Feasible now (slow) |
| **B. Rust prover compiled to WASM** | ~10-30s | Trustless | Medium | Requires ark-circom WASM target |
| **C. Native Rust prover on device** | ~3-5s | Trustless | High | Requires React Native native module |
| **D. Trusted Execution Environment** | ~3s | TEE-trust | High | AWS Nitro Enclave or similar |
| **E. Accept trust model (current)** | ~3s | Relayer-trust | None | Current architecture |

### 4.3 Recommended Path

**Short-term (devnet):** Option E — accept the trust model, document it clearly (this document), restrict relayer access.

**Medium-term (pre-mainnet):** Option A or B — implement client-side proving with snarkjs WASM. The `confidential_balance` circuit has only 1,382 constraints (vs 4,273 for denominated_pool), so WASM proving should be faster. Target: <60s on modern mobile devices.

**Long-term (post-mainnet):** Option C — native Rust prover as a React Native module for ~3-5s proving time without trust.

### 4.4 Immediate Mitigations (Before Client-Side Proving)

1. **HTTPS-only** — enforce TLS for all relayer communication (already the case)
2. **No logging of private inputs** — audit relayer code to ensure request bodies with private inputs are never logged to disk, stdout, or monitoring services
3. **Memory clearing** — zero private input buffers in the Rust prover after proof generation
4. **Rate limiting** — prevent bulk extraction of spending keys via rapid proof requests
5. **Access control** — restrict `/api/zkspl/prove/*` endpoints to authenticated users only
6. **Ephemeral spending keys** — investigate whether the circuit can be modified to accept a derived per-session key instead of the master spending key (would limit blast radius of a compromise)

---

## 5. Threat Scenarios

### 5.1 Relayer Operator Turns Malicious

**Impact:** Can reconstruct all user balances, transfer amounts, and spending keys from logged requests. Could forge withdrawal transactions using stolen spending keys.

**Mitigation:** Client-side proving eliminates this entirely.

### 5.2 Relayer Server Compromised

**Impact:** Attacker gains access to request logs or real-time traffic. Same impact as 5.1.

**Mitigation:** No-log policy + memory clearing reduce exposure. Client-side proving eliminates.

### 5.3 Network MITM (TLS Downgrade)

**Impact:** All private inputs intercepted in transit.

**Mitigation:** Certificate pinning on mobile, HSTS on relayer.

### 5.4 Regulatory Subpoena

**Impact:** If relayer logs exist, all user financial data is discoverable.

**Mitigation:** No-log architecture. Client-side proving makes relayer unable to comply (no data to produce).

---

## 6. Comparison with Industry Standards

| Protocol | Proving Model | Trust Model |
|---|---|---|
| Tornado Cash | Client-side (browser) | Trustless |
| Railgun | Client-side (browser/mobile) | Trustless |
| Aztec Connect | Client-side + rollup prover | Rollup operator trust |
| Zcash | Client-side (native) | Trustless |
| **Protocol 01 — Denominated Pool** | **Client-side** | **Trustless** |
| **Protocol 01 — zkSPL** | **Server-side (relayer)** | **Relayer = trusted third party** |

Protocol 01's denominated pool is on par with industry standards. The zkSPL system is below industry standards for privacy and requires migration to client-side proving before mainnet.
