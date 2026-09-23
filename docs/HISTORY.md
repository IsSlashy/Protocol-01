# History

Dated notes moved out of `README.md` when it was rewritten on 2026-09-23. They describe what
changed, what was measured at the time, and what the README used to say and had to correct.
None of them describes the current state; for that, read `README.md`, `docs/SECURITY-LEVELS.md`
and `docs/LEAK-LEDGER.md`. Figures below are as measured on the date given and were not
re-measured.

## Corrections to what the README said

- **Until 2026-08-17** the README called the whole stack post-quantum. Only the proof system is hash-based; Solana verifies Ed25519 only, so spend authority falls to Shor whatever the proofs do.
- **Until 2026-08-17** the README said a USDC deposit was signed by a one-time key. It was not: `useEphemeralDepositor = pool.token === 'SOL'` (`apps/mobile/stores/denominatedPoolStore.ts`), so the wallet signed a USDC shield itself; the web client refused USDC.
- **Until 2026-08-17** the README said the pool hid "who you are (your wallet), not which deposit you are". The wallet funded the one-time key in the clear one hop earlier, three RPC calls away, so at that time the pool hid neither.
- **Pool seed** the README explained that the web pool seed is `HKDF(one Ed25519 signature over a fixed message)`, so a key that recovers the wallet re-derives every note retroactively, and that a passphrase-salted derivation exists in the web client which no screen of the web app sets. Both still hold; the README's quantum row now says it in one line.
- **Earlier revision** the README advertised "124-bit" security. The figure was never implemented; it came from the naive `queries × log2(blowup)` formula, while the verifier of that time had an effective FRI rate measured at 1/2, not the nominal 1/16. Since B2 the verifier enforces rate 1/16 on all eight circuits, and `docs/SECURITY-LEVELS.md` derives the figures per circuit and regime; none is 124.
- **Audit v1, round 1** the README's FRI row said "27 on the other four circuits", which put 27 queries on C0 and C4; both run 22 since 2026-09-12.
- **Audit v1** the pool flow diagram credited an X25519 + ML-KEM-768 stealth address to the withdrawal; the web withdrawal pays an address derived by HKDF from an Ed25519 wallet signature, with no KEM.
- **Audit v1 (F47)** the README counted Winternitz one-time signatures (WOTS+) as shipped quantum protection; the vault that verified them was closed on 2026-09-13 and no program verifies WOTS+.
- **Audit v1 (F46)** the zkSPL section announced hidden balances; `prove_balance` never enforced its threshold and `withdraw` bound no conservation. The program was never deployed and was deleted on 2026-09-23.
- **Audit v1 (F60)** the README said a passphrase closes retroactive derivation; no screen of the web app sets one.
- **Audit v1 (F15, F51)** the double-spend row presented nullifier PDAs as an unconditional guarantee; a v1 commitment is one field element, so one deposit can be spent twice (F2).
- **Audit v1, round 4** the README said the claim lands on the retailer's "registered address"; the program pins it to the retailer named when the vault was created, and no instruction reads the registry.
- **Audit v1, hygiene** the README linked `LICENSE-MIT-UNTIL-beaa87ba`, a file that never existed; the MIT text is `LICENSE-MIT-BEFORE-POLYFORM`.
- **Until 2026-09-23** the hiding paragraph relied on the simulation argument of `docs/zk-simulation-argument.md`; audit finding F69 showed that it treats the next-row trace openings as unpublished while every proof publishes them, so no statistical-hiding claim is made.
- **Until 2026-09-23** the README's license banner said the MIT grant covered the repository "up to and including commit `beaa87ba`". The boundary in `LICENSE` is every commit before the relicensing commit, and every npm version published before 2026-09-22.
- **Until 2026-09-23** the README's demo path pushed the Android APK v1.0.3 and the extension, whose proofs the deployed verifier rejects, and linked protocol-01.dev; the site is styx.cash.
- **Mobile timing** the README quoted ">180 s" for on-device proving. That was the client worker timeout of the mobile prover provider (raised from 60 s), not a proving time. The only on-device proving figure ever measured is circuit 3 at 1,482 ms (2026-08-03).
- **Test table** an earlier README claimed 361 tests for rpc-config; that suite does not exist.

## 2026

- **2026-03** Groth16 retired: the pool moved to STARK proofs. The Circom circuits were deleted later; the last Groth16 artefacts the apps bundled (proving keys, circuit files no code loaded) were deleted on 2026-09-23.
- **2026-05-29** v1.0.1 hotfix: Privy embedded-wallet recovery and signing fixed; `Transaction.serialize()` restored after the `@noble/curves` v2 migration; the C3 verifier stopped counting padding rows 480-511 as Poseidon rounds and was redeployed; RPC retry and crash sweep.
- **2026-06-16** tag v1.0.3, the latest Android APK release. Its prover predates the verifier deployed since 2026-09-12, which rejects its proofs.
- **2026-07-30** DEEP binding of the out-of-domain sample landed.
- **2026-08-03** circuit 3 proved on a phone in 1,482 ms, the only on-device proving figure measured.
- **2026-08-04** coset low-degree extension deployed on devnet: honest proof accepted at 809,812 CU, and no raw trace cell is transmitted since. Permissionless `claim_period` with close-on-exhaustion proven on devnet by a third-party signer. MIT license stated everywhere. The packed npm tarballs installed and typechecked outside the workspace.
- **2026-08-04** test counts measured: specter-sdk 240, merchant-sdk 273, auth-sdk 123, p01-js 393, stark-prover 23, pay-core 3 (+4 skipped), web app 399 (+29 skipped), Rust verifier suites 128 (lib 81, CU pins 21, DEEP binding 26, on the coset branch); rpc-config had no suite; mobile and extension not re-measured; the devnet E2E was stale (its `cancel` step no longer existed).
- **2026-08-17** anonymity set measured: seven unspent notes in the 1 SOL pool out of twenty-six ever deposited, eight in the 0.1 SOL pool, none in any other denomination. At that time every spend republished its commitment, so the effective set was one.
- **2026-08-17** the subscribe epoch gate measured inert: every client pinned `min_epoch = 0`, the unshield handler discarded the field, and the gate compared against the absolute epoch counter (`1121 >= 2`).
- **2026-08-24** B2: the verifier enforces FRI rate 1/16 on every circuit.
- **2026-08-28** both hosted relayer nodes retired: 10 relay jobs in 45 days, `lastPollCount: 0` throughout, and the wallet pre-funded the relay-job key, so the fee payer moved one hop instead of disappearing.
- **2026-08-31** blinding masks on C1, C3, C6 and C7. Until then a private witness could be recovered from proof bytes by interpolation (four C1 witnesses in 5 ms, probe P3b of `verify/p01-verify.mjs`, kept as the positive control).
- **2026-09-02/03** per-phase costs on the verifier of slot 491,973,056: phase 1 878,756 CU, phase 2 193,200 CU. A forged FRI byte was rejected at 277,171 CU, a forged Merkle byte at 26,423 CU, a tampered public input at 18,110 CU (`docs/BENCHMARK-2026-09-02.md`). A simulator built from the verifier's equations passed every check at the algebraic layer (2026-09-02); F69 later showed it ignores the published next-row openings.
- **2026-09-06** verifier redeployed.
- **2026-09-11** masks on all eight circuits; the X5 uniformity test measures each committed value uniform in the mask.
- **2026-09-12** verifier redeployed with the uniform masks (slot 497,235,406, 801,457 bytes of program data). With blob `0ad6d7f1` (265,324 B) all eight circuits were proved and verified: C7 890,643 CU in one transaction, C6 901,023 CU, C3 878,411 CU; phase 2 of C2 312,010, C1 391,977, C5 438,682 CU (`docs/BENCHMARK-2026-09-13.md`). A circuit-7 acceptance of that blob is recorded at 889,570 CU (slot 497,236,376).
- **2026-09-13** four programs closed on devnet and their crates deleted: `specter`, `p01_quantum_vault` (WOTS+ vault), `p01_quantum_wallet`, `p01_fee_splitter` (`docs/HANDOFF-2026-09-13.md` §11, §12). The mobile Agent tab and its on-device model removed.
- **2026-09-14** program ids checked against devnet; npm versions read: auth-sdk 0.1.1, merchant-sdk 0.1.3, p01-js 0.3.2, privacy-sdk 1.0.5, rpc-config 0.1.2, specter-sdk 0.4.3, stark-prover 0.1.3.
- **2026-09-20** prover blob `d5583d41` (262,363 B, NTT prover) shipped; a circuit-7 proof accepted at slot 501,407,541: phase 1 889,691 + phase 2 192,317 = 1,082,158 CU.
- **2026-09-22** new work relicensed to PolyForm Strict 1.0.0; earlier commits and npm versions stay MIT. `p01_arcium` closed on devnet (slot 502,629,197). privacy-sdk counted 124 tests, including modules removed the next day.
- **2026-09-23** six crates deleted: `p01_arcium`, `p01_liquidity` (still deployed at `6PfFkvjX…`, deactivated, called by nothing), `p01_zkspl`, `stream`, `subscription`, `whitelist` (the last four never deployed). Packages deleted from the repo: arcium-sdk, zkspl-sdk, zk-sdk, privacy-toolkit, whitelist-sdk, react-native-zk, specter-js, ui; arcium-sdk 0.1.2, privacy-toolkit 1.0.4, zk-sdk 1.0.2 and zkspl-sdk 0.1.3 stay on npm as published.
- **2026-09-23** prover blob `241caaab` (240,172 B) shipped without the C2, C4 and C5 exports; a circuit-7 proof accepted at slot 502,692,190: phase 1 889,882 + phase 2 193,269 = 1,083,301 CU.
- **2026-09-23** web shield, withdrawal and subscription sped up (commit `0f3034ee`): shield 63.9 s to 36.6 s end to end over 2 runs, 13.5 s excluding a 23 s Helius Free-plan rate-limit stall; withdrawal 32.0 s and subscription 37.5 s, 1 run each.
- **2026-09-23** README rewritten; this file and `docs/ROADMAP-ARCHIVE.md` split out of it.
