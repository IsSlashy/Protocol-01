# Protocol 01

The privacy layer Solana doesn't have yet.

## What it is

Protocol 01 lets you send, receive, and spend money on Solana without leaking your identity, your balance, or your transaction graph. It works like a normal wallet, but the privacy is built in by default.

You shield a note (deposit), then you can:

- Send it privately to anyone, peer to peer.
- Use it to pay a merchant (one-tap subscriptions, checkout, recurring billing).
- Convert it back to public SOL whenever you want.

The privacy comes from zero-knowledge proofs (specifically ZK-STARKs) generated on your device. Nothing personal leaves your phone. The blockchain only sees a proof that says "this transaction is valid", with no link to who you are or how much you have.

## What's live today

Live on Solana devnet. Pre-mainnet by design, third-party security audit pending.

- Android app, release-signed, downloadable from protocol-01.dev
- Chrome MV3 extension
- Next.js web app
- 15 Anchor programs deployed on devnet
- 13 TypeScript SDKs for developers who want private payments in their own product
- 4 demo merchants attested on-chain (Netflix, Spotify, YouTube, Disney+) for the subscription flow
- A no-KYC fiat-to-crypto P2P exchange (Mugen Exchange) built on top of the stack
- Weekly 4K build-in-public videos

## What makes it different

Post-quantum from day one. The proofs use hash-based STARKs instead of elliptic-curve SNARKs, so quantum computers (when they arrive) won't break old transactions retroactively. Most ZK projects on Solana still rely on Groth16, which is not quantum-safe.

No trusted setup. STARKs don't need a ceremony with secret coordinator material. The protocol is trustless from the cryptography up.

Mobile-first. Privacy on Solana usually means a desktop browser extension. Protocol 01 ships a real Android app with on-device proof generation, biometric unlock, and a wallet you can carry.

Solo built in around 4 months. Currently ranked #2 worldwide on the Solana track of the Dev3pack Global Hackathon, and submitted to Colosseum Frontier 2026.

## How a user actually flows through it

1. Install the Android app, sign in with Google (Privy) or a classic local wallet.
2. Receive some SOL (devnet faucet, or send from any wallet).
3. Tap Shield, pick a denomination (0.1 SOL to start). The app generates a ZK-STARK proof on the phone and submits it. The note now lives in your private vault.
4. Tap Subscribe, pick a demo merchant (Netflix, Spotify, YouTube, Disney+). The app proves you own a valid note, the subscription becomes active, the merchant sees a payment but cannot link it to your wallet.
5. Or tap Unshield to convert the note back to public SOL at any wallet address.

End-to-end, around 3 to 5 minutes on a recent phone.

## Where to try it

- App and downloads: https://protocol-01.dev
- Weekly build-in-public videos: https://protocol-01.dev/updates
- Source code: https://github.com/IsSlashy/Protocol-01
- Direct APK download: https://github.com/IsSlashy/Protocol-01-releases/releases/latest

## One-line version

Protocol 01 is a post-quantum, mobile-first privacy layer for Solana, with shielded payments, subscriptions, and a developer SDK, live on devnet today.
