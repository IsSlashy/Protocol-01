# Audit: Denominated Transfer Readiness — Wallet ZK P01

**Date:** 2026-02-26
**Status:** Shield + Unshield functional. Transfer blocked by missing infrastructure.

---

## 1. Circuits (`circuits/`)

| Item | Status | Details |
|------|--------|---------|
| `denominated_pool.circom` | ✅ Fonctionne | 132 lignes, 5 inputs publics: `merkle_root, nullifier, min_epoch, token_mint, enforce_maturity` |
| `denominated_pool.wasm` | ✅ Compilé | 2.3 MB dans `build/denominated_pool_js/` |
| `denominated_pool_final.zkey` | ✅ Existe | 4.2 MB, `nPublic: 5` |
| `denominated_pool_vk.json` | ✅ Existe | 3.6 KB, 6 IC points (1 constant + 5 inputs) |
| `denominated_transfer.circom` | ✅ Existe | 121 lignes, 5 inputs publics: `merkle_root, nullifier, min_epoch, token_mint, new_commitment` |
| `denominated_transfer.wasm` | ❌ Pas compilé | Aucun artifact dans `build/` |
| `denominated_transfer_final.zkey` | ❌ Pas compilé | Trusted setup jamais exécuté |
| `denominated_transfer_vk.json` | ❌ N'existe pas | Impossible de vérifier des transfer proofs on-chain |
| `merkle.circom` | ✅ Existe | Dépendance partagée (MerkleTreeChecker) |

**Commande de build prévue :** `npm run build:dtransfer` (définie dans package.json mais jamais exécutée)

---

## 2. Programme on-chain (`programs/zk_shielded/`)

| Item | Status | Details |
|------|--------|---------|
| `shield_denominated.rs` | ✅ Fonctionne | Dépôt SOL + SPL, insertion Merkle, epoch tracking |
| `unshield_denominated.rs` | ✅ Fonctionne | 5 inputs publics, `enforce_maturity=true`, dynamic delay |
| `emergency_unshield_denominated.rs` | ✅ Fonctionne | `enforce_maturity=false`, bypass maturity |
| `transfer_denominated.rs` | ⚠️ Existe mais bloqué | Utilise `pool.vk_hash` — le VK du circuit unshield, pas du circuit transfer |
| `update_denominated_vk.rs` | ✅ Fonctionne | Met à jour `pool.vk_hash` (unshield) |
| Upload/Update transfer VK | ❌ N'existe pas | Pas d'instruction pour setter un VK transfer séparé |
| `DenominatedPool.vk_hash` | ✅ | Champ unique pour le VK unshield |
| `DenominatedPool.vk_hash_transfer` | ❌ N'existe pas | Le pool n'a qu'un seul champ VK |
| `verify_denominated_transfer()` | ✅ Existe | 5 inputs: `merkle_root, nullifier, min_epoch, token_mint, new_commitment` |
| Programme déployé | ✅ Devnet | `2w4WRvujjrZYip1dUrp3X4nzoPVWeRZF9KnjtvSstGms` |

### Problème critique : VK partagé

`transfer_denominated.rs` ligne 116 :
```rust
require!(computed_vk_hash == pool.vk_hash, ZkShieldedError::InvalidVerificationKey);
```

Le circuit transfer a des inputs publics **différents** du circuit unshield :
- **Unshield** : `[merkle_root, nullifier, min_epoch, token_mint, enforce_maturity]`
- **Transfer** : `[merkle_root, nullifier, min_epoch, token_mint, new_commitment]`

Deux circuits différents = deux VK différents. Actuellement le pool n'a qu'un seul `vk_hash` → le transfer échouera toujours avec `InvalidVerificationKey`.

**Fix requis :** Ajouter `vk_hash_transfer: [u8; 32]` au `DenominatedPool` struct.

---

## 3. Service mobile (`apps/mobile/services/denominatedPool/`)

| Item | Status | Details |
|------|--------|---------|
| `shield()` | ✅ Fonctionne | Testé sur device, SOL + USDC |
| `unshield()` | ✅ Fonctionne | Avec ComputeBudget 500K CU |
| `emergencyUnshield()` | ✅ Fonctionne | Avec ComputeBudget 500K CU |
| `transferNote()` | ⚠️ Existe mais inutilisable | Fonctionne côté code, mais : pas de circuit transfer compilé, pas de VK transfer on-chain |
| `exportNote()` | ✅ Existe | Convertit ShieldReceipt → ShareableNote |
| `importNote()` | ✅ Existe | Valide le commitment, vérifie le pool |
| `encodeShareableNote()` | ✅ | Encode en Base64 |
| `decodeShareableNote()` | ✅ | Décode depuis Base64 |
| `receiptToJSON()` / `receiptFromJSON()` | ✅ | Sérialisation JSON pour persistance |
| `generateRecipientData()` | ❌ | N'existe pas (intégré dans `transferNote()`) |
| Client-side proving | ✅ Fonctionne | snarkjs dans WebView, ~1.5s proof |
| Assets circuit pool bundlés | ✅ | wasm + zkey dans APK |
| Assets circuit transfer bundlés | ❌ | Pas de transfer wasm/zkey dans l'app |

---

## 4. Store mobile (`apps/mobile/stores/denominatedPoolStore.ts`)

| Item | Status | Details |
|------|--------|---------|
| Statuts de note | ✅ | `pending`, `mature`, `spent`, `transferred`, `imported` |
| Sources de note | ✅ | `shielded`, `received`, `imported_backup` |
| `deleteNote()` | ✅ N'existe PAS | Correct — les notes ne sont jamais supprimables |
| Notes spent en historique | ✅ | Conservées, filtrées par `getActiveNotes()` |
| Persistance | ✅ | AsyncStorage (notes + selectedToken) |
| Actions disponibles | ✅ | shield, unshield, emergencyUnshield, transfer, import, export, exportAll |

---

## 5. UI mobile (`apps/mobile/app/(main)/(privacy)/`)

| Item | Status | Details |
|------|--------|---------|
| `index.tsx` (dashboard) | ✅ Complet | Hero card "Privacy Pool", actions rapides, stats, sections legacy |
| `_layout.tsx` (routes) | ✅ Complet | 9 routes dont les 5 denominated |
| `denominated-shield.tsx` | ✅ Complet | Sélection token/dénomination, indicateur anonymity set, balance check |
| `denominated-unshield.tsx` | ✅ Complet | Mode normal + urgence, sélection note, choix destinataire |
| `denominated-notes.tsx` | ✅ Complet | Liste par statut, historique pliable, backup, pas de delete |
| `denominated-transfer.tsx` | ✅ Complet | Sélection note, anonymity set, résultat + partage |
| `denominated-import.tsx` | ✅ Complet | Mode reçu/backup, preview live, validation pool |

**L'UX est déjà bien structurée** — proche de la vision "Wallet ZK" demandée. Les 5 écrans couvrent tous les flows.

---

## 6. Extension (`apps/extension/`)

| Item | Status | Details |
|------|--------|---------|
| `denominatedPool.ts` | ✅ Complet | 737 lignes, shield/unshield/transfer/import/export |
| Assets pool (wasm, zkey, vk) | ✅ Bundlés | Dans `public/circuits/` |
| Assets transfer (wasm, zkey) | ❌ Manquants | Pas de circuit transfer dans l'extension |
| ComputeBudget | ❌ Absent | Pas dans le service (seulement dans les scripts de test) |
| UI dédiée | ❌ Pas de page | Pas de page DenominatedPool dans l'extension |

---

## 7. Scripts

| Item | Status | Details |
|------|--------|---------|
| `setup-sol-denominated-pools.mjs` | ✅ | 4 pools SOL (0.1, 1, 10, 100) |
| `setup-usdc-denominated-pools.mjs` | ✅ | 4 pools USDC (1, 10, 100, 1000) + vault ATA |
| `update-denominated-vk.mjs` | ✅ | Met à jour le VK unshield sur les 8 pools |
| `test-shield-denominated.mjs` | ✅ | Test E2E du shield |
| `test-denominated-transfer.mjs` | ✅ | Test E2E du transfer (571 lignes), mais nécessite circuit compilé |
| `setup-transfer-vk.mjs` | ❌ N'existe pas | Pas de script pour uploader le VK transfer |

---

## 8. Déploiement devnet

| Item | Status | Details |
|------|--------|---------|
| Programme déployé | ✅ | Toutes les instructions (6 denominated) |
| 8 pools actifs | ✅ | 4 SOL + 4 USDC, tous initialisés |
| VK unshield uploadé | ✅ | Hash keccak256 correct sur les 8 pools |
| VK transfer uploadé | ❌ | Circuit pas compilé, pas de champ vk_hash_transfer |
| `vk_hash_transfer` dans pool | ❌ | Le champ n'existe pas dans le struct |

---

## Résumé des blocages pour le Transfer ZK→ZK

### Blocages critiques (le transfer ne peut pas fonctionner)

1. **Circuit transfer pas compilé** — pas de wasm/zkey/vk
2. **Pas de champ `vk_hash_transfer`** dans `DenominatedPool` — le programme ne peut pas stocker 2 VK différents
3. **`transfer_denominated.rs` valide contre `pool.vk_hash`** — qui est le VK unshield, pas le VK transfer
4. **Pas d'instruction `update_transfer_vk`** — impossible de setter le VK transfer même si le champ existait

### Blocages secondaires (fonctionnalité dégradée)

5. **Assets transfer pas bundlés dans mobile/extension** — le prover ne peut pas charger le circuit transfer
6. **Pas de `ComputeBudget` dans l'extension** — les tx échoueront avec 200K CU
7. **Pas de script `setup-transfer-vk.mjs`** — déploiement manuel du VK transfer

### Ce qui fonctionne déjà

- ✅ Shield (dépôt wallet → pool)
- ✅ Unshield normal (retrait avec maturity)
- ✅ Emergency unshield (retrait sans maturity)
- ✅ Import/Export de notes (format ShareableNote + Base64)
- ✅ Persistance des notes (AsyncStorage)
- ✅ UI complète pour tous les flows
- ✅ Client-side proving (snarkjs WebView, ~1.5s)

---

## Plan de correction

### Phase A — Circuit transfer (pas de changement on-chain)
1. Compiler `denominated_transfer.circom` → wasm + zkey + vk
2. Copier les assets dans mobile + extension

### Phase B — Programme on-chain
3. Ajouter `vk_hash_transfer: [u8; 32]` à `DenominatedPool`
4. Modifier `transfer_denominated.rs` → valider contre `pool.vk_hash_transfer`
5. Créer `update_transfer_vk.rs` (même pattern que `update_denominated_vk.rs`)
6. Rebuild + redéployer le programme
7. Réinitialiser les 8 pools (le struct a changé de taille)

### Phase C — VK upload
8. Uploader le VK transfer sur les pools
9. Créer script `setup-transfer-vk.mjs`

### Phase D — Client
10. Mettre à jour le prover mobile pour charger le circuit transfer
11. Ajouter `ComputeBudget` dans l'extension
12. Bundler les assets transfer dans l'APK

### Phase E — Test E2E
13. Test shield → transfer → import → unshield sur device
