<p align="center">
  <img src="docs/assets/banner.png" alt="Protocol 01" width="100%" />
</p>

<h1 align="center">Protocol 01 — v0.2 Update</h1>

<p align="center">
  <strong>Privacy at the speed of thought.</strong><br/>
  The biggest update since launch. Faster ZK, smarter agent, glass UI.
</p>

<p align="center">
  <a href="https://protocol-01.vercel.app">Website</a> &middot;
  <a href="https://x.com/Protocol01_">@Protocol01_</a> &middot;
  <a href="https://discord.gg/KfmhPFAHNH">Discord</a>
</p>

---

## Instant ZK Operations

Shield and unshield in **~3 seconds**. Was 3 minutes.

- **Rust native Groth16 prover** — 10x faster proof generation using ark-circom
- **Single-pass Merkle computation** — reads on-chain subtrees, computes root + proof in one call
- **Saved proofs** — unshield reuses the proof from shield time, zero tree sync delay
- **Relayer safety net** — every proof is verified with snarkjs before submission

> You deposit. You withdraw. Nobody knows. And it takes 3 seconds.

---

## ZK Private Subscriptions

Untraceable recurring payments. A first on Solana.

- Subscribe to services without revealing your identity
- Groth16 proofs generated per payment cycle
- Works across mobile, Chrome extension, and SDK
- Merchants integrate with `@p01/sdk` — one line of code

---

## AI Agent Overhaul

On-device intelligence. No cloud dependency.

- **llama.rn** — local LLM running on your phone
- **Voice input** — talk to your wallet
- **Markdown rendering** — rich formatted responses
- **Chat history** — persistent conversations
- Context-aware: understands your balances, streams, and privacy settings

---

## Liquid Glass UI

iOS 26-inspired floating tab bar.

- **BlurView glass effect** with dark tint overlay
- **Spring-animated indicator pill** that slides between tabs
- Subtle cyan glow borders matching the P-01 design system
- Haptic feedback on every tap
- Content scrolls behind the transparent bar

---

## Jupiter Swap Integration

Swap any token directly inside Protocol 01.

- Token selector with search
- Real-time price quotes from Jupiter
- Slippage controls
- One-tap execution

---

## Infrastructure

| Component | Upgrade |
|-----------|---------|
| Anchor | 0.30.1 &rarr; 0.32.1 |
| Solana CLI | 1.18 &rarr; Agave 3.1.8 |
| Prover | snarkjs (JS) &rarr; Rust native (ark-circom) |
| Relayer | Added commitment indexer + proof verification |
| Docker | Multi-stage: Rust binary + Node.js in one container |

---

## What's Next

- Decentralized relayer network
- Cross-chain bridges
- Desktop app
- Hardware wallet support

---

<p align="center">
  <strong>Download the APK</strong> &mdash; <a href="https://expo.dev/accounts/slashy/projects/p01-mobile/builds">Protocol-01.apk</a><br/>
  <strong>Chrome Extension</strong> &mdash; Coming to Chrome Web Store<br/><br/>
  <a href="https://x.com/Protocol01_">Follow @Protocol01_ for updates</a>
</p>

<p align="center">
  <sub>&copy; 2026 Volta Team &mdash; Built on Solana</sub>
</p>
