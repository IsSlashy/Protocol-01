<p align="center">
  <img src="docs/assets/banner.png" alt="Styx" width="100%" />
</p>

<h1 align="center">Styx</h1>

<p align="center">
  <strong>Private payments on Solana, with hash-based STARK proofs.</strong><br/>
  <a href="https://styx.cash">Website</a> &middot;
  <a href="https://styx.cash/docs">Docs</a> &middot;
  <a href="https://x.com/Styx_PQ">X @Styx_PQ</a> &middot;
  <a href="https://discord.gg/EfqnVmb2dV">Discord</a>
</p>

> **Status: devnet only. Not externally audited. v1 has known limits (below); v2 is being built.**

## What Styx does

Styx is a shielded pool for SOL on Solana. You deposit a fixed amount (1 SOL) and get back a
*note*: a secret only your wallet can open, which says "one unit of this pool is yours".
Every deposit or spend comes with a STARK proof that your browser computes locally. The proof
is built from hashes only (no elliptic curves, no trusted setup), and a verifier program on
Solana checks it before the pool moves any money. When you deposit through the web app, your
money funds a note the deployment (the operator running styx.cash, with its till and its stock of notes) keeps, and you are handed a different, *older* note: you
contribute one and collect an older one, so the note you later spend is not the one your
deposit made. The aim is to hide which deposit a withdrawal or a subscription spends, and so
who paid, from anyone reading the chain. It does not hide that you used Styx, how much (every
note is 1 SOL), or when, and it does not hide your note from the deployment that issued it.

```
User generates a STARK proof (Rust prover compiled to WASM, Goldilocks field, Poseidon hash)
    -> the proof is uploaded in chunks and checked by the on-chain FRI verifier
        -> the pool program applies the deposit, withdrawal or subscription
            -> a withdrawal pays a fresh address, one per note, which the web app
               derives by HKDF from one Ed25519 wallet signature (no KEM involved)
```

## Try it (devnet)

The web app at **[styx.cash/app](https://styx.cash/app)** is the only client whose proofs the
deployed verifier accepts today.

1. Set your wallet (Phantom, Solflare, Coinbase Wallet, Ledger or Torus) to **devnet**.
2. Get free devnet SOL: `solana airdrop 2 <your address> --url devnet`, or
   [faucet.solana.com](https://faucet.solana.com). A deposit needs a little over 1 SOL.
3. Open [styx.cash/app](https://styx.cash/app), connect, and **shield** 1 SOL. You sign one
   public transaction to the deployment (1 SOL, a 0.3% protocol fee and a 1% operator fee);
   the deployment funds a one-time key that makes the pool deposit, and hands you an older
   note when it has one in stock. When it has none, the app says so and offers a plain
   deposit, labelled as linked to your wallet. The older note you receive was derived from the
   operator's seed, not yours: your wallet cannot rebuild it, and it lives only in this
   browser's storage. Clearing that storage loses it (the app warns about this).
4. **Withdraw** it to a payout address derived for that note alone, or **subscribe** to a demo
   service with it. A withdrawal pays 0.995 SOL (a 0.5% fee). Your wallet is on neither
   transaction when the deployment covers the fees. The payout address is public, so do not
   sweep it back to the wallet that deposited: that joins the two halves again (see the limits
   below).

How long it takes, measured on devnet on 2026-09-23 (one or two runs each, so not a benchmark):
a shield took about **37 s** end to end, of which about 13.5 s is Styx's own work and the rest
is waiting on the rate limit of the Helius Free-plan RPC; a withdrawal took about **32 s**, a
subscription about **37.5 s**. A benchmark with at least 30 runs per flow is coming; its
method is in [`docs/BENCHMARK-METHOD.md`](docs/BENCHMARK-METHOD.md).

**Mobile app and browser extension: paused.** Their released builds (the Android APK tagged
v1.0.3 and the extension ZIP) produce proofs the current verifier rejects.

## What it protects, and what it does not

**What v1 does protect**

- **The pool deposit is not signed by your wallet.** A one-time key signs it, funded by the
  deployment (except the plain deposit offered when no older note is in stock, labelled as such). A web withdrawal pays a per-note address, never your connected wallet.
- **A web withdrawal does not republish the deposit's fingerprint.** It runs on circuit 7,
  which publishes a nullifier and no note commitment, so the commitment cannot be matched to
  its deposit, assuming the proof bytes reveal nothing about the note, which is not yet established (F69, next bullet); that match is as hard as searching the note's blinding, a cost stated in
  [`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md) ("The note blinding"). The withdrawal
  still publishes other things that narrow it down (the "What a spend still shows" row below).
- **The proof bytes are masked.** Every circuit carries a blinding mask, each committed value
  of a proof is measured uniform in it, and no private input has been recovered from a masked
  proof. That is all that is claimed: the simulation argument in
  [`docs/zk-simulation-argument.md`](docs/zk-simulation-argument.md) does not hold as written,
  because every proof publishes the next-row openings it treats as hidden (audit finding F69).

**What v1 does NOT protect** (the full list, about 110 channels, is
[`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md), in French)

| Limit | In plain words | Details |
|---|---|---|
| Double-spend | **One deposit can be withdrawn twice.** Protection against it is not guaranteed in v1: an audit agent found such a pair in under half an hour on one desktop. A note's fingerprint (its commitment) is one field element, so a birthday search of about 2^32 Poseidon evaluations (generic collision bound, classical) finds two notes with the same fingerprint, and one deposit can then be withdrawn twice. Nullifier records stop one nullifier from being spent twice, not this. Fixed by design in v2. | ledger F2, audit F03 (critical); [`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md), "Hash-collision lines" |
| Forgery floor | v1 draws the verifier's random challenges from the base field (about 2^64 values), so a forger can re-roll them until one lands where it wants and have a false statement accepted. The search splits across machines, so it is within reach of an attacker who can rent enough of them. v2 is designed to draw them from a cubic extension field (nearly 2^192 values). | audit F52 (high); [`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md), per circuit and per regime |
| Proof not bound to its sender | On some paths a copied proof can be submitted by someone else: in the note-in exchange, whoever pays the fee of the withdrawal to the till gets the claim code, and the older C1 + C3 withdrawal pair binds no payee (the web app refuses that pair). | audit F70, F05 |
| The issuer | The deployment derives every note it hands out from its own seed, so it can tell which note is yours and could spend it. Against the issuer, your crowd is one. | [`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md), D5 |
| Your wallet, one hop away | You pay the deployment in public, and it funds the one-time key. The amount and the minutes between the two transfers link them. | [`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md), families B and D |
| What a spend still shows | The payout address is written into the withdrawal in the clear: whoever reads it reaches wherever you sweep the money, and sweeping it back to the wallet that deposited joins the two halves by hand. A spend also publishes its Merkle directions and siblings (which of 8 positions the note sits in) and the pool root it names, which bounds how old the note is. | [`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md), B2 (payout in the clear), B4 (open), B11 (web residual) |
| Small crowd | Devnet traffic is light, so the time between a deposit and a spend can narrow down which note is yours. | [`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md) |
| Phone withdrawals | A withdrawal from the paused mobile app, or of a note deposited before the blinding was randomised, republishes the commitment, so anyone can match it to its deposit. | [`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md), "The note blinding" |
| Accepted by design | The RPC provider (Helius for now) sees your IP and both halves of a flow. The 1 SOL denomination is public. Deposits are public. A deposit and a spend close together in time can be paired. | [`docs/LEAK-LEDGER.md`](docs/LEAK-LEDGER.md), family D |
| Quantum | The proofs are hash-based, but Solana signs with Ed25519 only, and the web app's note keys and payout addresses are derived from one Ed25519 wallet signature, so they are only as safe as that wallet secret. A quantum computer that breaks Ed25519 takes the wallet. | [`docs/HACKATHON.md`](docs/HACKATHON.md), TL;DR |

Every soundness figure, with its regime and assumptions, is generated in
[`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md). The only one this README quotes is the
v1 collision line in the Double-spend row.

## Security status

v1 has had an **internal, AI-assisted audit** run with Claude Opus 5.5: 79 confirmed findings,
1 of them critical (the double-spend above). It is **not an external human audit**; an external
review is the next step. The white paper that reports the audit, `docs/WHITEPAPER.md`, is being
finalised and will be linked here once it is committed. v1 will not go to mainnet.

**v2** is designed to fix the root cause of the two worst findings, fingerprints and
challenges packed into one small field element; it is decided and not built. Its design uses
security profile R: the Poseidon2 hash (width 12), a fingerprint of four field elements, every challenge drawn from a cubic extension field (rate
1/32, 36 queries, 16 grinding zeros), a statement bound to the key that submits it, and a new
verifier program. The Poseidon2 hash (WP2) and the extension-field transcript (WP3) are implemented and tested in a v2 workspace that is not yet published in this repository;
the v2 circuits, prover, verifier and clients come next. The design figures of profile R are in
[`docs/SECURITY-LEVELS.md`](docs/SECURITY-LEVELS.md) ("v2 candidates").

## Architecture

**Programs on devnet** (the `declare_id!` of each crate, the same in `Anchor.toml`):

| Program | Devnet id | Role |
|---|---|---|
| `p01_stark_verifier` | `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` | FRI verifier written for Solana; accepts the eight v1 circuits |
| `zk_shielded` | `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c` | the pool: shield, withdraw, subscribe, pause, resume, claim |
| `p01_registry` | `QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB` | merchant services and stealth meta-addresses |
| `p01_relayer` | `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW` | relay jobs; deployed, but no node operates it |

A subscription pays the retailer named when the vault was created.
No instruction reads the registry, so a merchant must check a vault against its registry entry
off chain (the merchant SDK does). There is no cancel and no refund: a vault's money can only
go to that retailer.

**Circuits the product uses** (the shipped prover exports exactly these five):

- **C0** subscriber ownership: proves you own a subscription vault without naming a wallet
  (pause, resume).
- **C1** pool commitment and **C3** Merkle path: the older withdrawal pair of the paused mobile
  app and extension; the web app refuses it.
- **C6** Merkle update: the deposit (shield).
- **C7** spend: the web withdrawal and subscription, with no commitment published.

C2, C4 and C5 have no caller since 2026-09-23 and stay in the verifier until the v2 redeploy.

**The shipped prover blob** is `packages/stark-prover/wasm/p01_stark_bg.wasm`, 240,172 bytes,
SHA-256 `241caaab…`. A circuit-7 proof from it was accepted on devnet (slot 502,692,190).

| Parameter | Value |
|---|---|
| Field and hash | Goldilocks (`p = 2^64 − 2^32 + 1`), Poseidon |
| Configured FRI parameters | 22 queries on C0 `subscriber_ownership`, C3 `merkle_path`, C4 `confidential_balance`, C5 `transfer`, C6 `merkle_update` and C7 `spend`; 27 on C1 `pool_commitment` and C2 `balance_proof`; blowup 16; FRI rate 1/16 enforced by the verifier on every circuit (final-polynomial degree bound over its size); grinding `GRINDING_BITS = 22`. Read from `programs/p01_stark_verifier/src/compact_proof.rs` |

```
Protocol-01/
├── apps/
│   ├── web/                Next.js app at styx.cash (the live client)
│   ├── mobile/             Expo wallet (paused)
│   └── extension/          Chrome MV3 wallet (paused)
├── packages/               TypeScript packages, published under @protocol-01
│   ├── stark-prover/       WASM prover and on-chain submitter (repo 0.2.0, npm 0.1.3)
│   ├── privacy-sdk/        identity, denominations, registry and relay helpers; no pool instruction (repo 2.0.0, npm 1.0.5)
│   ├── specter-sdk/        stealth addresses and service registry (repo 0.5.0, npm 0.4.3)
│   ├── merchant-sdk/       server side for merchants: register, payments, vaults (0.1.3)
│   ├── auth-sdk/           "Login with P-01" (0.1.1)
│   ├── p01-js/             merchant pay button and browser SDK (repo 0.4.0, npm 0.3.2)
│   ├── rpc-config/         shared RPC connection manager (0.1.2)
│   └── pay-core/           core of the /pay page (not published)
├── programs/               the four Anchor programs above
├── stark/                  Rust prover and the eight v1 AIRs, compiled to WASM
├── tools/security-levels/  generates docs/SECURITY-LEVELS.md
└── verify/                 p01-verify.mjs: chain probes and frozen replay fixtures
```

The pool instructions the web app sends are built in `apps/web/lib/privacy/pool`, not by
`privacy-sdk`. `@protocol-01/stark-prover` 0.1.3 on npm predates the current verifier, which
rejects its proofs; 0.2.0 is not published yet.

### zkSPL: removed

The confidential-SPL program `p01_zkspl` was not deployed on devnet, and it was deleted from the
repo on 2026-09-23. `@protocol-01/zkspl-sdk` 0.1.3 stays on npm and describes a design the
program never enforced: the `prove_balance` threshold was not enforced, and neither was
conservation on `withdraw`, so a holder could have withdrawn any amount the vault held (audit
F46). Do not use it.

## Developers

**Prerequisites:** Node.js 24 (`.node-version`), pnpm 9.15.9 (`packageManager`), Rust stable,
Anchor 0.32.1 and Solana CLI 3.1.9 for the programs (`Anchor.toml`). Rebuilding the prover blob
byte for byte needs the pinned toolchain in the header of `scripts/ci/wasm-repro.mjs` (rustc
1.98.1, wasm-pack 0.14.0, wasm-bindgen 0.2.114, binaryen version_117) on Windows x64.

```bash
git clone https://github.com/IsSlashy/Protocol-01.git && cd Protocol-01
pnpm install

pnpm --filter @protocol-01/web dev          # the web app on localhost
pnpm --filter @protocol-01/web test         # web unit tests (vitest)
pnpm --filter @protocol-01/web test:pool    # pool client tests
pnpm --filter @protocol-01/web build        # production build
pnpm --filter @protocol-01/stark-prover test

cargo test -p p01-stark --release                                     # prover and AIRs
cargo test --locked --manifest-path tools/security-levels/Cargo.toml  # soundness figures and prose checks
bash scripts/ci/sbf-litesvm.sh                                        # build the programs, run litesvm suites
```

**Check the prover blob and the deployed verifier yourself:**

```bash
node scripts/ci/wasm-repro.mjs                                             # rebuild the blob, compare byte for byte
node packages/stark-prover/scripts/deployed-verifier-check.mjs             # blob matches the record of the deployment
node packages/stark-prover/scripts/deployed-verifier-check.mjs --verify-onchain  # re-read the verifier from devnet
```

`verify/p01-verify.mjs` walks real devnet transactions and prints what an observer can link.
Security reports: [`SECURITY.md`](SECURITY.md). Past corrections and events:
[`docs/HISTORY.md`](docs/HISTORY.md); the old roadmap: [`docs/ROADMAP-ARCHIVE.md`](docs/ROADMAP-ARCHIVE.md).

## License

Copyright &copy; 2025-2026 Volta Team. Source-available under the
[PolyForm Strict License 1.0.0](./LICENSE). You may read, build, run and audit the code, verify
its proofs and replay the benchmark, for noncommercial purposes. Commercial use, production
deployment, changes, derivative works and redistribution need a written license from Volta
Team: [styx.cash/licenses](https://styx.cash/licenses), legal@protocol-01.com.

What was published under MIT stays MIT: every commit of this repository before the relicensing
commit, and every `@protocol-01` npm version published before 2026-09-22, are available under
the MIT License ([`LICENSE-MIT-BEFORE-POLYFORM`](./LICENSE-MIT-BEFORE-POLYFORM)). That grant is
not withdrawn.
