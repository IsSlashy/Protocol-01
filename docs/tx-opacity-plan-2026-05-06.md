# Tx-Opacity Master Plan — End-to-End Anonymization on Protocol-01

**Drafté** : 2026-05-06
**Auteur** : Slashy (avec Claude Opus 4.7)
**Scope** : fermer chaque leak public observable on-chain dans les flows V3 (shield, unshield, transfer) en composant les primitives déjà déployées. Sortir du périmètre : redesign du système ZK (pool universel, denomination cachée).

---

## 1. Threat model

Quatre tiers d'adversaire considérés :

| Tier | Capacités | Scope d'attaque |
|------|-----------|-----------------|
| T1 — Passive Chainalysis | Lit la chaîne publique, indexe events, build graph de comptes | Linker payer ↔ recipient via lamports, denominations, timings |
| T2 — Active RPC node | Voit les ip+endpoint des submitters, peut subpoena les logs | Linker IP ↔ pubkey, timing fingerprint |
| T3 — Relayer/MPC node compromis | Si on délègue au relayer, voit tout sauf ce qui est ML-KEM-thresh-encrypted | Voir contenu de la tx en plaintext si pas threshold MPC |
| T4 — Quantum (≥ 2030) | Casse Ed25519, déchiffre TLS historique | Régresse stealth ECDH si pas hybride PQ |

Ce plan vise T1 + T2 + T3 (avec MPC threshold). T4 est partiellement couvert par la migration STARK + ML-KEM-768 hybride, finalisé dans `plan-full-pq-end-to-end-2026-05-03.md`.

---

## 2. Inventory complet des leaks (V3 actuel)

Catégorisé par couche.

### 2.1 Couche identité / payer

| # | Leak | Localisation | Severity |
|---|------|--------------|----------|
| L1 | Main wallet = `feePayer` sur shield | `apps/mobile/services/denominatedPool/index.ts` (shield V3 builder) | Critique |
| L2 | Ephemeral signer pré-financé depuis main wallet | mobile builders (unshield, transfer) | Critique |
| L3 | Buffer PDA seed = `[b"stark_proof", authority, circuit_id]` lie l'authority au circuit | `programs/p01_stark_verifier/src/lib.rs:328-342` | Élevé |
| L4 | `prefund_record` PDA lie ephemeral ↔ nullifier ↔ denomination | `programs/p01_liquidity` + `unshield_denominated_stark.rs:241-287` | Élevé |

### 2.2 Couche events on-chain

| # | Leak | Event / fichier | Severity |
|---|------|-----------------|----------|
| L5 | `recipient: Pubkey` en clair | `UnshieldDenominatedStarkV3Event`, `unshield_denominated_stark_v3.rs:351-363` | Critique |
| L6 | `nullifier: [u8;32]` en clair | unshield + transfer events | Critique |
| L7 | `commitment` / `new_commitment` en clair | shield + transfer events | Élevé |
| L8 | `denomination: u64` en clair (redondant avec pool PDA mais re-publié) | tous les events V3 | Moyen |
| L9 | `protocol_fee: u64`, `mature_note_count`, `dynamic_delay`, `deposit_epoch` en clair | tous les events | Moyen |
| L10 | `msg!()` debug logs Anchor (`"V3 commitment added at index"`) | shield_denominated_v3.rs:321 | Moyen |

### 2.3 Couche structure de tx

| # | Leak | Severity |
|---|------|----------|
| L11 | Programs touchés (zk_shielded + p01_stark_verifier) révèlent "c'est P01" | Élevé (irréductible sauf wrapping relayer) |
| L12 | Pool PDA seed = (token_mint, denomination) → la denomination est dans la tx car le PDA est dans l'account list | Élevé (irréductible sauf pool universel) |
| L13 | `circuit_id: u8` (offset 40 du buffer + ix data) révèle quel circuit (= shield/unshield/transfer) | Élevé |
| L14 | `proof_size: u32` + count de chunks révèle la taille du proof → distingue circuits | Moyen |
| L15 | CU consommés = signature distinctive (~80k shield, ~100k unshield, ~120k transfer + 1.4M par verify) | Moyen |
| L16 | Lamport delta sur `protocol_fee_wallet` (BRop3akx…) en clair = (denom × fee_bps) | Moyen |
| L17 | Hardcoded `protocol_fee_wallet` apparaît systématiquement dans tous les flows | Moyen |
| L18 | Compute Unit price `i+1` non-uniforme sur les chunk-upload tx = anomaly fingerprint | Faible |

### 2.4 Couche réseau

| # | Leak | Severity |
|---|------|----------|
| L19 | RPC submitter IP visible côté Helius / validateurs | Moyen |
| L20 | Timing de submission corrélable avec autre activité du même device | Faible |

---

## 3. Primitives déjà construites mobilisables

Du sub-audit 2, déjà déployées et utilisables sans dev nouveau :

1. **`p01_relayer`** (déployé `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW`) : 10 instructions complètes, X25519 + ML-KEM-768 v2 hybride, slashing + reputation, mobile SDK `apps/mobile/services/relay/index.ts`. **Pas wiré dans V3**.
2. **`p01_arcium`** (déployé `FH1JiQRUhKP1ARqWw6P5aXsqhLt9DPfbg89gqLV2TLPT`) : `confidentialRelay`, `commitNullifier`, `privateLookup`, `scanAnnouncements`. MXE actif. SDK `packages/arcium-sdk/`. Partiellement câblé (commit nullifier + relay) mais pas utilisé dans le path V3 actuel.
3. **Stealth meta-addresses v2** (`packages/specter-sdk/`) : ECDH + ML-KEM-768 hybride, view-tag filter. `StealthIndexer` opérationnel.
4. **Encrypted memo** (`packages/p01-js/src/security/encryption.ts`) : X25519 + XSalsa20-Poly1305, prêt à attacher.
5. **`p01-fee-splitter`** : split fees configurable.

L'écart clé : ces primitives existent en silos, le path V3 ne les compose pas.

---

## 4. Leverage point (la révélation)

`p01_relayer` ferme à lui seul :
- L1 (main wallet = payer) — relayer node devient le payer apparent
- L2 (ephemeral pré-financé depuis main wallet) — relayer paye, plus besoin de pré-fund
- L3 (buffer PDA lie authority au circuit) — buffer authority devient le relayer
- L19 (RPC submitter IP) — la tx est submise par le relayer node, pas par le device user

Sans toucher au programme `zk_shielded` ni à un seul circuit. **C'est le ROI le plus élevé du plan.**

`p01_relayer` ne ferme PAS à lui seul :
- les events on-chain (L5-L10) — c'est le programme appelé, pas le relayer, qui les émet
- la structure de tx (L11-L18) — programmes appelés et account list restent visibles dans la tx finale
- le destinataire (L5) — le relayer décrypte la tx et voit le `recipient` en plaintext (single-relayer trust)

D'où la composition relayer + Arcium MPC (threshold decrypt) + event scrubbing du programme.

---

## 5. Plan phasé

### Phase A — Wire `p01_relayer` dans V3 (✅ SHIPPED 2026-05-06, ~4h)

**Goal réel** (revu après audit code) : fermer **L19** (RPC IP) + **L17 partiel** (outer relay-job tx fee_payer = ephemeral). **PAS** L1/L2/L3 (le relayer ne peut pas réécrire les signers de la tx interne).

**Travaux livrés** :
1. **Patch SDK** `apps/mobile/services/relay/index.ts` :
   - `submitRelayJob` accepte désormais `opts.ephemeralKeypair` (override) + `opts.forceV1Encryption` (skip ML-KEM-768 v2 quand on dépasse le cap `encrypted_tx`).
   - `relayTransaction` accepte `RelayTransactionOptions` (timeout + tout ce qui précède).
   - Backward-compat : `arcium/confidentialRelay.ts` migré au nouvel API objet.
2. **Wrapper** `apps/mobile/services/privacy/v3RelayerWrapper.ts` créé (`signAndSendViaRelayer`, `fitsInRelayerEnvelope`).
3. **Wiring** `apps/mobile/services/denominatedPool/index.ts` : nouveau helper local `signAndSendV3()` qui route vers le wrapper si `relayerV3Enabled`, sinon `signAndSend` legacy. Trois call-sites convertis :
   - `shieldV3` ligne 2955 ✓
   - `unshieldDenominatedStarkV3` ligne 3132 ✓
   - `transferDenominatedStarkV3` lignes 3326-3328 ✓
4. **Setting + toggle UI** :
   - `apps/mobile/stores/settingsStore.ts` : ajout `relayerV3Enabled` (default `true`), action `setRelayerV3Enabled`, persistance AsyncStorage `p01_privacy_toggles`.
   - `apps/mobile/app/(main)/(settings)/privacy.tsx` : nouvelle section "RELAY ROUTING" avec toggle.
5. **STARK upload** : reste sur l'authority ephemeral existante. Le programme `p01_stark_verifier` exige `has_one = authority` + `Signer` partout (init/chunk/verify/close) → relayer-as-buffer-authority **incompatible** sans patch on-chain (redeploy verifier). Reporté en Phase A.5.

**Choix forcés** :
- `forceV1Encryption: true` côté wrapper. v2 hybride ML-KEM-768 ajoute 1161 bytes d'overhead → reste 119 bytes utilisables sous le cap on-chain `encrypted_tx` 1280 bytes → trop petit pour une tx zk_shielded V3 (~700-900 bytes signed). v1 X25519 (overhead 73 bytes) → reste ~1207 bytes utilisables ✓. Le secret protégé par v1 = la tx encryptée pendant ~30s (durée du relay-job). Pas une clé long-terme, donc l'absence de PQ est acceptable pour ce périmètre.

**Type-check** : 0 erreur app-level (`pnpm tsc --noEmit` mobile).

**Gain réel** (revu) :
- ✅ **L19 (RPC IP)** : fermé pour les 3 flows V3.
- ✅ **L17 partiel** : la tx outer (`submit_job` ix) a un fee_payer ephemeral random.
- ❌ **L1 (depositor signer sur shield)** : NON fermé. La tx interne est pré-signée par le user → le relayer la submit sans pouvoir réécrire ses signers. Pour shield, le `depositor` reste le main wallet par construction (il faut bien quelqu'un pour fournir les SOL).
- ❌ **L2 (pré-fund main → ephemeral)** : NON fermé. Le `SystemProgram.transfer` du main wallet vers l'ephemeral apparaît on-chain et est timing-correlatable avec la tx interne. Solution = feeder pool k-anonyme (Phase A.5).
- ❌ **L3 (buffer PDA seed)** : NON fermé en Phase A (incompatibilité Anchor). Buffer PDA reste `[stark_proof, ephemeral_or_user_pubkey, circuit_id]`.

**Coût** :
- Latence : +5-30s par flow (encryption + submit relay-job + poll + relayer execute + complete_job).
- Fee : `config.jobFeeLamports` côté relayer (très faible, ~quelques dixaines de milliers de lamports).
- UX : barre de progression "Sending V3 X transaction..." inchangée pour l'utilisateur.

**Risques** :
- Si aucun relayer actif on-chain : `relayTransaction` jette → l'utilisateur voit l'erreur sans fallback silencieux (volontaire — un fallback silencieux annulerait le gain L19).
- Si le relayer assigné drop : `expire_job` slash automatique côté programme. L'ephemeral récupère le pré-fund après timeout (~60s par défaut). Côté UX, la tx semble échouer à 120s-180s (timeout `monitorJob`).
- Helius rate-limit (-32429) côté relayer node : transparent pour le user (le relayer retry).

**Files modifiés** :
- `apps/mobile/services/relay/index.ts`
- `apps/mobile/services/arcium/confidentialRelay.ts`
- `apps/mobile/services/privacy/v3RelayerWrapper.ts` (créé)
- `apps/mobile/services/privacy/index.ts`
- `apps/mobile/services/denominatedPool/index.ts`
- `apps/mobile/stores/settingsStore.ts`
- `apps/mobile/app/(main)/(settings)/privacy.tsx`

**TODO Phase A.5** (nouveau, débloqué par Phase A) :
- **k-anonymous feeder pool** : programme on-chain qui accumule des contributions de plusieurs users et permet à des ephemerals de tirer des SOL sans révéler la source. Ferme L2 + partiellement L1 si on l'utilise pour shield aussi.
- **STARK buffer authority via relayer** : patch `p01_stark_verifier` pour autoriser un co-signer (relayer + user) ou bien retirer `Signer` de write/verify et n'exiger `Signer` qu'à init/close. Redeploy verifier ~0.5 SOL.

---

### Phase B — Event scrubbing on-chain (5-7 jours)

**Goal** : fermer L5, L6, L7, L8, L9, L10. Touche les programmes Anchor.

**Travaux dans `programs/zk_shielded/src/instructions/`** :

1. **shield_denominated_v3.rs**
   - Garder `pool` et `leaf_index` (nécessaires à l'indexer pour reconstruire le merkle).
   - Drop `depositor` (jamais utile à l'indexer).
   - Remplacer `commitment` par un commitment hashé : `keccak256(commitment || epoch_salt)`. Le secret reste vérifiable côté client via la même hash.
   - Remplacer `denomination` + `protocol_fee` + `mature_note_count` + `dynamic_delay` + `timestamp` par un seul champ `metadata_hash: [u8;32]` = hash de tout. Si l'indexer a besoin du `mature_note_count`, il le recalcule depuis le pool state.
   - Drop tous les `msg!()` debug.

2. **unshield_denominated_stark_v3.rs / transfer_denominated_stark_v3.rs** — pareil :
   - Drop `recipient`, `denomination`, `protocol_fee`, `min_epoch`, `current_epoch`, `dynamic_delay`, `mature_note_count`, `timestamp` des events.
   - Garder `pool` (déjà inferable depuis `denominated_pool` account)
   - Garder `nullifier` ? Non — replacer par `nullifier_hash = keccak256(nullifier || epoch_salt)` côté event. Le `NullifierRecord` PDA garde le nullifier en clair (nécessaire à la verif on-chain) mais l'event ne l'expose plus.

3. Un nouvel event canonical `LeafInserted(pool, leaf_index, leaf_hash)` qui remplace les 3 events spécifiques. L'indexer mobile (`fetchPoolCommitments`) ne distingue plus shield vs transfer vs unshield au niveau event.

**Gain** : T1 voit un event `LeafInserted` pour shield + transfer, et un event `NoteSpent` (juste `nullifier_hash`) pour unshield/transfer. Plus aucun lien entre nullifier et recipient/denomination.

**Coût** :
- Réindexation mobile à refaire (cf mémoire `bug-merkle-rebuild-event-decoding`). Le canonical `LeafInserted` était déjà sur la todo list.
- Recovery flow doit lire les bons fields. Pas de breaking change si on garde la rétrocompat de l'indexer pour les events legacy.
- Build + redeploy `zk_shielded` + bump program seed.

**Files** :
- `programs/zk_shielded/src/instructions/{shield,unshield,transfer}_*_v3.rs`
- `apps/mobile/services/denominatedPool/parsePool.ts`
- `apps/mobile/services/zk/index.ts` (event registry)
- redeploy onchain (~0.5 SOL)

---

### Phase C — Uniformiser le STARK upload (3-5 jours)

**Goal** : fermer L13, L14, L15, L18.

**Travaux** :

1. **Padding uniforme des proofs** : tous les buffers (C1, C3, C6, futurs) initialisés à la taille max (≈4 KB après compression) ou à des paliers (4/8/16 KB). Choix d'un palier basé sur la taille réelle padded. Coût : ~0.05-0.15 SOL rent supplémentaire par tx, refundable au close.
   - Modifier `apps/mobile/services/stark/index.ts:124-204` pour calculer une taille padded.
   - Ajouter un padding random (nonce) dans le proof côté Rust avant écriture (devra être skippé par le verifier).

2. **Hide circuit_id de l'instruction publique** : actuellement `init_proof_buffer(proof_size, circuit_id)`. Remplacer par `init_proof_buffer(proof_size, encrypted_circuit_id_for_relayer_mpc)`. Le verifier dérive le circuit_id depuis un MAC du buffer authority + epoch.
   - Touche `programs/p01_stark_verifier/src/lib.rs` + `apps/mobile/services/stark/index.ts:124-204`.
   - Coût modéré : redeploy verifier.

3. **CU price uniform** : retirer le `i+1` non-uniforme de `apps/mobile/services/stark/index.ts:461`. Choisir un prix fixe basé sur le median network.

**Gain** : T1 ne peut plus distinguer shield vs unshield vs transfer depuis la taille / le circuit_id / le pattern de chunks. Toutes les tx P01 ont la même signature observable.

**Coût** :
- ~0.1-0.2 SOL de rent supplémentaire par flow (récupéré au close).
- Verifier redeploy.

**Files** :
- `apps/mobile/services/stark/index.ts`
- `programs/p01_stark_verifier/src/lib.rs`

---

### Phase D — Cacher le `recipient` du relayer (7-10 jours)

**Goal** : fermer L5 même contre relayer compromis (T3).

**Travaux** :

1. **Stealth recipient on unshield/transfer** : forcer le `recipient` à toujours être un stealth address dérivé du recipient meta-address via le specter-sdk. L'unshield-tx side : `recipient = stealthDerive(meta, ephemeral, viewing_tag)`. Le recipient main wallet jamais on-chain.
   - UI : retirer toute possibilité de unshield "to a regular wallet". Forcer la dérivation stealth.
   - Si user veut unshield "vers son main wallet" : passer par 2 hops (stealth → main wallet via tx publique séparée). Le linkage est alors hors-P01 et acceptable.
   - Touche `apps/mobile/app/(main)/(privacy)/denominated-unshield.tsx` + `apps/mobile/services/denominatedPool/index.ts:3070-3250`.

2. **Hide recipient FROM the relayer** : utiliser `confidentialRelay` Arcium au lieu de `p01_relayer` directement. Le payload tx est threshold-encrypted (1 honest node sur N suffit). L'Arcium MXE décrypte sous MPC, sign threshold, submit → aucun node Arcium ne voit le `recipient` seul.
   - Compose : `apps/mobile/services/arcium/confidentialRelay.ts` (déjà partiellement câblé) + `apps/mobile/services/relay/index.ts` (fallback).
   - Le relayer reste pour le fee-payer fallback en path "non-MPC".
   - Coût Arcium : ~466M ACU par threshold_decrypt (ACU ≠ Solana CU, c'est du compute MPC).

3. **Bump le `prefund_record`** (L4) : si on garde le instant unshield, le prefund_record PDA seed ne peut plus inclure le `nullifier` direct. Replacer par `keccak(nullifier || settler_secret)` ou retirer le PDA entièrement et utiliser un escrow sans seed nullifier (lookup par signature MAC).
   - Touche `programs/p01_liquidity/`.

**Gain** : T3 (relayer compromis) ne voit plus le recipient. T1 ne lie plus le nullifier à un wallet de réception.

**Coût** :
- Arcium MPC = latence supplémentaire (3-10s par décryption threshold).
- Fees ACU Arcium (à chiffrer).
- Refonte UI unshield.

**Files** :
- `apps/mobile/app/(main)/(privacy)/denominated-unshield.tsx`
- `apps/mobile/services/denominatedPool/index.ts`
- `apps/mobile/services/arcium/confidentialRelay.ts`
- `programs/p01_liquidity/`

---

### Phase E — Confidential fees + uniform protocol_fee_wallet (3-5 jours)

**Goal** : fermer L16, L17.

**Travaux** :

1. **Batched fee-splitter** : router toutes les fees (shield 0.3%, unshield 0.5%) via une PDA tampon `protocol_fee_buffer`. Le buffer accumule les fees, et est balayé périodiquement (1×/h ou par seuil). Le delta lamport sur le `protocol_fee_wallet` ne révèle plus la denomination de chaque tx individuelle.
   - Touche `programs/p01-fee-splitter/` + tous les flows V3.

2. **Optionnel** : hardcoder le wallet `BRop3akx…` derrière une rotation périodique : N wallets, sélection par `slot % N`. Aplatit l'observabilité du destinataire.

**Gain** : T1 ne peut plus déduire la denomination d'une tx unique depuis le delta lamports.

**Coût** : Petit refacto. Pas de redeploy majeur.

**Files** :
- `programs/p01-fee-splitter/src/lib.rs`
- `programs/zk_shielded/src/constants.rs` (PROTOCOL_FEE_WALLET)
- mobile builders V3

---

### Phase F — Pool universel (HORS SCOPE court terme)

**Goal** : fermer L8, L11, L12 totalement (denomination cachée par construction ZK).

**Travaux** : redesign deep — un unique pool, denomination committée dans la circuit input via Poseidon(secret, amount, salt), preuve que `amount ∈ allowed_set` (set membership circuit). Effort estimé 2-3 mois solo. À envisager après Phases A-E + audit externe.

---

## 6. Ce qui reste irréductible sur Solana L1

Même avec Phases A-F, ces leaks restent :

- **Programs touchés visibles dans la tx** (L11) — chaque tx Solana liste les program IDs invoqués. Mitigation : Mugen Privacy Stack v2 Layer 0 (Nym mixnet) + Layer 4 (MagicBlock TDX rollup) pour cacher la tx du L1 entièrement, finalité L1 ultérieure et batchée.
- **Account access list visible** — Solana exige le déclaratif `accounts: [...]` dans la tx. Mitigation : LUT (Address Lookup Tables) qui cachent les comptes derrière un index, mais le LUT lui-même est public.
- **Block-level metadata** — slot, blockhash, fee_payer obligatoire (≠ null possible). Solana ≠ Zcash sur ce point.
- **Quantum** — Ed25519 du fee_payer reste vulnérable Shor. Mitigation : `plan-full-pq-end-to-end-2026-05-03.md` (`p01_quantum_wallet`).

---

## 7. Recommandation

**Sequence proposée pour les 4 prochaines semaines (solo full-time)** :

1. **Semaine 1** : Phase A (wire p01_relayer dans V3). Tests devnet. Ship.
2. **Semaine 2** : Phase B (event scrubbing). Redeploy zk_shielded. Tests recovery flow. Ship.
3. **Semaine 3** : Phase C (uniform STARK upload) + Phase E (batched fees). Ship combiné.
4. **Semaine 4** : Phase D (Arcium confidentialRelay + stealth recipient enforced). Plus risqué — prévoir 1 sem buffer.

**Phase F** queued post-audit externe.

À la fin de Phase A : T1 ne lie plus main wallet ↔ activity. C'est le 80/20 en termes d'impact privacy.
À la fin de Phase B + C + E : T1 ne distingue plus shield/unshield/transfer, et ne lit plus rien d'utile dans les events.
À la fin de Phase D : T3 (relayer compromis) ne voit plus recipient. C'est le grand pas vers "trustless privacy".

**Total estimate solo** : ~4 semaines de dev pour Phases A-E. Toutes mobilisables sans nouveau circuit ZK.

---

## 8. Open questions

1. Le `prefund_record` PDA actuel lie ephemeral ↔ nullifier. Si on bump pour un `keccak(nullifier || settler_secret)`, est-ce que l'instant-unshield settler peut toujours réclamer son reward ? À vérifier dans `programs/p01_liquidity/`.
2. La rotation du `protocol_fee_wallet` (Phase E option 2) doit s'aligner avec le claim flow côté finance/treasury (mémoire `business-strategy-sdk`). À discuter.
3. Phase B casse les events legacy → recovery flow doit gérer les notes V3-pre-scrub et V3-post-scrub. Bump program seed (comme on a fait `denominated_pool_v2` → seed-v3 prévu par mémoire `v3-stark-migration-plan-2026-05-02`).

---

**Statut** : plan, pas encore approuvé / commencé.
**Prochaine action** : valider la séquence A→B→C→E→D avec Slashy, puis attaquer Phase A.
