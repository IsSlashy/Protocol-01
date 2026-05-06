# Tx-Opacity Relayer — Long-term Architecture (2026-05-06)

**Statut** : design — Phase A wiring shippé, Phase A.1 (fixes critiques) en cours, A.2-A.5 queued.

**Pourquoi ce doc** : le wiring initial Phase A a révélé des limites structurelles (cap envelope 845B, ephemeral non-recoverable, buffer cleanup foireux, pas de node software). Au lieu de patcher au coup par coup, on définit ici l'architecture cible qui couvre toutes les tailles de tx, tous les modes d'erreur, et compose avec les phases futures (B events scrubbing, D Arcium MPC threshold).

---

## 1. Threat model + invariants

### Invariants non-négociables

1. **Aucun SOL bloqué** sur erreur — chaque path de wrapping doit garantir la sweep-back possible des fonds intermédiaires (ephemeral pre-fund, buffer rent).
2. **Pas de fallback silencieux** — si le toggle `relayerV3Enabled === true` mais qu'on bypass pour une tx donnée (taille, indispo), c'est explicite dans les logs ET l'UX peut le surfacer.
3. **Pas de leak de keypair en mémoire seulement** — tout ephemeral qui touche la chaîne doit être HKDF-dérivable depuis le seed user, jamais purement aléatoire.
4. **Cleanup garanti par finally** — tout buffer/PDA créé doit être fermé dans le `finally` même si la tx finale échoue, indépendamment de drapeaux d'état métier.
5. **Versioning** — chaque format wire (encrypted_tx v1/v2, tx layout, event format) est versionné explicitement pour migration sans casser les notes legacy.

### Threat model couvert

- **T1 passive Chainalysis** — tx wrapped → main wallet ↔ activity découplé (modulo L1/L2 résiduels qui sont Phase A.5)
- **T2 active RPC node** — submission via relayer → user IP invisible
- **T3 single relayer compromis** — relayer voit plaintext (limite v1). Mitigé par v2 ML-KEM + threshold Arcium en Phase D.
- **T4 quantum** — v2 ML-KEM-768 hybride disponible mais bloqué par taille tx aujourd'hui. Phase A.3 unblocks.

---

## 2. Architecture cible — `PrivacyTxRouter` abstraction

Au lieu d'un `signAndSendV3()` mono-implementation, on expose une interface que toutes les surfaces V3 (et plus tard V4) peuvent consommer :

```ts
interface PrivacyTxRouter {
  /** Identité du router pour logs + metrics */
  readonly name: 'direct' | 'p01_relayer_v1' | 'p01_relayer_v2' | 'arcium_mpc';
  
  /** Vérification statique avant tout side-effect on-chain */
  preflight(tx: Transaction | VersionedTransaction): PreflightResult;
  
  /** Submit + wait. Lève si non-recoverable, retourne {sig, recovery?} sinon. */
  send(
    connection: Connection,
    tx: Transaction | VersionedTransaction,
    signers: { keypair?: Keypair; walletSigner?: WalletSigner },
  ): Promise<{ sig: string; recoveryHandle?: RecoveryHandle }>;
}

interface PreflightResult {
  fits: boolean;
  reason?: 'tx_size_exceeds_envelope' | 'no_active_relayer' | 'config_uninitialized';
  estimatedCostLamports: number;
  routerCanSweepOnError: boolean;
}

interface RecoveryHandle {
  /** Re-derive any ephemeral keypair the router used and sweep leftover lamports. */
  sweep(): Promise<{ sweptLamports: number; txSig?: string }>;
}
```

Implémentations :
- `DirectRouter` — `sendAndConfirmTransaction` legacy
- `P01RelayerV1Router` — wrapping via p01_relayer + v1 X25519 (cap inner ~845B avec LUT, sinon ~620B)
- `P01RelayerV2Router` — wrapping via p01_relayer + v2 ML-KEM (cap inner ~750B avec LUT + multi-tx submit_job, sinon impossible)
- `ArciumMpcRouter` — Phase D, threshold-decrypt MPC (depend du payload size limit Arcium)

`signAndSendV3` devient un dispatcher qui choisit le router selon `relayerV3Enabled` + preflight. Un router NE DOIT JAMAIS faire de side-effect on-chain avant que `preflight().fits === true`.

---

## 3. Tx envelope strategy

### Constat 2026-05-06

```
Solana tx max         : 1232 bytes
Outer submit_job tx fixed overhead : ~270 bytes
ix data fixed (disc + jobId + encLen) : 44 bytes
v1 X25519 encryption overhead         : 73 bytes  
v2 ML-KEM hybrid overhead             : 1161 bytes
─────────────────────────────────────────
Inner tx budget v1 : 845 bytes
Inner tx budget v2 : -243 bytes (impossible sans patch)
```

Mesures réelles :
- shield V3 inner = 947B → **dépasse v1 par 102B**
- unshield V3 inner ≈ 700-800B (estimé, à mesurer)
- transfer V3 inner ≈ 700-800B (estimé)

### A.2 — Versioned tx + Address Lookup Table (LUT)

LUT contient toutes les pubkeys statiques :
- programs : `zk_shielded`, `p01_stark_verifier`, `p01_relayer`, `system`, `token_program`, `compute_budget`
- comptes : `protocol_fee_wallet`, `treasury` (futur)
- pools : tous les denominated pools v3 (un seul LUT pour tous les pools v3 actifs)

Gain attendu :
- shield V3 : 947B → ~700B (compression de 8 keys × 32 = 256B → 8 × 1 = 8B)
- unshield V3 : ~800B → ~600B
- transfer V3 : ~800B → ~600B

**Tous les flows V3 fittent dans v1 (845B budget).** ML-KEM v2 hybride reste impossible sans A.3.

Effort : 2-3 jours.
Dépendance : déployer un LUT account on-chain, en publier l'adresse dans une const partagée, migrer les builders V3 vers `VersionedTransaction.compileMessage({ payerKey, recentBlockhash, instructions, addressLookupTableAccounts })`.

### A.3 — Multi-tx submit_job (chunked encrypted_tx)

Pour permettre ML-KEM v2 (PQ confidentialité du payload) qui fait 1161B d'overhead, on doit pouvoir uploader un encrypted_tx > 1232 - 270 - 44 = 918B en plusieurs tx.

Pattern miroir du STARK proof upload :
- `init_relay_job(job_id, total_size, relayer_id)` — alloue le PDA `RelayJob` avec un buffer de la bonne taille
- `write_relay_chunk(job_id, offset, bytes)` — écrit dans le buffer
- `finalize_relay_job(job_id)` — marque ready-to-pickup

Effort : 4-5 jours (program change + redeploy + mobile SDK migration).
Trade-off : multi-tx augmente la latence (~2-5s par chunk) et coûte plus de tx fees mais débloque PQ end-to-end.

### A.4 — Compression (optionnel)

gzip/brotli sur l'inner tx avant encrypt. Gain typique 20-30%. Adds 1-3 KB de code mobile et un peu de CPU.

Use case : si A.2 + A.3 ne suffisent pas pour des futures opérations (note batches, multi-recipient transfers).

---

## 4. Ephemeral lifecycle (recovery-safe)

### Problème actuel (Phase A wiring)

```ts
const ephemeral = Keypair.generate();      // RANDOM, jamais sauvé
await connection.sendRawTransaction(fundTx);  // pre-fund 0.02 SOL
// ... si on throw ici, ephemeral lost forever
```

### Cible (Phase A.1)

```ts
// Dérive l'ephemeral depuis HKDF(user_seed, job_id_salt). Reproductible
// quelque soit la session. Le user peut TOUJOURS sweep en re-dérivant.
const ephemeral = deriveEphemeralForRelay(userSeed, jobId);
```

Côté UI ajouter un écran "Stuck funds recovery" qui :
1. Liste tous les jobIds sauvegardés en SecureStore (chaque submitRelayJob append un entry pre-fund)
2. Pour chaque jobId, re-dérive l'ephemeral, check le balance on-chain
3. Si > rent_exempt, sweep vers le main wallet via tx user-signed

Storage : `SecureStore['p01_relay_pending_ephemerals']` = JSON array of `{ jobId, derivedAt, expectedAmount }`. Auto-cleanup quand sweep > 0 lamports remaining.

### Two-phase commit

Le router DOIT faire :

```ts
async send(connection, tx, signers) {
  const pre = this.preflight(tx);
  if (!pre.fits) throw new Error(`Router ${this.name}: ${pre.reason}`);
  
  // SAVE recovery handle BEFORE any on-chain side-effect
  const recovery = await this.persistRecoveryHandle(jobId, ephemeralPubkey);
  
  try {
    // ... pre-fund, submit, monitor
    return { sig, recoveryHandle: recovery };
  } catch (e) {
    // recovery is still persisted — UI can sweep later
    throw new RouterError(e, recovery);
  }
}
```

---

## 5. Buffer cleanup invariant

Tous les builders V3 doivent suivre ce pattern :

```ts
let createdBuffers: PublicKey[] = [];
try {
  await submitAndVerifyStarkProof(...);
  createdBuffers.push(c1ProofBuffer);  // append immédiatement après création
  // ... inner tx
} finally {
  for (const buf of createdBuffers) {
    try {
      await closeStarkProofBuffer(buf, signer, connection);
    } catch (e) {
      logger.warn('close failed', buf.toBase58(), e);
    }
  }
}
```

Le drapeau `didShield` est WRONG car il découple cleanup de création. À supprimer dans Phase A.1.

---

## 6. Relayer node software (production-ready)

### Phase A.4 — `relayer-node` package

Nouveau package `packages/relayer-node/` avec :

- **Worker daemon** Node.js qui poll les `RelayJob` PDAs avec status=Pending pour cet operator
- **Decrypt** : utilise la X25519 secret key (et v2 ML-KEM secret quand A.3 ship)
- **Validate** inner tx (programs whitelisted, max CU, etc.)
- **Submit** inner tx via getLatestBlockhash + sendRawTransaction
- **Call complete_job(tx_signature)** une fois confirmée

Configuration via env:
```
P01_RELAYER_OPERATOR_KEYPAIR=...
P01_RELAYER_X25519_SECRET=...
P01_RELAYER_KEM_SECRET=...
P01_RELAYER_RPC_URL=...
P01_RELAYER_POLL_INTERVAL_MS=2000
```

Déploiement :
- Devnet : Railway/Fly.io ($5/mo)
- Mainnet : multi-region pour SLA + multiple operators pour décentralisation

### Phase A.4.b — Decentralized operator pool

Plusieurs operators register on-chain. Le client choisit déterministiquement (déjà fait via SHA256(blockhash || jobId) % count). Un operator slashed = backup pris automatiquement au prochain submit.

Reputation (déjà tracked on-chain) sert au tri.

---

## 7. Test coverage matrix

### Unit (mobile)

- `signAndSendViaRelayer` avec mock connection :
  - happy path (preflight pass + submit + monitor + complete)
  - oversized inner tx → preflight throws, no on-chain side-effect
  - relayer fetch fails → preflight throws, no on-chain side-effect
  - mid-flight monitor timeout → recovery handle persisted, sweep works
- `fitsInRelayerEnvelope` exhaustif sur layouts shield/unshield/transfer V3 + V3+LUT
- `deriveEphemeralForRelay` deterministic — same input → same keypair, never collides

### Integration (devnet)

- bootstrap script idempotent (re-run safe)
- end-to-end shield via direct router (control)
- end-to-end shield via P01RelayerV1Router avec node running
- end-to-end recovery flow : trigger oversized tx → assert no SOL leak → sweep recovers all
- regression : tx size budget asserts that shield/unshield/transfer V3 + LUT < 845B

### Property-based

- Pour chaque opération V3, fuzz les inputs (denomination, depth, recipient address) → assert inner tx size stable < budget

---

## 8. Observability

### Structured logs (toutes phases)

`[V3-Relay]` prefix pour wrapper côté client.
`[Relay]` prefix pour SDK p01_relayer.
`[RelayerNode]` prefix pour le node daemon.
Niveaux : DEBUG, INFO, WARN, ERROR explicites (passer un log level config).

### Métriques (Phase A.5)

Counters in-app :
- `relayer.routings.total`
- `relayer.routings.fallback_oversized`
- `relayer.routings.fallback_no_node`
- `relayer.completions.total`
- `relayer.timeouts.total`
- `relayer.sweeps.total`

Exposable via le AutoRunner pour debug ou via Sentry custom events si jamais on shipping Sentry.

---

## 9. Sequencing recommandé

| Phase | Scope | Effort solo | Bloque ship | Status |
|-------|-------|-------------|-------------|--------|
| A — wiring | submitRelayJob + wrapper + toggle UI | 4h | non | ✅ |
| A.1 — fixes critiques | oversized fallback + buffer cleanup + deterministic ephemeral + sweep UI | 1-1.5j | OUI (sinon brûle SOL) | 🚧 today |
| A.2 — Versioned tx + LUT | shield/unshield/transfer V3 fittent | 2-3j | non (gain UX) | queued |
| A.3 — Multi-tx submit_job | ML-KEM v2 PQ disponible | 4-5j | non | queued |
| A.4 — Relayer node software | E2E réel, plus de timeout | 2-3j | OUI pour vraie privacy | queued |
| A.5 — Test coverage matrix | regression-safe | 2j | non | queued |
| A.6 — Decentralized operator pool | SLA + censorship-resist | 1 sem | non | post-MVP |
| A.7 — Composability avec Phase D Arcium MPC | router-swap to threshold-decrypt | 1 sem | non | post audit |

**Total Phase A complète** : ~3-4 semaines solo full-time.

---

## 10. Phase A.1 — fixes critiques exécutés MAINTENANT

### Fix 1 : preflight avant tout side-effect

`signAndSendViaRelayer` doit, AVANT de pre-fund l'ephemeral :
1. Sign + serialize l'inner tx → mesurer la taille
2. Si > 845B (vrai budget v1) : throw `OversizedInnerTxError` AVEC un fallback explicite vers direct submission
3. Si fits : continuer

### Fix 2 : `didCreateBuffer` invariant

Dans shieldV3, unshieldDenominatedStarkV3, transferDenominatedStarkV3 : remplacer `didShield/didUnshield/didTransfer` par `createdBuffers: PublicKey[]` qu'on append après chaque verify, et le finally ferme tout.

### Fix 3 : deterministic ephemeral derivation

Dans `apps/mobile/services/relay/index.ts`, ajouter `deriveEphemeralForRelay(userSeed, jobId): Keypair`. Implémenter via `nacl.sign.keyPair.fromSeed(hkdf(seed, salt='p01_relay_ephemeral_v1', info=jobId))`. Le `submitRelayJob` accepte désormais un `ephemeralKeypair?` qu'on peut fournir et qui est dérivé.

### Fix 4 : recovery storage

Pre-fund tx → AVANT `connection.sendRawTransaction`, persister `{ jobId, ephemeralPubkey, expectedLamports, createdAt }` dans `SecureStore['p01_relay_pending']`. Sur succès final → remove l'entry. Sur erreur → entry reste, accessible depuis l'UI Settings.

### Fix 5 : recovery sweep UI

Ajouter une section dans Settings → Privacy → "Stuck funds recovery". Liste les pending entries, propose un bouton sweep par entry qui re-derive l'ephemeral, vérifie le balance, sweep vers main wallet.

---

## 11. Limitations connues qui survivent à toutes les phases

Mêmes que `tx-opacity-plan-2026-05-06.md` :
- Programs liste visible dans la tx (sauf via Mugen Layer 0 Nym)
- Account access list visible (LUT compresse mais ne cache pas)
- block metadata (slot, blockhash, fee_payer obligatoire)
- Quantum payer Ed25519 (couvert par `plan-full-pq-end-to-end-2026-05-03.md`)

Ces limites sont fundamentaux Solana L1, pas réparables au niveau relayer.
