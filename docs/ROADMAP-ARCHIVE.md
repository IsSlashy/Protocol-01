# Roadmap archive

The roadmap as `README.md` carried it until the rewrite of 2026-09-23, kept word for word.
It is a historical record, not a plan: several "Shipped" items were later closed, deleted or
superseded (the notes inside each item say so), and the "In Progress" and "Future" lists are
not maintained here. The current state is in `README.md`; dated events are in
`docs/HISTORY.md`.

## Latest tag — v1.0.3 (2026-06-16); notes below are from v1.0.1 (hotfix · 2026-05-29)

- Privy embedded-wallet recovery & signing fixed (`PrivyElements` mounted, deterministic note-seed persisted in SecureStore for offline recovery)
- `Transaction.serialize()` restored after the `@noble/curves` v2 migration (every on-chain op had been throwing)
- C3 `merkle_path` STARK verifier fixed — padding rows (480–511) were counted as active Poseidon rounds, rejecting valid V3 unshield proofs; verifier rebuilt + redeployed on devnet
- Transient RPC retry + ephemeral crash-sweep; pnpm 10 monorepo Android autolinking
- Verified end-to-end on device (devnet): shield, emergency unshield + sweep, private merchant subscribe, classic local-keypair flow

## Shipped

- [x] Chrome extension + Android mobile wallet
- [x] ZK shielded pool (STARK, migrated from Groth16 March 2026)
- [x] Hybrid stealth addresses (X25519 + ML-KEM-768)
- [x] Denominated privacy pools (fixed-amount Tornado model)
- [x] Subscription vaults with STARK subscribe proofs (the vault is keyed by a note commitment, not the subscriber wallet; a merchant's vaults are enumerable)
- [x] STARK verifier on-chain (custom FRI, 8 circuits, Goldilocks; uniform masks on all eight since the 2026-09-12 redeploy)
- [x] ~~Quantum vault (WOTS+ 67-chain, hash-timelock, commit-reveal)~~ closed on devnet and removed 2026-09-13
- [x] On-chain stealth meta-address registry
- [x] **On-chain Service Registry** (retailers register as first-class merchants)
- [x] **Subscription vaults are one-way** — cancellation and refunds removed from the program; `claim_period` closes an exhausted vault and pays the remainder + rent to the retailer
- [x] **Boot-time auto-recovery** (blocking lazy-load rescan from seed)
- [x] ~~Instant unshield via `p01_liquidity` prefund pool~~ deactivated; crate deleted 2026-09-23
- [x] ~~Arcium MPC bridge program + SDK (9 circuits)~~ client integration removed 2026-07; program closed on devnet and crate and SDK deleted 2026-09-23
- [x] On-chain relayer program + Tor-routed RPC middleware (both hosted nodes retired 2026-08-28; the program is deployed, nobody operates it)
- [x] **Permissionless `claim_period` + close-on-exhaustion** (2026-08-04, proven on devnet by a third-party signer: the program pins where the money goes, not who sends the claim)
- [x] **MIT license everywhere** (2026-08-04 — root LICENSE, site, and docs now agree with what npm shipped)
- [x] **Relicensed new work to PolyForm Strict 1.0.0** (2026-09-22 — source-available, noncommercial; the repository up to `beaa87ba` and the npm versions already published stay MIT)
- [x] **Coset-LDE STARK verifier redeployed on devnet** (2026-08-04 — honest proof accepted at 809,812 CU, deployed-verifier gate exit 0, rejection attributed per cause)
- [x] **V3 STARK migration end-to-end** (Goldilocks parity-locked). The pool runs on the denominated v3/v4 instructions. The base-pool `shield`, `transfer` and `unshield` are unregistered (circuit 5 proves no membership of the notes it spends), and `programs/zk_shielded/src/lib.rs` records that no client could reach them anyway: every client built `_stark` names the program never had
- [x] **Tx-Opacity Phase A** — `p01_relayer` wired V3. This does **not** close RPC IP leak L19 today: no node operates the relayer (see *On-Chain Relay Program* above), so every spend is submitted by the spender
- [x] **Tx-Opacity Phase B** — on-chain event scrub (closes L5-L10)
- [x] **Tx-Opacity Phase C v1** — uniform 145 KB STARK proof padding exists in the verifier (`init_proof_buffer_v2` + `verify_uniform`) and in the paused mobile client only. The web client, the only one whose proofs the chain accepts today, does **not** pad: it sizes each proof buffer at the proof's own length and writes `proofSize` and `circuitId` in clear into `init_proof_buffer_v3` (`apps/web/lib/privacy/pool/stark.ts`), so proof length and circuit stay visible on chain (`docs/LEAK-LEDGER.md`, C1–C6)
- [x] **Tx-Opacity Phase E v1** — `fee_escrow` PDAs. They do **not** hide the denomination: `unshield_denominated_stark_v4` pays the recipient the denomination minus the 0.5% fee directly, so the payee's lamport delta shows it (a 1 SOL note paid 0.995 SOL, `docs/BENCHMARK-2026-09-13.md` §6c). The denomination is public by design
- [x] **Sprint 3 multi-relayer** — auto-rotation + liveness filter + chunked submit_job + lazy reputation decay
- [x] **V4 pool migration** — seed `denominated_pool_v4`, 13 fresh pools, escapes legacy un-decodable events
- [x] **Subscribe_private V3** — V2→V3 structs, ix builder placeholders, vault PDA création validated live

## In Progress

- [ ] **Ship the masked prover blob to every client.** The chain runs the
  uniform-mask verifier since 2026-09-12 and the web app on `master` carries
  a blob it accepts: `0ad6d7f1` from 2026-09-12 (`docs/HANDOFF-2026-09-13.md`
  §7), `d5583d41` from 2026-09-20, `241caaab` since 2026-09-23 (`apps/web/lib/privacy/pool/starkWasmData.ts`). The APK tagged
  v1.0.3 (2026-06-16) and `@protocol-01/stark-prover@0.1.3` on npm predate it
  and their proofs are **rejected by the chain** until a new APK is released and
  stark-prover 0.2.0 is published. This line exists so nobody reads the redeploy
  as "done" for mobile
- [ ] **Soundness hardening** of the FRI/DEEP construction (see the plain-language note in the STARK section)
- [ ] **Subscribe_private renewal** live validation (Pay Now flow under logcat)
- [ ] Universal `LeafInserted` canonical event

## Future

- ~~**Quantum Wallet** (`p01_quantum_wallet`)~~ — retired 2026-09-13: the program was closed on devnet and its crate removed. The 2026-05-09 design note stays in `docs/quantum-wallet-ux-design.md` for the record
- [ ] **Cover traffic self-loop** — user-side dummy round-trips for indistinguishability
- [ ] **Phase A.5 feeder pool** — close shield depositor leak (gated on TEE attestation OR N-relayer registry)
- [ ] External security audit (OtterSec / Neodyme / Trail of Bits)
- [ ] Mainnet deployment
- [ ] iOS build
- [ ] Hardware wallet support
- [ ] Cross-chain bridges
