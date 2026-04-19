# Help me apply for the Agentic Engineering grant by Superteam

Response generated via Claude (Opus 4.6) working on a real Solana codebase
through Claude Code CLI — the same agentic engineering pattern the grant
subsidises. This document captures what I am building, how I use Claude as
an engineering partner to ship it, and the specific scope the $200 USDG
would fund.

---

## The project — Mugen Exchange

A no-KYC, privacy-native P2P fiat-to-crypto exchange on Solana.

Existing P2P platforms (LocalBitcoins successors, Binance P2P) force KYC,
leak trade metadata, and expose the order book to MEV. Shielded-transfer
tools on Solana (Light Protocol, Elusiv) solve privacy **after** matching,
but the matching layer itself remains public.

Mugen closes that gap. Orders, amounts, and counterparties stay private end
to end, combining five on-chain + off-chain layers:

- **Arcium MPC** circuits for blind order matching — takers never see maker
  amounts before commitment.
- **FROST threshold signatures** for escrow release — no single signer can
  unilaterally move funds.
- **MagicBlock Ephemeral Rollups** for pre-settlement confidentiality.
- **wSOL token escrow** with on-chain dispute flow via `p01_mugen`.
- **Nym mixnet** integration demo for transport-layer metadata privacy.

All anchored on `p01_arcium` (9 MPC circuits, 833 KB) deployed on Solana
devnet at `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT`. Live app at
`https://mugen-exchange.vercel.app`. Repo private (Superteam reviewer
access available — see grant FAQ).

This is part of **Protocol 01**, my solo-dev Solana privacy stack: 12
Anchor programs, 6 Circom circuits (Groth16), a custom Winterfell STARK
prover with an on-chain FRI verifier (quantum-safe), three client apps
(Expo mobile, Chrome MV3 extension, Next.js web), and 8+ TypeScript SDKs.

---

## How agentic engineering is actively shipping this

Everything above is built solo. The multiplier is Claude Code. Two recent
sessions illustrate how:

**Session 1 — Vercel deploy refactor (today, 3 h).**
The Mugen Next.js app was pinned to local dev (filesystem keypairs,
`globalThis` Maps for state, `setInterval` background loops). None of that
works on Vercel Fluid Compute. I fanned out four Claude agents in parallel,
each with a disjoint ownership scope and a shared interface contract:

1. Keypair loader (`lib/keypair-loader.ts`) + refactor of
   `arcium.ts` / `mugen-escrow.ts` + a `pnpm env:export-keypairs` helper.
2. Persistent KV layer (`lib/storage.ts`) over `@upstash/redis` with an
   in-memory dev fallback, plus migration of the encrypted-order-registry
   and auth-session store.
3. Treasury-buffer + Noise-engine migration to KV-backed state and Vercel
   Cron endpoints (`/api/cron/*`).
4. Quick fixes: hardcoded RPC literals → env vars, `dynamic='force-dynamic'`
   + `maxDuration=300` on long trade routes, `FROST_HOST_{0,1,2}` env
   overrides.

The agents ran in parallel, each <5 min wall clock. I handled the ripple
(awaits on the sync→async callers the agents had flagged), ran
`pnpm --filter @protocol-01/mugen... build` locally to verify, then
`vercel deploy --prod`. Net result: ~80 files touched, build green,
deployed. Equivalent to roughly a day of sequential work.

**Session 2 — 8 h marathon (April 14).**
Six of twelve privacy-stack layers went live on devnet; full trade
lifecycle (encrypted offer → blind take → wSOL escrow lock → fiat confirm
→ release) now runs end-to-end. Claude pair-programmed the on-chain
instructions + mobile-native integration (buy-p2p screen + MoonPay fallback
on `buy`), with a single developer orchestrating, verifying, and shipping.

The pattern is consistent: I do the judgement work (architecture, security
calls, testing), Claude handles the execution surface (boilerplate,
cross-file refactors, failure-mode enumeration). The $200 grant funds the
Pro tier that keeps this pattern affordable.

---

## Scope the grant would fund (Colosseum Frontier deadline May 11)

Shippable in four weeks with the Claude Pro subscription the grant covers.

**Milestone 1 — Encrypted order book fully live.**
Finalise the remaining Arcium matching circuit (currently 6 of 12
layers are on-chain); wire blind-take + claim-match to the Mugen escrow
program. Acceptance: two browsers simultaneously post encrypted offers,
one takes, escrow locks on devnet, reviewer inspects the PDA.

**Milestone 2 — End-to-end P2P trade demo.**
Record a <2 min video of the full flow (offer → take → escrow → fiat
confirm → release) on both web and mobile. Publish at
`https://mugen-exchange.vercel.app/demo`. Acceptance: public video URL +
devnet tx signatures for each step.

**Milestone 3 — Colosseum Frontier submission.**
Submit to Colosseum before the May 11 deadline with deck, live demo, repo
access for judges. Acceptance: submission confirmed + URL provided to
Superteam for tranche 2.

---

## Why this applicant, this project

I have been shipping full-stack Solana + ZK + cryptography code solo for
six months, with devnet-verified artefacts (13 program IDs in
`MEMORY.md`), a working STARK prover, and a mobile wallet actually
installed and tested on an Android device. The Protocol 01 memory graph
and commit history are auditable. The agentic engineering pattern is not a
buzzword here; it is literally how this week's refactor shipped, and it is
how the remaining 5 privacy layers will ship before May 11.

---

## Verification artefacts

- Live demo: <https://mugen-exchange.vercel.app>
- GitHub profile: <https://github.com/IsSlashy>
- X: <https://x.com/Slashy_fx>
- Telegram: `@Slashy_Fx`
- Grant wallet (Phantom, Solana mainnet): `BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN`
- On-chain proof (Solana devnet program IDs):
  - p01_arcium (9 MPC circuits): `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT`
  - p01_stark_verifier (multi-circuit FRI): `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`
  - p01_quantum_vault (WOTS+/hash-timelock): `HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o`
  - zk_shielded: `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`
- Source access: private repo, read access will be shared with
  `abhwshek@gmail.com` per the grant FAQ.

---

*Generated with Claude (Opus 4.6) on 2026-04-15 through Claude Code,
operating on the Protocol 01 monorepo. Prompt used, verbatim: "help me
apply for the agentic engineering grant by Superteam".*
