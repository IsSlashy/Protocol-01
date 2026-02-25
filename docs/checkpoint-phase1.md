# Checkpoint Phase 1 — Status des 4 taches pre-pause

> Date: 2025-02-25
> Branche: master

---

## 1. Transfer Analysis (denominated pool)

**Status: ANALYSE FAITE, DOCUMENT NON ECRIT**

L'analyse a ete faite en conversation mais jamais ecrite dans un fichier `docs/`.

### Resultat de l'analyse

Le circuit `denominated_pool.circom` **NE supporte PAS** les transfers intra-pool.

Le circuit ne prouve qu'une chose : "je connais le secret d'une note qui est dans l'arbre Merkle et qui est suffisamment agee". C'est un circuit de retrait (withdrawal), pas de transfer.

**Inputs publics:** `merkle_root`, `nullifier`, `min_epoch`, `token_mint`
**Inputs prives:** `secret`, `nullifier_preimage`, `deposit_epoch`, `path_elements[15]`, `path_indices[15]`

Il n'y a aucun `recipient` ou `new_commitment` dans le circuit. Pour faire un "transfer" il faudrait :
- **Option A** : Unshield + re-shield (2 tx, rompt l'anonymity set si fait rapidement)
- **Option B** : Nouveau circuit avec output commitment (type Tornado Cash Nova / Railgun)
- **Option C** : Passer par le shielded pool existant (montants variables, anonymity set different)

**Action requise:** Ecrire `docs/denominated-transfer-analysis.md` formellement.

---

## 2. Recreation des pools devnet

**Status: SCRIPT PRET, NON EXECUTE**

Le script `scripts/setup-usdc-denominated-pools.mjs` existe (12KB, cree le 25 feb) mais :
- Il est **untracked** (pas commite)
- Pas de preuve d'execution reussie
- Les pools devnet n'ont pas ete recreees de zero

Le script gere :
- Derivation des PDA pour 4 denominations (1, 10, 100, 1000 USDC)
- Instruction `init_denominated_pool`
- Creation des vault ATA
- Mode `--dry-run`

Le programme on-chain est deploye : `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`

**Action requise:** Executer le script, commiter, documenter les adresses des pools.

---

## 3. Poseidon reel dans le SDK

**Status: DEJA FAIT (fausse alerte)**

La critique initiale (Agent 2: "SDK is a shell, Poseidon is SHA-256 placeholder") etait **incorrecte**. Voici la realite :

| Package | Hash | Status | Raison |
|---------|------|--------|--------|
| **zkspl-sdk** | `poseidon-lite` (poseidon1/2/4) | Production | Confidential balances (quantum-resistant) |
| **specter-sdk** | `@noble/hashes/sha256` | Correct by design | Stealth address protocol (ECDH + SHA-256) |
| **p01-js (sdk)** | Aucun | N/A | Streams only, pas de crypto |

`packages/zkspl-sdk/src/crypto.ts` utilise deja le vrai Poseidon :
```typescript
import { poseidon1, poseidon2, poseidon4 } from 'poseidon-lite';

export function createBalanceCommitment(balance, salt, ownerPubkey, tokenMint) {
  return poseidonHash([balance, salt, ownerPubkey, tokenMint]); // poseidon4
}
```

Le specter-sdk utilise SHA-256 parce que c'est un protocole different (stealth addresses via ECDH), pas un placeholder.

**Action requise:** Aucune.

---

## 4. Extension client-side proving (denominated pool)

**Status: FAIT — 11/11 tests passent**

### Fichiers crees/modifies

| Fichier | Action |
|---------|--------|
| `apps/extension/public/circuits/denominated_pool.wasm` | Bundle (2.3MB) |
| `apps/extension/public/circuits/denominated_pool_final.zkey` | Bundle (4.3MB) |
| `apps/extension/public/circuits/denominated_pool_vk.json` | Bundle (3.4KB) |
| `apps/extension/src/shared/services/zk.ts` | Multi-circuit: `CircuitName`, `loadCircuit()`, `resolveCircuit()` |
| `apps/extension/src/shared/services/denominatedPool.ts` | Service complet (~500 lignes) |
| `apps/extension/src/shared/services/denominatedPool.test.ts` | 11 tests E2E |
| `apps/extension/vitest.config.ts` | `environmentMatchGlobs` pour Node env |
| `apps/extension/src/__tests__/setup.ts` | Guard `IS_BROWSER_ENV` |

### Tests

```
11/11 passed (2.05s)

Crypto Helpers (7):
  - creates a valid commitment
  - creates a valid nullifier
  - commitment and nullifier are different
  - computes Merkle root from empty subtrees
  - computes different roots for different leaves
  - second insertion has correct path indices
  - slotToEpoch computes correctly

Receipt Serialization (1):
  - round-trips receipt through JSON

Client-Side Proof Generation (3):
  - generates and verifies a valid Groth16 proof (full E2E) [1.4s]
  - rejects proof with wrong secret
  - rejects proof when note is not mature (deposit_epoch > min_epoch)
```

### Technique notable
snarkjs/ffjavascript spawn des Worker threads via `web-worker` qui echoue dans vitest Node. Fix : pre-cache la courbe BN128 en mode single-thread (`snarkjs.curves.getCurveFromName('bn128', {singleThread: true})` → `globalThis.curve_bn128`).

**Action requise:** Aucune. Pret pour le wiring UI.

---

## Resume

| # | Tache | Status | Bloquant ? |
|---|-------|--------|------------|
| 1 | Transfer analysis | Analyse faite, doc non ecrit | Non |
| 2 | Recreation pools devnet | Script pret, non execute | **Oui** — necessaire pour E2E on-chain |
| 3 | Poseidon reel SDK | Deja fait | Non |
| 4 | Extension client-side proving | **FAIT** 11/11 | Non |

### Prochaines actions prioritaires

1. **Executer** `scripts/setup-usdc-denominated-pools.mjs` sur devnet
2. **Ecrire** `docs/denominated-transfer-analysis.md`
3. **Commiter** les scripts et fichiers non-tracked
4. **Phase 1.2** : Wiring UI extension (denomination picker → shield → unshield)
