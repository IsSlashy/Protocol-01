# The Protocol 01 Manifesto

Every transaction you make on a public blockchain is a confession. Who paid you, who you paid, how much you hold, what you subscribe to, when you wake up and when you sleep. Solana settles in 400 milliseconds and remembers forever.

We think that is backwards. Cash never asked for your identity. Your bank statement was never a public document. Privacy is not a feature you bolt on for criminals, it is the default state of money that every ledger before the blockchain simply had.

Protocol 01 exists to give Solana that default back.

## What we believe

1. Privacy is normal. Wanting your salary, your savings, and your spending habits off a public feed is not suspicious, it is how money has always worked.

2. Privacy must be usable. A privacy tool that requires a desktop, a command line, and a cryptography degree protects nobody. If it does not run on a phone with one tap, it does not exist.

3. Privacy must be durable. A quantum computer built in 2035 can decrypt everything recorded in 2026. Privacy that expires is not privacy, it is a time bomb. That is why we build on hash-based cryptography that quantum computers do not break.

4. Trust nothing you can verify. No trusted setup ceremonies, no coordinator secrets, no "trust our server". Proofs are generated on your device and verified on-chain by open-source programs.

5. Ship real things. Devnet programs you can call today, an APK you can install today, SDKs you can npm install today. A manifesto without running code is a poem.

## What Protocol 01 is

Protocol 01 is a privacy layer for Solana. It lets you hold, send, and spend money without publishing your identity, your balance, or your transaction graph, while keeping the speed and cost of Solana underneath.

It is one stack with several faces:

The mobile app. An Android wallet (Expo / React Native) with on-device proof generation, biometric unlock, shielding, private transfers, subscriptions, and unshielding. Privacy that fits in a pocket.

The Chrome extension. The same shielded engine in a browser (Manifest V3), with license-key gated tiers and pairing with the phone by QR scan.

The web app. Next.js site at protocol-01.dev: docs, downloads, demos, weekly build-in-public videos.

The SDKs. A family of TypeScript packages on npm so any developer can add private payments to their own product: zk-sdk (shielded pools), zkspl-sdk (confidential balances), specter-sdk (post-quantum stealth addresses), auth-sdk, merchant-sdk (subscriptions and license verification without PII), privacy-toolkit, p01-js, and more.

The programs. Around 15 Anchor programs on Solana devnet: the shielded pool, the zkSPL confidential-balance program, the specter stealth-address transport, subscriptions, streaming payments, the on-chain relayer, the STARK verifier, the quantum vault, the service registry, the fee splitter, liquidity.


## How it works

The core object is a note. When you shield funds, your device creates a secret note and publishes only its commitment, a Poseidon hash of the note's secrets. The commitment goes into a Merkle tree on-chain. The chain now knows a deposit happened, but not which future spend it belongs to.

When you spend, your device proves in zero knowledge three things at once: that your note is in the tree (a Merkle inclusion proof), that you know its secrets, and that you have never spent it before (a nullifier, a one-way tag derived from the note that the program records to prevent double spends). The verifier learns that some valid note was spent. It cannot tell which one. In a pool of fixed denominations, every note looks identical, so the anonymity set is the whole pool.

Transfers work note to note: spending one note privately mints a commitment for the recipient, value moves without any public link between sender and receiver. Subscriptions prove note ownership to a merchant program: the merchant sees a payment, never a wallet. Unshielding converts a note back to public SOL at any address, with a relayer submitting the transaction so your public wallet never signs it.

Receiving is private too. Specter stealth addresses combine ECDH with ML-KEM, a NIST post-quantum key encapsulation, and announce payments through chunked on-chain program accounts. A sender derives a one-time address only the recipient can detect and spend; a quantum adversary replaying the chain later still cannot link it.

The proofs themselves are moving from Groth16 SNARKs (elliptic curves, trusted setup) to STARKs: a Winterfell prover over the Goldilocks field with Poseidon AIR, verified on-chain by our own multi-circuit FRI verifier. STARKs need no ceremony and rest on hash functions, the piece of cryptography quantum computers only dent instead of shatter. The prover compiles to WASM and runs on the phone.

Around the core sit the honest necessities: an on-chain relayer program with independent relay nodes (Railway, Fly) so users do not doxx themselves paying fees, a refund keeper, event-scrubbed programs so even metadata leaks less, and a registry for services that accept shielded payments.

## What we refuse to do

We do not custody funds. We do not collect PII, not even for license keys, which are anonymous tokens verifiable without identity. We do not claim immunity: the STARK migration is still under audit and we say so. We do not sell privacy as a toy for crime; fixed denominations, maturity delays, and open verifiable code are chosen so the system defends ordinary people, not launderers. And we do not wait for permission to build what money should have had from the start.

## Where it stands

Live on Solana devnet, pre-mainnet by design, third-party audit pending. Built solo since January 2026. Ranked #2 worldwide on the Solana track of the Dev3pack Global Hackathon, submitted to Colosseum Frontier 2026, presented at The Bridge Demo Day, selected for the Starknet Privacy Buildathon in Paris.

One person, one stack, one belief: the ledger should prove your transaction is valid, and know nothing else.

That is Protocol 01.
