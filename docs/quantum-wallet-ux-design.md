# Quantum Wallet UX Design — "User doesn't feel they're using a different wallet"

**Drafté** : 2026-05-09
**Auteur** : Slashy + Claude Opus 4.7
**Statut** : Design (post-judging execution)
**Scope** : transformer le wallet principal en wallet quantum-proof, transparent côté UX. C'est le cahier des charges des 2-3 mois de dev `p01_quantum_wallet`.

> Précurseur: `plan-full-pq-end-to-end-2026-05-03.md` (memory) couvre l'architecture technique brute. Ce doc adresse spécifiquement le gap UX: comment l'utilisateur peut migrer sans s'en rendre compte.

---

## 1. Goal

Aujourd'hui, le wallet mobile = paire Ed25519 dérivée de la seed. Auth = signature Ed25519. Custody = possession de la clé privée Ed25519. **Vulnérable à Shor (quantum) à horizon ≥ 2030.**

Cible: même UX, mais sous le capot:
- Custody = preuve STARK de connaissance d'un préimage Poseidon (Goldilocks)
- L'Ed25519 reste pour le `fee_payer` (gas) mais ne protège plus les fonds
- Receive = adresse Solana standard (PDA), Send = STARK proof

L'utilisateur ne doit pas:
- Voir "votre nouveau wallet est ABC, l'ancien était DEF, transferez vos fonds"
- Avoir à gérer 2 adresses
- Sentir un changement de model mental ("c'est un nouveau type de wallet")

L'utilisateur doit:
- Voir **une seule adresse** dans son écran Receive
- Voir **un seul solde** en haut de l'écran Wallet
- Faire ses send comme avant (entrer adresse + montant)
- Recevoir d'exchanges et amis sans qu'ils sachent que c'est "spécial"

---

## 2. Threat model

### Aujourd'hui

| Adversaire | Capacité | Issue |
|------------|----------|-------|
| Voleur classique | Vol device + accès seed | Vide le wallet. **Pas notre problème — toujours résolu par seed phrase + biometric** |
| Quantum (Shor, ≥ 2030) | Casse Ed25519 depuis pubkey | Dérive clé privée → vide tous les wallets dont la pubkey est on-chain |

### Cible

| Adversaire | Capacité | Issue |
|------------|----------|-------|
| Quantum (Shor, ≥ 2030) | Casse Ed25519 du `fee_payer` | Peut payer des fees aléatoires, **mais ne peut pas mover les fonds** car custody = STARK preimage knowledge |
| Quantum (Grover sur Poseidon) | Réduit security 124-bit → 62-bit | Toujours computationnellement infaisable (62-bit ≈ Bitcoin 2010-era) |
| Quantum sur ML-KEM-768 | Module-LWE attack | Pas concerné — déjà PQ |
| Vol seed | Identique à aujourd'hui | Identique — le seed dérive l'Ed25519 ET le secret Poseidon |

**Le claim honnête que ce design rend défendable:**
> "Vos fonds sont stockés dans un vault authentifié par preuve cryptographique de connaissance, pas par signature. Quand un attaquant aura un ordinateur quantique capable de casser Ed25519, il pourra usurper votre adresse de gas mais pas mover vos fonds. Seul le détenteur du préimage Poseidon (dérivé de votre seed) peut signer un withdrawal."

---

## 3. Décisions architecturales

### D1. PDA = adresse publique du wallet

L'utilisateur partage `qw_pda_address` (un PDA dérivé de [b"qw", owner_id]). C'est une adresse Solana standard sur 32 bytes. Solana System Program accepte `transfer(qw_pda)` même si le PDA est owned par un programme. Vérifié dans le repo (`SystemProgram.transfer({ toPubkey: pda })` est utilisé partout côté `denominatedPoolStore`).

**Conséquence**: tout sender externe (Phantom, exchange, ami) envoie comme d'habitude. Aucune adaptation côté sender.

**Edge case**: si le PDA n'est pas init, les lamports arrivent quand même mais sont en limbo. Mitigation: init au premier launch (1 ix, `init_quantum_wallet` payée par l'Ed25519 du user). C'est l'unique étape "wallet creation" visible.

### D2. owner_id dérivé de la seed, pas de l'Ed25519 pubkey

Si on dérivait `owner_id = ed25519_pubkey`, la seed phrase resterait l'unique source mais le PDA serait dérivable depuis la pubkey publique. Risque: corrélation Shor-cracked Ed25519 → PDA → cible identifiée.

Préférable: `owner_id = Poseidon(seed_secret, "p01_quantum_wallet_id_v1")`. Le PDA est dérivé d'une valeur que seul le user connait. Pour qu'un sender puisse envoyer, le user partage le PDA address final, pas `owner_id`.

### D3. Custody = preuve de connaissance de `commitment_to_secret`

```
commitment_to_secret = Poseidon(seed_secret, salt)  // Goldilocks field
```

Le PDA stocke `commitment_to_secret` au init. Pour withdraw, le STARK prouve "je connais `seed_secret` tel que `Poseidon(seed_secret, salt) == commitment_to_secret`". Réutilise le verifier multi-circuit existant (`p01_stark_verifier`, DGY37k…) avec un nouveau `circuit_id = 7 = CIRCUIT_WALLET_AUTH`.

### D4. fee_payer = Ed25519 dérivée de la seed (gas only)

Toutes les tx mobile coûtent du gas. Le payer est l'Ed25519 standard. Si Shor casse Ed25519, l'attaquant peut spammer des tx avec ce payer (perte: les ~5K lamports de gas par tx) mais ne peut pas faire le `withdraw` ix car il n'a pas le STARK proof.

L'utilisateur doit toujours avoir un peu de SOL Ed25519 pour gas. Solution: tampon de gas auto-réapprovisionné depuis le quantum vault au seuil critique (1 withdrawal de 0.01 SOL toutes les N tx). Caché dans le store mobile.

### D5. Reuse maximum de l'infra V3

| V3 infra | Usage quantum wallet |
|----------|----------------------|
| `p01_stark_verifier` | Add `circuit_id = 7 = CIRCUIT_WALLET_AUTH`, nouveau circuit-config (FRI params) |
| Goldilocks Poseidon TS (`packages/privacy-sdk/src/crypto/poseidonGl.ts`) | `commitment_to_secret` derivation, parity-locked |
| WebView STARK prover mobile (82KB WASM) | Génère le wallet-auth proof |
| Buffer upload pattern (`init_proof_buffer` + `write_proof_chunk`) | Upload du proof (~145KB padded uniform) |
| `p01_relayer` Phase A wired | `withdraw` tx routée via relayer (ferme L19 + lié à la privacy story existante) |
| `findSafeShieldCounter` | `findSafeWalletNonce` pour anti-replay du STARK proof |

### D6. Pas de break Ed25519 wallet pendant la transition

L'Ed25519 wallet (l'actuel) reste fonctionnel pendant la transition. Le quantum wallet est ADDITIF. La migration est explicite mais cosmétique (l'app affiche le PDA comme adresse principale après init). L'Ed25519 reste accessible via "Legacy wallet" dans Settings, vidable manuellement.

---

## 4. Les 6 touchpoints UX en détail

### T1. Onboarding (premier lancement post-update)

**Aujourd'hui**: splash → auth Privy → create wallet → seed backup → verify → PIN → dashboard.

**Cible**: même flow, +1 étape silencieuse.

```
seed généré
  ↓ derive ed25519_keypair (comme aujourd'hui)
  ↓ derive seed_secret = HKDF(seed, "p01_quantum_v1")
  ↓ commitment = Poseidon(seed_secret, salt)
  ↓ owner_id = Poseidon(seed_secret, "id_v1")
  ↓ PDA = derive([b"qw", owner_id], program_id)
  ↓ tx: init_quantum_wallet(commitment, recovery_pubkey?)
       payer = ed25519, signer = ed25519
       (la première et seule tx où l'Ed25519 sert vraiment)
  ↓ store: pda_address, secret en SecureStore
  ↓ display "Welcome" — pas mention de "quantum"
```

L'utilisateur voit un loader supplémentaire de 2-3s pendant cette étape, jamais le mot "quantum". Si tx fail (RPC, gas), retry transparent. Hard-fail seulement après 3 tries → message "Setup incomplete, retry". Jamais d'écran "Choose wallet type".

**Migration users existants**: la première fois qu'ils ouvrent la version quantum-aware, dérive `commitment` depuis leur seed existante (la seed est toujours la même, donc déterministe), init le PDA, **drain l'Ed25519 wallet vers le PDA via une seule tx**. UI: "Updating wallet..." (5-15s). Aucune mention de migration.

### T2. Receive

**Aujourd'hui**: écran Receive affiche `ed25519_pubkey` + QR. Copy-to-clipboard.

**Cible**: affiche `pda_address` + QR. Identique visuellement. **Aucun changement UX.**

Adresse PDA est 32 bytes, format Base58, indistinguable d'une Ed25519 pubkey à l'œil. Aucun wallet externe ne fait de check "est-ce que c'est on the curve?" sur les adresses receveuses (Phantom n'aplique cette validation que sur les nouveaux Token Account inits).

### T3. Send out

**Aujourd'hui**: enter recipient + amount → sign → submit → confirmation 1-2s.

**Cible**: même flow, mais derrière:

```
user enters (recipient, amount, [memo])
  ↓ STARK prover WebView génère wallet-auth proof
       inputs: seed_secret, salt, recipient, amount, nonce
       output: proof (~145KB)
       UX: "Authorizing..." spinner 8-15s (parallélisable avec tx prep)
  ↓ buffer upload (3-5 chunked tx via p01_relayer)
       UX: progress bar discrete "Securing..."
  ↓ verify_proof on-chain (1 tx, ~1.4M CU)
  ↓ withdraw ix (1 tx)
       fee_payer = ed25519
       executes: program transfers lamports from PDA to recipient
  ↓ poll confirmation
  ↓ display "Sent!"
```

**Total latence: 20-30s.** C'est le coût honnête du PQ. Mitigations possibles:
- Réutilisation du proof buffer si même session (skip re-init)
- Pré-génération du proof "next nonce" en background pendant idle (UX impression de instant)
- Batch STARK pour multi-recipients (rare en pratique)

### T4. Display balance

**Aujourd'hui**: `getBalance(pubkey)` toutes les N secondes, affiche.

**Cible**: `getAccount(pda_address)` puis lit `pda.lamports`. Identique visuellement.

L'Ed25519 a son propre solde (gas tampon, ~0.01-0.05 SOL). Caché dans la UI principale, accessible via "Advanced" / "Legacy" dans Settings.

### T5. Migration depuis Ed25519 wallet existant

**Aujourd'hui**: pas applicable (pas encore quantum).

**Cible** (au launch de la version quantum-aware):

```
app starts up post-update
  ↓ check: PDA exists?
      no → run T1 onboarding flow (silencieux pour migration)
      yes → continue normally
  ↓ check: Ed25519 has > GAS_THRESHOLD?
      yes → drain Ed25519 → PDA en background (1 tx)
      no → ne rien faire
  ↓ display dashboard
```

Le drain est UNE tx Ed25519-signed qui transfère tout sauf gas tampon vers le PDA. C'est la dernière fois que l'Ed25519 contrôle des fonds. À ce moment, **la propriété change**.

UX visible: rien, ou un toast discret "Wallet upgraded" si tu veux marketing.

**Edge case**: user a des SPL tokens. Solution: drain SPL via une série de SPL Token Account changements d'owner (`SetAuthority::AccountOwner`). Plus complexe, à phaser après le SOL.

### T6. Recovery (seed perdue, device cassé)

**Aujourd'hui**: re-install app → enter seed → wallet restore.

**Cible**: identique.

```
user enters seed
  ↓ derive ed25519_keypair (déterministe)
  ↓ derive seed_secret (déterministe)
  ↓ derive owner_id (déterministe)
  ↓ derive PDA (déterministe)
  ↓ check on-chain: PDA exists?
      yes → restore (on a déjà toutes les données dérivables)
      no → re-init (one-shot fail = first-time-on-this-seed)
  ↓ display dashboard
```

**Pas besoin de SPHINCS+ pour le recovery basique.** SPHINCS+ optionnel = recovery "even if seed lost" via une recovery key séparée stockée chez un proche / coffre. Pour le MVP: skip, juste seed phrase suffit.

---

## 5. Migration flow (le moment "transparent")

Le plus délicat: les users existants ont déjà des fonds dans un Ed25519 wallet visible on-chain. Le quantum wallet est différent. Comment cacher la transition?

### Option migration-A: Auto-drain au premier launch post-update (RECOMMANDÉE)

Pros:
- 100% transparent, l'utilisateur ne voit rien
- Une seule tx, ~3 secondes
- Aucun changement de seed

Cons:
- Si la tx fail, user reste à moitié migré (gérer retry queue)
- L'Ed25519 reste on-chain avec son historique. Un observer voit "ce wallet était actif jusqu'à 2026-XX, puis a transféré vers ce PDA". Pas privacy mais pas dramatique.

### Option migration-B: Lazy migration au premier outgoing send

Pros:
- Pas de batch coûteux à l'install
- Si le user n'envoie jamais, la migration n'arrive jamais (économise gas)

Cons:
- Latence du premier send = drain + send = 2 tx au lieu d'1
- L'utilisateur a 2 wallets actifs entre-temps (UX confus si il doit vérifier solde)

**Décision**: Option A. Plus propre.

### Option migration-C: User opt-in via toggle Settings

Pros:
- Honnête sur ce qui se passe

Cons:
- Cassé le principe "user doesn't feel another wallet". Skip.

---

## 6. Période hybride

Pendant les semaines suivant le ship, certains users seront sur l'ancienne version (pas migré). On doit supporter:
- Sender ancienne version → recipient nouvelle version: l'ancienne envoie à l'Ed25519 (publié avant la migration). **Problème**: si l'Ed25519 du recipient a été drainé puis abandonné, les fonds arrivent là et sont stuck.

Mitigation: garder l'Ed25519 wallet **monitored** côté app (ne pas le supprimer du store mobile). Auto-drain toutes les N heures vers le PDA si solde > seuil. UI affichée: rien (drain en background).

Au bout de 6-12 mois, on peut considérer l'Ed25519 obsolete et arrêter le monitoring. À ce moment-là, les users qui n'ont pas mis à jour depuis 6 mois ont un autre problème.

---

## 7. Reuse map — quoi vient d'où

| Composant | Source | Modif requise |
|-----------|--------|---------------|
| `p01_quantum_wallet` (programme Anchor) | NEW | Build from scratch ~2 sem |
| Circuit `wallet_auth` (STARK AIR) | NEW | Reuse Poseidon AIR pattern, ajouter input contraintes (recipient, amount, nonce) ~3-5j |
| `p01_stark_verifier` extension | EXISTING `DGY37k…` | Add `circuit_id = 7` config + redeploy ~0.5 SOL |
| Goldilocks Poseidon TS | EXISTING `packages/privacy-sdk/src/crypto/poseidonGl.ts` | Aucune |
| Mobile STARK prover WebView | EXISTING | Aucune (charge le nouveau circuit_id) |
| Buffer upload pattern | EXISTING | Aucune |
| `p01_relayer` integration | EXISTING (Phase A wired) | Aucune (route `withdraw` tx via relayer) |
| Mobile UI Wallet tab | EXISTING `apps/mobile/app/(main)/(wallet)/` | Refactor pour pointer sur PDA au lieu de Ed25519 ~3-5j |
| Mobile UI Receive | EXISTING | Affiche `pda_address` ~30min |
| Mobile UI Send | EXISTING | Wrap signing avec wallet-auth proof gen ~1 sem |
| Migration drain (one-shot) | NEW | Helper service ~3-5j |
| Gas tampon auto-refill | NEW | Helper service + UI ~3j |

**Total estimé sur la base du plan: ~9-11 semaines solo full-time (cohérent avec les 2-3 mois du plan de référence).**

---

## 8. Sequencing — quand attaquer chaque phase

### Préreqs avant de commencer

- [ ] V3 fully validated (mainnet, pas juste devnet)
- [ ] Subscribe_private renewal validated live (en cours 2026-05-09)
- [ ] cancel_private_stark V3 ported
- [ ] Internal audit of V3 closed
- [ ] Hackathon Colosseum judging done (~14 mai)
- [ ] Funding situation stabilisée (career-ops cash flow ou grant)

### Phasing (~9-11 semaines à partir du go)

| Phase | Durée | Livrable |
|-------|-------|----------|
| 1 — Circuit + verifier | 2 sem | `wallet_auth` AIR, redeploy stark_verifier avec circuit_id=7, devnet test |
| 2 — Programme `p01_quantum_wallet` | 2-3 sem | init/deposit/withdraw/transfer/rotate/recover ix, Anchor cargo green, deployed devnet |
| 3 — Mobile service layer | 1-2 sem | `services/quantumWallet/index.ts`, builders, prover wiring |
| 4 — UI integration + migration | 2 sem | Refactor Wallet/Receive/Send tabs, auto-migration flow, gas tampon |
| 5 — SPHINCS+ recovery (optionnel MVP) | 1 sem | UI + on-chain verify |
| 6 — Beta test + polish | 1 sem | Devnet mainnet-equiv testing, bug fixes |

### Dépendances post-MVP

- Stealth meta-addresses v2 quantum-mode (pour receive privé) — extension naturelle
- ML-KEM-768 hybride pour cross-device handoff — déjà partiellement en place via `relay/index.ts`
- Mainnet deploy

---

## 9. Risques + open questions

### R1. CU cost dépasse limite Solana
V3 unshield = 889K CU. wallet-auth circuit serait similaire (Poseidon préimage + replay nonce check, simple). Estimation: 700K-1M CU pour le verify. Plus 200-300K pour le `withdraw` ix execution = ~1-1.3M total. **Sous le 1.4M Solana limit**, mais marge ténue. Mitigation: split verify et execute en 2 tx (déjà notre pattern V3).

### R2. Storage cost du PDA
Account = 8 (discriminator) + 32 (commitment) + 8 (balance) + 8 (nonce) + 33 (recovery_pubkey option) + 8 (created_slot) + 1 (bump) = ~98 bytes. Rent ~0.0014 SOL. Trivial.

### R3. SPL tokens
Les SPL Token Accounts sont owned par TOKEN_PROGRAM, pas par notre programme. Pour faire un quantum-protected SPL balance, il faut un wrapping: notre programme owne un Token Account, l'utilisateur withdraw via STARK proof qui authorize un `Transfer` CPI vers le recipient Token Account. Plus de complexité côté circuit (encoding du Token Account address) mais doable. **Skip MVP**, ship SOL-only d'abord.

### R4. Onboarding atomicity
Si init_quantum_wallet fail (RPC down, gas insufficient), l'utilisateur a une seed valide mais pas de PDA. Au prochain launch, retry. Pas de state corrompu — juste re-derive et re-init.

### R5. Que se passe-t-il si Ed25519 est compromise (pré-quantum) avant migration?
L'attaquant draine l'Ed25519 wallet. Solution actuelle (PIN + biometric + secure store) reste la défense. Le quantum wallet n'aide pas contre un voleur de seed local. **C'est admis**, jamais marketé comme contre-mesure local-attacker.

### R6. Comment communiquer "votre wallet est quantum-proof maintenant" sans dire "ce n'est plus le même wallet"?
Ne le communique pas activement. Le claim est dans la documentation, dans le pitch hackathon, dans les marketing materials. Pour l'utilisateur final qui ouvre l'app, c'est juste son wallet. Un toast "Security upgrade" au premier launch post-update suffit.

### Q1. PDA-as-deposit-target pose-t-il problème pour les CEX?
À tester. Binance/Coinbase pourraient rejeter une withdrawal vers un PDA si ils font un check `pubkey on curve`. Probabilité faible mais à valider en pré-launch sur testnet.

### Q2. Privy auth flow: comment dériver `seed_secret` quand le user est en Privy mode (pas de seed locale)?
Utiliser le ECDSA Privy signed message comme entropy source: `seed_secret = HKDF(privy_signed_message("p01_quantum_v1"), "p01_quantum_secret_v1")`. Le signed message est déterministe sur la signature wallet de l'utilisateur (Privy returns the same signature for the same message). Cohérent avec le pattern P11.D dans la mémoire (`p11-d-spending-key-decision.md`).

### Q3. Multi-device sync de PDA?
Le PDA est déterministe depuis la seed. Donc tous les devices avec la même seed regardent le même PDA. Pas de sync nécessaire — c'est implicite.

---

## 10. Ce qu'on peut commencer pré-judging (low-risk warm-up)

Pas de programme à coder, pas de circuit à compiler. Mais 3 tâches préparatoires safe:

1. **Pré-compiler le circuit `wallet_auth`** (1-2 jours) — c'est une variation simple du Poseidon AIR. Pas besoin de redeploy quoi que ce soit. Output = AIR Rust + tests Winterfell.
2. **Bench CU on-chain** (½ jour) — submit a wallet_auth proof to existing stark_verifier sur devnet (cheating: utiliser circuit_id existant pour mesurer). Confirme CU < 1.4M.
3. **Refactor `walletStore.ts` pour découpler "address publique" de "Ed25519 keypair"** (1 jour) — préparer le terrain pour swap PDA plus tard sans refactor invasif.

Ça donne ~3 jours de prep work sans risk hackathon. **À faire seulement si subscribe_private renewal est résolu et qu'il reste du temps avant le 14 mai.**

---

## 11. "Honest claim" final post-ship

Pour le pitch / docs / marketing:

> Protocol-01 Quantum Wallet est le premier wallet Solana où la possession de fonds n'est pas sécurisée par une signature ECDSA, mais par une preuve cryptographique de connaissance d'un secret (STARK over Poseidon, Goldilocks field, post-quantum résistant). Quand l'algorithme de Shor permettra de casser Ed25519 (estimé ≥ 2030), un attaquant qui obtient votre clé Solana ne pourra que payer du gas en votre nom — il ne pourra **jamais déplacer vos fonds**, parce que le déplacement requiert la connaissance du préimage de votre commitment, dérivé de votre seed phrase. Vos fonds sont protégés par Grover (~62-bit residual security on Poseidon), pas par Shor.
>
> Et tout ça, en utilisant la même UX qu'un wallet classique. Vos amis vous envoient à votre adresse Solana habituelle. Vous envoyez en entrant un destinataire. La complexité quantique est invisible.

Verifiable. Audit-able. Defendable.

---

## Annexe — adresses programmes existants utilisés

- `p01_stark_verifier` : `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs` (devnet)
- `p01_relayer` : `2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW` (devnet)
- `p01_quantum_wallet` : **TBD** (à créer post-judging)

## Annexe — fichiers à créer / modifier

### Nouveaux
- `programs/p01_quantum_wallet/` (Cargo, lib.rs, state.rs)
- `circuits/wallet_auth.air.rs` (Winterfell AIR)
- `apps/mobile/services/quantumWallet/index.ts`
- `apps/mobile/services/quantumWallet/builders.ts`
- `apps/mobile/services/quantumWallet/migration.ts`
- `apps/mobile/services/quantumWallet/__tests__/`

### Modifiés
- `programs/p01_stark_verifier/src/lib.rs` (add CIRCUIT_WALLET_AUTH = 7 + circuit config)
- `programs/p01_stark_verifier/src/periodic_consts.rs` (add config)
- `apps/mobile/stores/walletStore.ts` (decouple address from Ed25519)
- `apps/mobile/app/(main)/(wallet)/index.tsx` (display PDA balance)
- `apps/mobile/app/(main)/(wallet)/receive.tsx` (display PDA address)
- `apps/mobile/app/(main)/(wallet)/send.tsx` (wrap signing)
- `apps/mobile/services/wallet/index.ts` (gas tampon helper)

---

**Statut**: design ready. Execution gated sur (a) judging done, (b) funding stable, (c) V3 audit closed.
**Prochaine action**: parker ce doc, reprendre quand les 3 préreqs sont satisfaits. Estimer ~9-11 semaines de dev solo.
