# Pitch Script & Q&A — X Quantum Dublin
**2026-05-24 · 3-minute slot · English**
**Team: Slashy · Alex · Sam**

> Companion script for `docs/pitch-x-quantum-2026-05-24.html`.
> Read on your phone during waiting time, NOT on stage.
> The deck is silent — every word below comes from your mouth, not the screen.
>
> **Coordinate with Alex & Sam beforehand**: decide who speaks which section, who handles which Q&A category (e.g., Slashy = crypto Q1/Q2/Q4, Alex = product Q3/Q6, Sam = business Q8/Q10). Avoid stepping on each other live.

---

## Delivery rules

- **180 seconds total.** 30s per slide × 6 slides. Use a stopwatch the first practice run.
- **Eye contact > slides.** Glance at the deck only when transitioning.
- **One pause per slide.** Beat after the headline. Lets the room catch up.
- **Stop talking when you're done.** Do not over-fill the silence. The judges' first question is louder than your filler.
- **Water bottle within reach.** Drink between questions, never mid-sentence.

---

## SLIDE 1 — Cover (15s)

> **Say:**
> "Protocol 01. Post-quantum private subscriptions on Solana. You can subscribe, pause, and cancel — and neither the merchant nor anyone who hacks them will ever know it was you. Today, I'll show you how."

**Beat. Click.**

---

## SLIDE 2 — The Problem (30s)

> **Say:**
> "Every subscription you hold today sits in a database with your name, your card, and your viewing history. Those databases leak. 23andMe, LastPass, Disney+ — every year, every month, every week.
>
> And tomorrow it gets worse. When quantum computers come online — in five to ten years — every Ed25519 signature ever signed on Solana becomes replayable. Harvest-now, decrypt-later isn't theoretical. It's happening today."

**Beat. Click.**

**Backup facts if pressed:**
- 23andMe 2023: 6.9M users leaked
- LastPass 2022: full vault leak
- NIST PQ deadline: governments migrating by 2030–2035
- Solana has zero PQ today

---

## SLIDE 3 — The Solution (45s)

> **Say:**
> "Three guarantees. All shipped on devnet today.
>
> **One.** The merchant never sees your wallet. They verify a STARK proof on-chain that confirms one fact: a valid subscription exists for this period. Nothing else.
>
> **Two.** Their database stores only 32-byte hashes — no card, no email, no address. When the breach comes — and it will come — the attacker gets meaningless bytes. Nothing to sell.
>
> **Three.** The authentication uses STARK proofs over Goldilocks and Poseidon hashes. Zero elliptic curves. Shor's algorithm cannot break it. We are post-quantum today, not in five years."

**Beat. Click.**

**Tagline to land:** *"Prove who paid. Never reveal who."*

---

## SLIDE 4 — How it works (45s)

> **Say:**
> "Four steps.
>
> One: you shield funds into a denominated pool. Everyone deposits the same amount. Your funds become indistinguishable from N others. You receive a Poseidon commitment — that's your anonymous identity.
>
> Two: you subscribe by binding that commitment to the merchant's vault, with a STARK proof that you own it.
>
> Three: each period, your phone generates a fresh STARK proof. The merchant verifies it on-chain and issues an ephemeral session token — think NordVPN.
>
> Four: pause, resume, or cancel anytime. Same STARK auth flow.
>
> On the merchant side, the database literally contains: service ID, a 32-byte commitment, a state, and a slot number. That's it. No PII. Anywhere."

**Beat. Click.**

**Technical depth if pressed:**
- Circuit-0 STARK proves Poseidon preimage ownership
- ~8–15s on mobile, ~1.3M CU on-chain
- Vault state machine prevents replay
- Cancel routes residual via `p01_relayer` RefundJob → keeper bundles atomic shield+process tx with stealth commitment, refund lands as a fresh anonymous note

---

## SLIDE 5 — Demo (30s)

> **Say:**
> "Let me show you. [Switch to phone mirror.] Disney+, monthly subscription. I tap subscribe. STARK proof generates on-device in about ten seconds. Confirmed on Solana devnet. Service unlocked.
>
> Pause — freezes the vault, no further periods charge. Resume — same flow. Cancel — refund routes through our relayer, lands as a fresh anonymous commitment. End-to-end private. End-to-end quantum-safe."

**Beat. Click.**

**Demo fallback order:**
1. **Plan A** — Live on Galaxy via scrcpy, subscribe to a new merchant.
2. **Plan B** — Pre-recorded 60s mp4 in `docs/demo/`. Talk over it.
3. **Plan C** — Solana explorer link, show last 5 STARK-verified txs from `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`.

---

## SLIDE 6 — Shipped & Ask (15s)

> **Say:**
> "This is shipped today. Twelve programs, six STARK circuits, live on devnet. We placed number two worldwide at Dev3Pack and went live first on X during Demo Day.
>
> Slashy, Alex, and Sam — solo founder plus two builders who joined for Dublin. What we're looking for: design partners, grants for the multi-spend STARK vault, and an audit budget. Three lines to integrate the SDK.
>
> Thank you."

**Stop talking. Look up. Wait.**

---

## Q&A Bank — 10 questions ranked by likelihood

> Each answer is engineered to fit in **~30 seconds**. Do not over-answer. If asked something not in this bank, take one breath, then say: *"Honest answer — I don't have that data on me, but here's how I'd approach it..."* and reason out loud. Judges respect honesty.

---

### Q1 — How is this different from Umbra?

> "Umbra uses Groth16 over BN254 for the anonymity layer, plus Arcium MPC for confidential arithmetic. Both have weaknesses we don't share.
>
> Groth16 on BN254 is elliptic-curve based — Shor breaks it. Plus a trusted setup ceremony per circuit, which is operational risk. Arcium MPC introduces committee trust — if a threshold of nodes colludes, the cleartext leaks.
>
> We use STARK over Goldilocks. Transparent, no trusted setup. Hash-based, post-quantum sound. No committee. Same family in spirit. Different security model. Think AMD versus Nvidia — we're the leaner, Solana-native alternative."

---

### Q2 — What stops merchants from colluding to deanonymize users?

> "The STARK proof reveals exactly one fact: the holder of commitment X has a valid subscription with merchant M at period P. That's it.
>
> If all merchants pool their data, they see N distinct commitments per user — each unlinkable to a wallet, an IP, or each other. The denominated pool guarantees the anonymity set: if a hundred people deposit the same denomination, your commitment is indistinguishable from ninety-nine others.
>
> For maximum unlinkability, the SDK can HKDF-derive a fresh commitment per service from your spending key. Then even colluding merchants cannot correlate across services."

---

### Q3 — What's the user-perceived latency?

> "End-to-end on a mid-range Android: roughly eight to fifteen seconds for the STARK proof to generate on-device. Three to five seconds to upload the proof buffer — about 145 kilobytes. Two to three seconds for on-chain verification, around 1.3 million compute units.
>
> Total: fifteen to twenty-five seconds for a one-time subscribe. Pause, resume, and cancel are the same.
>
> Compare that to OAuth plus 2FA plus card 3DS in the real world: about thirty seconds. We're competitive. Roadmap: precomputed proof pool for instant-tap UX."

---

### Q4 — Why STARK and not Groth16 or PLONK?

> "Four reasons.
>
> One: no trusted setup. STARK is transparent. Groth16 needs a per-circuit ceremony. PLONK needs a universal SRS. Both are operational risks at scale.
>
> Two: post-quantum sound. STARK security reduces to hash collision resistance, which Grover only halves, and FRI proximity, which is information-theoretic. No elliptic curves. Shor doesn't apply.
>
> Three: faster prover for our circuit sizes. Winterfell on Goldilocks beats snarkjs Groth16 by three to five times on mobile.
>
> Four, the trade-off: proofs are larger — 145 kilobytes versus 256 bytes for Groth16. We rent a buffer account, costs about a thousandth of a SOL per subscribe. Still cheaper than Stripe's thirty-cent flat fee."

---

### Q5 — How does a merchant integrate this?

> "Three lines of TypeScript via our SDK. Import `verifySubscription`, call it with the commitment and the service ID, return 402 if it fails. That's it.
>
> Behind the scenes the SDK fetches the vault from on-chain, validates the period, returns true or false. The merchant never handles cryptography directly. No key management. No PII to store. No PCI compliance burden. No GDPR exposure.
>
> For session tokens — the NordVPN pattern — the SDK exposes `issueAccessToken`. It returns a short-lived JWT signed by the merchant's own key, scoped to the verified commitment."

---

### Q6 — What if the user loses their device?

> "Subscriptions are account-scoped, not device-scoped. The subscriber commitment derives from a spending key, stored encrypted in SecureStore with 600,000 PBKDF2 rounds.
>
> New device with the same seed phrase: same key, same commitment, subscriptions auto-recover.
>
> Lost the seed entirely: cross-device recovery flow. The user scans on-chain vault PDAs, proves ownership with a fresh STARK proof bound to the new seed, and the refund routes to a new commitment.
>
> Same UX as recovering a Solana wallet today. The seed is the source of truth."

---

### Q7 — What about KYC, compliance, sanctions screening?

> "Privacy is not the same as untraceability. Our architecture supports optional zk-attestation layers.
>
> A merchant can require: prove you're not on OFAC. Via zk-attestation from a regulated provider — zkPass, Reclaim. Or: prove you're over eighteen in a permitted jurisdiction. Same pattern.
>
> These attach as extra public inputs in the STARK proof. The merchant verifies them alongside ownership. The user proves the attestation without revealing identity or document.
>
> We don't replace KYC providers — we let merchants accept their proofs privately. Today's demo doesn't ship this. It's optional SDK integration."

---

### Q8 — How much does each subscription cost in SOL?

> "About 0.0015 SOL per lifecycle operation. Subscribe, pause, resume, cancel — each is roughly one and a half milliSOL.
>
> At today's SOL price, that's sixteen to thirty-two cents total per subscription lifetime. Stripe charges thirty cents per transaction. We're cheaper from the second period onward.
>
> And the buffer rent is recoverable when the subscription ends. The user gets it back."

---

### Q9 — If the relayer goes down, does the system break?

> "No. Two layers of redundancy.
>
> One: direct on-chain fallback. If the relayer worker errors, the mobile client submits the transaction directly. The user pays gas, the privacy degrades by one fact — the tx fee payer is visible — but the subscription itself still works.
>
> Two: multi-relayer rotation, shipped May 7. The client picks from an on-chain registry, filters by `last_active_slot`, auto-rotates on failure. There is no central worker.
>
> The relayer is a privacy enhancement, not a critical path. The core STARK auth runs entirely on Solana validators."

---

### Q10 — How do you monetize this?

> "Three revenue lines, B2B-first.
>
> One: SDK licensing to merchants who want PQ-safe subscriptions before regulators force the migration. Tiered by monthly active users.
>
> Two: Service Registry attestation fees. Merchants pay to be listed, gain a trust signal and discovery.
>
> Three: optional managed relayer infrastructure for merchants who want zero-ops privacy.
>
> NIST is moving governments to PQ crypto by 2030 to 2035. Every subscription platform will need this. We want to be the default privacy and PQ layer on Solana — the way Stripe became the default for payments."

---

## Emergency phrases

If you blank, use one of these to buy 5 seconds:

- *"Let me put this concretely..."*
- *"The key insight here is..."*
- *"Three things matter here..."*
- *"Honest answer — I'd need to check that. The principle, though..."*

If a judge gets technical beyond your prep, redirect:

- *"That's exactly the question. Let me give you the operational answer, then the cryptographic one if you want to go deeper."*

## After the pitch

- Smile. Thank the judges by name if you caught them.
- Hand a business card or QR to anyone who lingers.
- Note one question that surprised you — add to this bank tonight.
