# Groth16 retirement plan (scoping — no rip-out yet)

Status: SCOPING. Written 2026-05-29. Goal: remove Groth16/BN254 (snarkjs) entirely
and route every flow through the STARK (Winterfell/Goldilocks) prover.

## TL;DR

Groth16 is **still load-bearing**, so this is a *migrate-then-delete*, not a delete.
The V3/V4 denominated flows are STARK, but a few paths still call the legacy
Groth16 prover. They must move to STARK first, then the snarkjs stack + circuit
assets + packages can be removed. Unrelated to the current "deposit undefined"
crash (that's in the STARK path).

## Still-live Groth16 paths (must migrate first)

| Path | File | Note |
|---|---|---|
| Private Send (wallet → note shield) | `app/(main)/(privacy)/private-send.tsx:155` → `shieldNote(pool)` | calls the v2 Groth16 shield. Needs to route to STARK `shieldNoteV3` (mirror `denominated-shield.tsx` v3 branch). |
| Denominated deposit, v2 pools | `app/(main)/(privacy)/denominated-shield.tsx:265` (else branch) | only reached if a selected pool's `version !== 'v3'`. All current SOL/USDC pools are v3/v4, so likely already dead — confirm no v2 pool is still surfaced. |
| Subscriber ownership proof | `services/subscriptionVault/circuitLoader.ts` (`subscriber_ownership.{wasm,zkey}`) | check whether subscribe-private still uses the Groth16 ownership circuit or the STARK `starkGenerate` ownership commitment (subscribe-private.tsx already calls `starkGenerate`). If STARK-only, this loader is dead. |

## Inventory (everything Groth16/snarkjs touches)

### Mobile runtime
- `services/zkProver/index.ts` — the snarkjs WebView prover (Groth16). Parallel to `services/stark/StarkProver.tsx`.
- `services/denominatedPool/circuitLoader.ts` + `index.ts` — loads `denominated_pool` / `denominated_transfer` Groth16 circuits; `PROVING_NOTES` + WebView snarkjs notes at file bottom.
- `services/subscriptionVault/circuitLoader.ts` — `subscriber_ownership` circuit loader.
- `stores/denominatedPoolStore.ts` — v2 `shieldNote`, plus any v2 unshield/transfer actions (BN254) beside the V3 STARK actions.
- `services/zk/index.ts` — Groth16 references.
- v2 pool configs `SOL_POOLS` / `USDC_POOLS` in `services/denominatedPool/index.ts` (vs `*_V3`).

### Bundled circuit assets (APK weight — ~30 MB)
`android/app/src/main/assets/`:
- `denominated_pool_circuit.{wasm,zkey}` (~6.7 MB)
- `denominated_transfer_circuit.{wasm,zkey}` (~7 MB)
- `transfer_circuit.{wasm,zkey}` (~14 MB)
- `subscriber_ownership.{wasm,zkey}`
- (mirrored as `res/*.wasm`/`*.zkey` — verify both copies)
Removing these is the biggest single APK-size win once no loader references them.
NOTE: do NOT remove until every `circuitLoader` consumer is gone (WebView prover
depends on them — see [[apk-size-audit-2026-05-02]]).

### Packages (workspace)
- `packages/react-native-zk` — Groth16 WebView prover (`ZKProver.tsx`, `CircuitLoader.ts`, `wasmData.ts`, `scripts/inline-wasm.mjs`). Retire or strip to STARK-only.
- `packages/zk-sdk` — Groth16 circuit defs (`circuits/index.ts`, `constants.ts`, merkle).
- `packages/privacy-toolkit`, `packages/privacy-sdk`, `packages/specter-sdk`, `packages/p01-js` — Groth16 proving types / compliance / shielded-pool. Audit each export for live consumers before removing.
- `packages/stark-prover` — KEEP (this is the replacement).

### Extension
- `apps/extension`: `DenominatedShield.tsx`, `DenominatedPools.tsx`, `shared/services/zk.ts`, `shared/services/denominatedPool.ts` — the dead Groth16 path already de-linked from nav (decision C, `b6f4ad0`). Safe to delete wholesale once confirmed no route renders them.

### Prover service / circuits source
- `services/prover` (Rust ark-circom Groth16) — retire if nothing calls it.
- `circuits/` — Circom sources (`denominated_pool`, `denominated_transfer`, `transfer`, `confidential_balance`, `balance_proof`, `note_split`). Archive, don't delete history.

### Dependencies (package.json files)
- root + `apps/mobile` + `apps/extension` + `packages/*`: `snarkjs`, `circom2`/`circomlib`, `ark-circom` (Rust), `poseidon-lite` (if only used by Groth16 path — verify; STARK uses Goldilocks Poseidon).

### Docs / messaging
- `docs/pitch-*`, `docs/onboarding-cryptography.html`, `apps/web/app/docs`, `apps/web/components/Ecosystem.tsx`, `README.md`, web i18n (en/fr/ja) — update "Groth16/SNARK" claims to "STARK / post-quantum" where the app is now STARK-only.

### Programs (on-chain)
- `programs/zk_shielded` v3 (`merkle_tree_v3.rs`, `pool_v3.rs`, `init_denominated_pool_v3.rs`) reference BN254 only in comments/migration context — no Groth16 verifier on-chain for v3 (STARK verifier is separate). The legacy v2 verifier path can be deprecated once v2 pools are drained. Low priority.

## Prerequisites / risks
1. **v2 note recovery.** Any user still holding pre-V4 (v2/BN254) notes needs the Groth16 unshield to drain them. Confirm via the deprecation status ([[pool-max-historical-roots-correction]]: v3 pools deprecated, V4 safe). Provide a final drain window or one-time migration before deleting v2 unshield.
2. **Private Send migration** is the main code task — it must shield via STARK before its `shieldNote` call can be removed.
3. **Subscriber ownership** — verify subscribe-private is fully on `starkGenerate` (it appears to be) so the Groth16 ownership circuit can go.
4. Do asset removal LAST, gated on zero `circuitLoader` consumers.

## Phased plan
1. **Audit live consumers** (1 day): confirm which of the 3 still-live paths actually fire with current (V4-only) pools; mark truly-dead branches.
2. **Migrate Private Send → STARK shield** (1–2 days): reuse `denominated-shield.tsx` v3 branch logic; remove the `shieldNote` call.
3. **Delete dead v2 mobile paths** (1 day): v2 `shieldNote`/unshield/transfer in the store, v2 pool configs, `services/zkProver`, the Groth16 `circuitLoader`s.
4. **Drop circuit assets + snarkjs deps** (0.5 day): remove `*_circuit.{wasm,zkey}` + `subscriber_ownership.*` from `android/assets` (+ `res/`), drop `snarkjs`/`circom2`/`ark-circom` from package.jsons, rebuild → ~30 MB smaller APK.
5. **Retire packages** (1 day): delete/strip `react-native-zk` Groth16, prune `zk-sdk`/`privacy-toolkit`/etc. Groth16 exports (only those with no STARK consumer).
6. **Extension cleanup** (0.5 day): delete the dead `Denominated*` Groth16 pages + zk service.
7. **Prover service + circuits archive** (0.5 day): retire `services/prover`, archive `circuits/`.
8. **Docs/messaging** (0.5 day): STARK-only pitch/onboarding/web copy.

Effort: ~6–7 focused days. Do it on a **stable build** (after the pnpm-9 revert lands)
and after v2-note drain is confirmed. Sequencing: 1→2→3 unblock the user-facing win;
4 is the APK-size payoff; 5–8 are cleanup.
