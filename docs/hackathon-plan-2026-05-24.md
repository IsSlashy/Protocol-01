# X Quantum Hackathon — Plan d'attaque

**Date** : 2026-05-23 → 2026-05-24 15h (submission)
**Lieu** : Dogs Patch, Dublin
**Solo** : Slashy (laptop `C:\Users\amirr\Protocol-01`)
**Cible** : Grand prix €15K

## Vision produit (scope final validé)

> Alice partage son adresse Solana "publique" comme d'habitude. C'est en réalité le PDA d'un **quantum vault** dérivé déterministement de sa seed. Bob lui envoie 1 SOL via un `system_program::transfer` natif — zéro friction côté Bob, zéro logiciel custom requis. Le SOL atterrit dans le PDA, **pas dans un wallet Ed25519**. Pour spend, Alice prouve on-device qu'elle connait la preimage du commitment quantum-safe stocké dans le vault. Si demain Shor casse Ed25519, l'attaquant peut signer des tx mais ne peut **pas** bouger le SOL — il lui faudrait la preimage Poseidon (résistante Grover, 128-bit eff).

**Contraintes dures** :
- Zéro relayer, zéro keeper externe, zéro trust tiers
- Prover 100% on-device (mobile)
- Receive = natif Solana (system transfer simple)
- Send = "spinner court + tx" — pas de cérémonie multi-step user-facing
- Vault invisible à l'œil nu pour le user mais cryptographiquement actif par défaut

## État du repo (vérifié 2026-05-22 desktop)

### Programme `p01_quantum_vault` — DÉPLOYÉ DEVNET
- Program ID : `9yVr79XkwGabckVxedz4UH78twzkgmGqXHBAX7vfJvYv`
- Upgrade authority : `7gWpzSZAL…` (wallet user)
- Slot deploy : 456011259 (~3 sem)
- 835 lignes Rust, 11 instructions
- **3 schémas implémentés mais non testés E2E** :
  - Winternitz OTS vault (init/deposit/withdraw_wots + buffer-upload pour sig)
  - Hash-vault (init/deposit/withdraw avec preimage 32 bytes)
  - Commit-reveal (create_commit / reveal_commit)

### Infrastructure réutilisable (déjà live)
- `p01_stark_verifier` déployé devnet — FRI verifier, supports CPI
- Goldilocks Poseidon TS lib (parity-locked, 3/3 tests)
- Mobile STARK prover via WebView (utilisé par V3 unshield)
- `@noble/post-quantum ^0.6.1` (ML-KEM-768 + SPHINCS+) dans deps mobile
- Buffer-upload pattern (chunks 1KB) éprouvé sur zk_shielded

### Ce qui MANQUE pour le scope vault transparent
- ❌ Mobile services `quantumVault` (dérivation PDA + flow init/withdraw)
- ❌ Screen mobile démo
- ❌ Smoke test E2E des ix existantes
- ❌ Si Voie A : nouvelle ix `withdraw_stark` + CPI vers stark_verifier
- ❌ Pitch deck angle PQ + démo vidéo 60s

## Analyse des 3 voies techniques

### Voie A — STARK proof of preimage (sexy, lourd)
| Aspect | Détail |
|--------|--------|
| Latence send | 15-25s (proof gen 8-15s + buffer upload 3-5s + verify on-chain 2-3s) |
| Effort code | 6-8h (nouveau ix `withdraw_stark` + mobile wiring + tests) |
| Risque | Moyen (réutilise circuit transfer C5 existant) |
| Pitch | "STARK-authorized fund custody on Solana" — 10/10 |
| Bloqueur | Latence 20s, framing UX critique. Démo live = stressant. |

### Voie B — Mini-circuit STARK dédié vault
| Aspect | Détail |
|--------|--------|
| Latence send | 1-3s |
| Effort code | 10-14h (nouveau circuit AIR Rust + setup + mobile) |
| Risque | ÉLEVÉ — debug AIR/FRI peut prendre 1 jour |
| Pitch | "1-second quantum-safe send on Solana" — 11/10 |
| Verdict | **Non viable 12h solo**, sauf miracle |

### Voie C — Commit-reveal hash (pragmatique)
| Aspect | Détail |
|--------|--------|
| Latence send | <100ms (juste reveal d'une preimage 32 bytes) |
| Effort code | 3-4h (ix `RevealCommit` déjà déployée, juste wire mobile) |
| Risque | Faible (pattern simple, hash on-chain) |
| Pitch | "Hash-based PQ vault, Grover-resistant 128-bit eff" — 7/10 |
| Limite UX | 1 commitment = 1 spend. Mitigation : auto-rotate (init nouveau vault au withdraw). |

### Voie D — Hybride (recommandé)
- **Démo** = Voie C (commit-reveal, instant, marche)
- **Pitch** = "Hash-based vault shipped today. STARK multi-spend variant Q3, voici le circuit qu'on a déjà commencé. Le narrative reste 'full PQ on Solana'."
- **Effort** : 4-5h démo + 2h pitch + 1h fallback prep
- **Sexy factor** : 9/10 — honnête, fonctionnel, défendable face à un cryptographe juge
- **Verdict** : **maximum probabilité de gagner** vu le budget temps

## Recommandation : Voie D

### Pourquoi pas Voie A directement
- Latence 20s perceptible en démo live = handicap majeur face à un jury qui voit 30 démos
- "STARK quantum vault" sans bench réel = on peut nous tester en live et galérer
- Le risque debug si le STARK verify CPI rejette = 6-8h cramés sans backup

### Pourquoi pas Voie B
- 10-14h sur circuit AIR seul = on a 12-15h TOTAL
- Aucune marge submission

### Pourquoi Voie D gagne
1. **Démo bullet-proof** : commit-reveal flow tient en 30 lignes mobile, hash check on-chain = pas de surprise
2. **Narrative honnête** : "shipped + roadmap" > "demo half-broken cool tech"
3. **Buffer time** : 4-5h dev libère 6-8h pour polish/pitch/démo vidéo/test sur device — c'est CA qui fait gagner
4. **Defensible mathématiquement** : preimage resistance Poseidon = sécurité hash-based, accepted PQ-safe par NIST
5. **Path d'upgrade clair** : la même infra (vault PDA + Poseidon commitment) supporte la migration vers STARK proof multi-spend sans casser l'UX user

## Breakdown horaire Voie D — 24 mai

| Heure | Tâche | Owner | Critère succès |
|-------|-------|-------|----------------|
| 09h00-09h15 | Coffee + `git pull` + extract USB secrets + `solana balance` | Slashy | Wallet OK, 3.1 SOL devnet |
| 09h15-09h30 | Lecture plan + validation voie (D ou A si revirement) | Slashy | Voie tranchée |
| 09h30-10h30 | **Bloc 1** : `apps/mobile/services/quantumVault/index.ts` — `deriveVaultPda`, `initVault`, `getBalance`, `withdrawReveal` | Slashy | Compile, types green |
| 10h30-11h00 | **Bloc 2** : `scripts/quantum-vault-smoke.ts` E2E (init → deposit → reveal-withdraw) | Slashy | Smoke green devnet |
| 11h00-12h30 | **Bloc 3** : Écran mobile `apps/mobile/app/(tabs)/quantum.tsx` — balance + Send button + spinner + success | Slashy | App build, écran navigable |
| 12h30-13h00 | **Bloc 4** : Test sur device physique (Galaxy + scrcpy) | Slashy | Send réussi sur device |
| 13h00-13h45 | **Bloc 5** : Démo vidéo 60s (scrcpy capture + voiceover) | Slashy | MP4 polished |
| 13h45-14h30 | **Bloc 6** : Pitch deck 5 slides (réutiliser Plugstart HTML) | Slashy | Deck exportable PDF |
| 14h30-15h00 | **Bloc 7** : Submission form + verif liens + buffer | Slashy | Submitted |

**Marge** : aucune dans ce plan. Chaque slip = compresse le buffer 14h30-15h00. À 13h00 si Blocs 1-4 pas finis → on cut Bloc 5 (vidéo) et on démo live.

## Squelette pitch 5 slides

1. **Le problème** — "Solana stores $80B+. Shor's algorithm + a 4000-qubit machine = empty wallets. Industry estimate: 5-10 years."
2. **Pourquoi maintenant** — "Harvest-now-decrypt-later. Tx signatures on-chain forever. Today's funds are tomorrow's loot."
3. **Notre solution** — "Quantum Vault: your Solana address IS your quantum vault. Receive natively, spend with on-device hash-based PQ proof. Zero relayer, zero trust."
4. **Démo live ou vidéo 60s** — send 0.05 SOL from vault Alice → wallet Bob, montrer balance, montrer scan devnet
5. **Stack & roadmap** — vault = nouveau layer dans Protocol-01 stack (V3 STARK + stealth + Service Registry + maintenant vault). STARK multi-spend Q3.

## Fallbacks pré-cablés

### Fallback 1 — `withdraw_reveal` rejette on-chain
- Cause probable : seed/PDA mismatch entre init et reveal
- Action : log les 2 PDAs, comparer byte-by-byte
- Backup : démo en mode "init + balance check" (montre que le vault existe et reçoit), pitch reframe sur la barrière sans démo spend

### Fallback 2 — Mobile build casse (gradle/keystore/JIT)
- Cause probable : signing.properties manquant, JDK mauvaise version
- Action : créer `signing.properties` (cf `password = Protocol01Release2026` dans memo Dublin)
- Backup : démo via APK déjà installé sur device (v0.9.11) + script CLI live qui montre le flow vault

### Fallback 3 — Smoke test E2E pète sur ix existante
- Cause probable : programme déployé buggy (jamais testé E2E)
- Action : 1h debug max, sinon pivot Bloc 1 vers Hash-vault (autre ix) au lieu de commit-reveal
- Backup ultime : démo "V3 STARK existant + Service Registry" reframe "we're already PQ-resistant in our ZK layer, vault is the next brick"

## Checklist arrivée 9h Dogs Patch

```powershell
# 1. Memory à jour
cd "$env:USERPROFILE\.claude\projects\C--Users-amirr-Protocol-01\memory"
git pull origin main

# 2. Code à jour
cd "$env:USERPROFILE\Protocol-01"
git pull origin master

# 3. Secrets extraits (si pas fait hier)
Expand-Archive -Path "F:\protocol01-secrets-2026-05-22.zip" -DestinationPath "$env:TEMP\p01-secrets" -Force
# (suivre README.md du zip)

# 4. Solana CLI OK
solana address   # → 7gWpzSZAL...
solana balance   # → ~3.1 SOL devnet

# 5. Repo build OK (sanity)
pnpm install
pnpm -F mobile typecheck   # green

# 6. Lecture plan
code docs\hackathon-plan-2026-05-24.md

# 7. GO/NO-GO sur voie (D recommandé)
```

## Notes de discipline

- **Pas de feature creep**. Une idée bonus = note dans memory pour post-hackathon.
- **Pas de refacto**. Le code peut être moche, il DOIT marcher.
- **Pas de deploy programme**. `p01_quantum_vault` est déjà live, on ne touche au Rust qu'en dernier recours.
- **Discipline du timer**. Si Bloc N déborde de 30 min → cut court, passe au suivant. Bloc 7 (submission) est intouchable.
- **Submission à 14h30, pas à 15h**. La règle d'or hackathon : ton form submission a TOUJOURS un bug imprévu.

## Sources mémoire référencées

- [[plan-full-pq-end-to-end-2026-05-03]] — plan E2E original (2-3 mois solo)
- [[trip-dublin-dogs-patch-2026-05-22]] — contexte logistique
- [[p8-1c-f-bn254-to-goldilocks-closed]] — pattern note format Goldilocks
- [[feedback_apk_signing_wipes_notes]] — release.keystore doit matcher device
- [[workflow-scrcpy-demo-day]] — capture démo vidéo
