# Specter × STRK20 — Post-Quantum Recipient Discovery, coupled to Starknet Privacy

Status: **contract compiled, 2/2 snforge tests pass, deployed + e2e-proven on LOCAL starknet-devnet**
(send, announce, scan, deploy, sweep). Sepolia deploy pending a funded account. Reuses
`packages/specter-sdk` (ML-KEM PQ discovery, proven e2e on Solana devnet). Adds the minimum
chain-specific pieces. **Not audited.**

## What STRK20 is (verified)

STRK20 is StarkWare's **native** token-privacy framework (live mainnet, Starknet v0.14.2). A single
**Starknet Privacy Pool**: deposit any ERC-20 → transact privately (sender, recipient, token, amount
hidden) → withdraw. Every private tx is a **client-side ZK proof verified at the sequencer level** —
same proving infra Starknet uses for its own blocks. It also ships **viewing keys** for compliance.

**Consequence for us:** the pool + proving are **protocol-native (StarkWare's backend) — not
forkable.** We do NOT rebuild the pool (that would be a "homemade mixer", disqualifying) and we do NOT
touch the sequencer proving. We couple at the layers that ARE open: the **Privacy SDK / Wallet API**,
**our own contracts**, and the **note-encryption / recipient-discovery layer** — which is precisely
what STRK20 does NOT make post-quantum.

## The gap we fill (our differentiation)

StarkWare's PQ roadmap (Jun 30 2026) covers BLAKE2 state commitments + Falcon-512 consensus signatures
— **not** the note-encryption or recipient-discovery layer. Those rely on elliptic-curve crypto and
are posted on-chain permanently → **harvest-now-decrypt-later**: break the curve later, retroactively
deanonymize the whole pool history. We replace that layer with **X25519 + ML-KEM-768 hybrid**, already
built and proven on Solana.

> Correct framing (do not misstate): STRK20's *proof system* is hash-based and survives quantum. What
> does not survive is everything **encrypted with curve crypto and published permanently** — note
> ciphertexts, recipient discovery, and (classical) viewing keys. That is our scope.

## Reused as-is from `packages/specter-sdk` (zero new crypto)

`stealth/generate`, `stealth/derive`, `stealth/scan`, `stealth/announcement-v2`, `quantum/` (ML-KEM),
`@noble/*`. `quantum/` is already 100% chain-agnostic. The chain coupling lives behind an
`AnnouncementTransport { publish, scan }` interface (Solana impl exists; we add a Starknet impl).

## Three additions (each justified) + our customizations

**A. Cairo `pq_announcer` contract** (this dir, `src/pq_announcer.cairo`). The ONLY chain-specific
transport: store/emit ML-KEM ciphertext **chunks** as Cairo events on Sepolia. No token, no note, no
business logic — that's STRK20's job. *Our customization:* versioned `AnnouncementChunk` event with a
**viewing-key tag** and ephemeral pubkey + view tag, so the same events power PQ viewing-key
disclosure later.

**B. `StarknetTransport`** (TS, starknet.js) — implements `AnnouncementTransport`: `publish` = invoke
`announce(chunks)`; `scan` = `get_events`. Plugs the unchanged specter-sdk crypto onto contract A.
Proves the architecture is chain-agnostic (two transports: Solana program + Starknet contract).

**C. STRK20 Privacy Wallet API glue** (starknet.js). STRK20 executes the private transfer/claim into
the PQ-discovered stealth address. Clean split: **STRK20 = confidentiality of amounts/balances; us =
confidentiality + PQ durability of *who receives*.**

**Our customizations (beyond the buildathon MVP):**
- **Chain-agnostic PQ meta-address** — one recipient meta works Solana *and* STRK20 (StarkWare asked
  about exactly this).
- **PQ viewing keys** — post-quantum disclosure, replacing STRK20's classical viewing keys for the
  discovery layer.
- **Polished `/pay` web UI** (`apps/web/app/(pay)`) — our design, not a throwaway demo page.
- **First-class published `StarknetTransport`** in specter-sdk.

## Flow

```
Recipient                              Sender
 meta-address + ML-KEM pubkey ─publish→ encapsulate (quantum/)
                                        derive stealth address (stealth/derive)
                                        chunk KEM ciphertext (announcement-v2)
                                          │
                                   [Cairo pq_announcer]  ← events on Sepolia
                                          │
 scan events (StarknetTransport + stealth/scan)
 decapsulate → recover one-time key
 receive the private STRK20 transfer at the stealth address
 (STRK20 shield/transfer via Privacy Wallet API)
```

## What we can/cannot control (honesty)
- **Can:** our `pq_announcer` contract, the `StarknetTransport` adapter, the PQ discovery + PQ
  viewing-key layer, our web UI, and forking STRK20's **open-source token/SDK wrappers** for the
  viewing-key customization.
- **Cannot:** Starknet's sequencer-level proving / the native Privacy Pool internals (StarkWare's
  backend). We integrate via the SDK, not by modifying their proving.

## Dependencies / blockers
- **STRK20 Privacy SDK / Wallet API 0.10.3 access** (site says "reach out"). Plan B if gated: demo the
  PQ handshake + transfer to the stealth address with a standard Sepolia ERC-20, showing the exact
  branch point — the PQ value is intact.
- Cairo toolchain (scarb + starknet-foundry) to compile/deploy `pq_announcer`.
- Locate/vendor the STRK20 open-source contracts for the viewing-key fork (task #17).

## Out of scope (v1)
STRK20 pool internals; custom mixer; custom prover; relayer (sender-unlinkability lives in STRK20's
pool already); WOTS+/PQ signatures (Falcon-512 is on StarkWare's consensus roadmap).
