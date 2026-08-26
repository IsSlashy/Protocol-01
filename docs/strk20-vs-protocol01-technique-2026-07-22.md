# STRK20 vs Protocol 01 — document technique

Établi le 22 juillet 2026. Complément du brief `brief-starknet-22-juillet.pdf` et de `starknet-buildathon-2026-07-22-roadmap.md`.

Deux règles de lecture:

- Tout ce qui concerne STRK20 vient du **code source ouvert** `starkware-libs/starknet-privacy` (Apache 2.0, ouvert le 8 juillet 2026), pas des pages marketing. Chaque affirmation porte son fichier ou son URL.
- Tout ce qui concerne Protocol 01 vient d'une lecture du dépôt, pas des notes de mémoire. Là où le code contredit le brief, c'est signalé en clair.

---

## 0. À lire en premier — trois choses qui changent la journée

### 0.1 STRK20 est open source. Le "SDK gated" n'est plus le risque n°1.

`https://github.com/starkware-libs/starknet-privacy` contient le contrat Cairo du pool, le service de discovery en Rust, le SDK TypeScript, les preuves formelles Lean, et les contrats anonymizer. Le pool mainnet est déployé à `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a`.

Ce qui reste réellement gated: l'URL du **proving service** et celle de l'**indexer** (variables d'environnement sans valeur par défaut nulle part), et le paquet npm `@starkware-libs/starknet-privacy-sdk` qui est sur GitHub Packages, pas sur npm public (404 sur le registre par défaut).

Ce sont les vraies questions à poser à 9h30, pas "puis-je avoir accès au SDK".

### 0.2 Le plan initial ne peut pas marcher tel quel

Le projet prévu était: Specter dérive une adresse furtive, STRK20 transfère en privé vers cette adresse. **C'est impossible dans STRK20.**

> `STRK20_TRANSFER_ACTION` — "Privately transfers funds inside the privacy pool to another **registered** user."
> — `@starknet-io/types-js@0.10.3`, `components.d.ts:203`

Et le contrat l'assère en dur:

```cairo
// open_channel
let sender_public_key = self.public_key.read(sender_addr);
assert(sender_public_key.is_non_zero(), errors::SENDER_NOT_REGISTERED);
let recipient_public_key = self.public_key.read(recipient_addr);
assert(recipient_public_key.is_non_zero(), errors::RECIPIENT_NOT_REGISTERED);
```
— `packages/privacy/src/privacy.cairo:368-379`

Il n'y a **aucune adresse furtive dans STRK20**. Le destinataire est adressé par son **adresse Starknet en clair**, qui doit avoir enregistré une clé de vue publique on-chain au préalable. Une adresse dérivée à la volée ne peut rien recevoir.

Leur contournement documenté est un contrat d'escrow (`poseidon(ESCROW_COMMITMENT_TAG, secret)` + lien de claim off-chain), pas de la découverte de destinataire.

Le point de branchement doit donc bouger. Voir section 5.

### 0.3 Le vrai trou est meilleur que celui prévu

En cherchant où brancher ML-KEM, on tombe sur nettement mieux que la découverte de destinataire: **la séquestre de clé de vue pour la compliance**.

À l'enregistrement, le contrat chiffre lui-même la clé de vue **privée** de l'utilisateur vers la clé publique de l'auditeur, et la stocke on-chain de façon immuable:

```cairo
/// Ciphertext for an ECDH-based encryption of private key.
/// Used for the auditor to be able to decrypt the private key.
pub(crate) struct EncPrivateKey {
    pub auditor_public_key: felt252,
    pub ephemeral_pubkey: felt252,
    /// `enc_private_key = h(ENC_PRIVATE_KEY_TAG, rK.x) + private_key`
    pub enc_private_key: felt252,
}
```
— `packages/privacy/src/objects.cairo:42-53`

Donc: une clé qui déchiffre l'historique bidirectionnel complet d'un utilisateur, chiffrée par ECDH sur la courbe STARK, publiée on-chain, immuable (WriteOnce), et permanente. C'est la surface harvest-now-decrypt-later la plus dense qui existe dans leur système. La Q3 du brief visait juste, et le code la confirme mot pour mot.

---

## 1. Comment STRK20 marche

### 1.1 Le modèle: pas de Merkle, pas de commitment

C'est la surprise architecturale principale, et elle inverse l'intuition de quiconque vient de Tornado/Zcash/ton propre pool.

**Il n'y a pas d'arbre de Merkle.** Pas d'accumulateur, pas de racine, pas de fenêtre de racines historiques. Un `grep -ril merkle` sur tout le dépôt ne renvoie qu'un seul fichier, et le hit parle du trie d'état de Juno, pas du protocole.

Les notes vivent directement dans des maps de stockage Cairo:

```cairo
notes: Map<felt252, Note>,
nullifiers: Map<felt252, bool>,
recipient_channels: Map<ContractAddress, Vec<EncChannelInfo>>,
```
— `packages/privacy/src/privacy.cairo:88-99`

**Une note n'est pas un hash-commitment.** Elle a deux champs:

```cairo
pub struct Note {
    /// The packed value of the note `(salt, amount)`
    pub packed_value: felt252,
    /// The token address of the note (zero for encrypted notes).
    pub token: ContractAddress,
}
```
— `packages/privacy/src/objects.cairo:89-100`

Le propriétaire, le token et l'index ne sont pas dans un préimage de commitment: ils sont liés **implicitement par la clé de stockage**.

```
note_id   = Poseidon(NOTE_ID_TAG, channel_key, token, index, 0)
nullifier = Poseidon(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)
```
— `packages/privacy/src/hashes.cairo:200-236`

Comme `channel_key` est un secret partagé uniquement entre l'émetteur et le destinataire, les slots de stockage sont pseudo-aléatoires pour tout observateur. **Le pseudo-aléatoire de l'adresse de stockage remplace l'anonymat de l'ensemble d'un arbre de Merkle.**

Conséquence directe: `use_note` ne fait aucune preuve d'appartenance à un arbre. Il lit la note en stockage:

```cairo
let subchannel_marker = compute_subchannel_marker(...);
assert(self.subchannel_exists.read(subchannel_marker), errors::SUBCHANNEL_NOT_FOUND);
let packed_value = self.notes.entry(note_id).packed_value.read();
assert(packed_value.is_non_zero(), errors::NOTE_NOT_FOUND);
```
— `packages/privacy/src/privacy.cairo:585-629`

Asymétrie utile à connaître: le nullifier contient la clé privée du **propriétaire**, donc l'émetteur d'une note ne peut pas calculer son nullifier et ne peut pas observer quand son paiement est dépensé.

### 1.2 Le chiffrement: ECDH sur la courbe STARK, "hash-and-add"

Il n'y a **pas de KEM** au sens moderne, et pas de chiffrement symétrique authentifié. Deux couches:

**Couche 1, ouverture de canal (asymétrique).** ECDH sur la courbe STARK avec un scalaire éphémère `r` par canal. Seule l'abscisse `x` du point est utilisée. La KDF est un simple Poseidon domain-séparé, et le "chiffrement" est une addition dans le corps de base.

```cairo
fn _compute_shared_x(ephemeral_secret: felt252, public_key: felt252) -> (felt252, felt252) {
    let ephemeral_pub_point = GEN_P().mul(scalar: ephemeral_secret);
    let public_point = EcPointTrait::new_from_x(x: public_key)...;
    let shared_point = public_point.mul(scalar: ephemeral_secret);
    let shared_x = ...x();
}
```
— `packages/privacy/src/utils.cairo:123-145`

```
enc_channel_key = h(CHANNEL_KEY_TAG, rK.x) + channel_key
enc_sender_addr = h(SENDER_ADDR_TAG, rK.x) + sender_addr
```

**Couche 2, données dans le canal (symétrique).** Une fois la clé de canal établie, tout est masqué par hash-and-add:

```
enc_amount = (Poseidon(ENC_AMOUNT_TAG, channel_key, token, index, 0, salt) + amount) mod 2^128
enc_token  =  Poseidon(ENC_TOKEN_TAG, channel_key, index, 0, salt) + token
packed_value = salt * 2^128 + enc_amount        // salt sur 120 bits, choisi par l'émetteur
```
— `packages/privacy/src/hashes.cairo:212-222`

Dérivation de la clé de canal, et directionnalité:

```
channel_key = Poseidon(CHANNEL_KEY_TAG, sender_addr, sender_private_key, recipient_addr, recipient_public_key)
```

Alice→Bob et Bob→Alice sont **deux canaux distincts**. Un dépôt est un canal de soi vers soi.

Contrainte cryptographique à connaître: comme seules les abscisses servent à l'ECDH, `k` et `ORDER − k` seraient indistinguables. Le contrat impose donc que les clés de vue privées soient dans la moitié basse de l'ordre de la courbe (`is_canonical_key(key) = key < HALF_ORDER`). Une clé hors borne compile mais dérive silencieusement de mauvaises clés de canal — les notes ne se déchiffreront jamais.

**Le schéma est figé dans le contrat.** Il n'y a aucun champ de version ou d'algorithme sur `Note` ni sur `EncChannelInfo`. Le seul versionnage est le suffixe `:V1` dans les 17 tags de séparation de domaine Poseidon. Changer de schéma exige un upgrade de contrat (le contrat embarque `ReplaceabilityComponent` d'OpenZeppelin).

### 1.3 L'adressage du destinataire: par adresse en clair

C'est la réponse à la Q1 du brief, et elle est nette.

Il n'y a **ni tag de détection, ni view tag, ni scan de tout le pool**. Le contrat stocke:

```cairo
/// Map of recipient_addr to a list of their encrypted channels.
recipient_channels: Map<ContractAddress, Vec<EncChannelInfo>>,
```

L'émetteur ajoute un `EncChannelInfo` dans le seau du destinataire via l'action serveur `Append`, indexée par l'adresse Starknet **en clair** du destinataire. Le destinataire ne lit que son propre seau et déchiffre par essai chaque entrée.

Fuite documentée qui en découle: le slot de stockage est dérivé déterministiquement de l'adresse en clair (`get_storage_var_address("recipient_channels", [recipient_address])`), donc **tout observateur des state diffs voit qu'une adresse précise vient de recevoir un nouveau canal**. Seul le premier transfert d'une paire (émetteur, destinataire) fait cela; les notes suivantes vont dans des slots dérivés du `channel_key` secret. Le SDK émet d'ailleurs un warning `WarningCode.USER_LINKAGE` quand plusieurs `OpenChannel` apparaissent dans une même transaction.

La discovery est un balayage d'index dense à 3 niveaux, qui s'arrête au premier slot vide: canaux, puis sous-canaux par token, puis notes par index, en testant chaque nullifier dérivé contre l'état on-chain. Tous les slots sont WriteOnce et les index doivent être séquentiels (`INDEX_NOT_SEQUENTIAL`).

**Le coût de scan est proportionnel à ton activité, pas au volume du pool.** C'est architecturalement supérieur au scan de Protocol 01 sur ce point précis (voir 3.8).

### 1.4 Le modèle de transaction: 8 phases ordonnées

Pas de triplet shield/transfer/unshield. Une transaction est une liste d'actions regroupées en 8 phases, qui doivent apparaître dans un ordre non décroissant:

| Phase | Action |
|---|---|
| 0 | SetViewingKey |
| 1 | OpenChannel |
| 2 | OpenSubchannel |
| 3 | Deposit |
| 4 | UseNote |
| 5 | CreateEncNote / CreateOpenNote |
| 6 | Withdraw |
| 7 | InvokeExternal (au plus une fois par tx) |

— `packages/privacy/src/actions.cairo:275-316`

Traduction depuis ton vocabulaire:

- shield = Deposit + CreateEncNote vers soi
- transfer = UseNote + CreateEncNote(destinataire) + CreateEncNote(monnaie rendue)
- unshield = UseNote + Withdraw

**La conservation de la valeur n'est pas une contrainte de circuit.** C'est un registre de balance temporaire par token à l'intérieur d'une transaction: Deposit et UseNote ajoutent, CreateNote et Withdraw retranchent, la balance ne peut jamais devenir négative, et chaque token doit finir exactement à zéro (`NEGATIVE_INTERMEDIATE_BALANCE`, `FINAL_BALANCE_MUST_BE_ZERO`).

C'est important pour toi: eux résolvent le problème de conservation de valeur par une machine à états on-chain, toi par la dénomination du pool. Ni l'un ni l'autre ne le met dans une AIR.

### 1.5 La preuve: où elle est vérifiée

Le chemin exact, souvent mal décrit:

1. Le SDK compile les actions et les envoie à un **proving service opéré par un tiers**.
2. Le service exécute les actions dans un **bloc Starknet virtuel** (Virtual SNOS), un OS Starknet modifié à fonctionnalité réduite. Les builtins `add_mod`, `mul_mod` et Keccak sont exclus des claims prouvés en phase 1.
3. La preuve Stwo revient et voyage dans les champs **optionnels** `proof` (tableau de uint32) et `proof_facts` (tableau de felt252) d'une transaction Invoke V3 — pas dans le calldata.
4. Un **vérificateur S-two écrit en Rust, embarqué dans le gateway/séquenceur**, vérifie la preuve. Pas un contrat Cairo. Pas (en phase 1) une récursion dans la preuve d'état L2 réglée sur L1.
5. Le contrat de pool lit seulement les petits `proof_facts` via un syscall dédié, valide la variante de programme (`VIRTUAL_SNOS`), le bloc de base, la fenêtre de validité et le hash de message.

— SNIP-36, `community.starknet.io/t/snip-36-in-protocol-proof-verification/116123`

Deux conséquences que StarkWare écrit noir sur blanc et qu'il faut connaître avant d'en parler:

> "applications built with this feature will have **degraded security** compared to native Starknet applications" — à corriger dans une release ultérieure.

> "The protocol is **not zero-knowledge by default**; proofs reveal no execution data beyond declared public input."

La confidentialité v0.14.2 est décrite comme "de facto (les données sont computationnellement infaisables à extraire)", le vrai ZK est reporté en phase 2.

**Fenêtre de validité de preuve.** L'analogue de ta fenêtre de racines historiques: le contrat rejette les preuves plus vieilles que `proof_validity_blocks` (450 blocs, environ 15 min à 2 s/bloc). Convention du SDK: prouver à `currentBlock - 10`. Les notes ne sont dépensables que 10 blocs après création, et tout état on-chain lu par la preuve (clé de vue du compte, balance du déposant, set de nullifiers) doit avoir été écrit au moins 10 blocs avant le bloc de base.

### 1.6 Le système de preuve: Circle STARK sur M31

- **Stwo (S-two)**, Circle STARK sur le premier de Mersenne **M31, p = 2^31 − 1**, avec une tour M31 → CM31 (ext. quadratique) → QM31 (ext. quartique, utilisée pour Fiat-Shamir et les aléas DEEP/FRI).
- Pourquoi pas un corps 64 bits: M31 a une 2-adicité de **1** (p−1 = 2·(2^30−1)), donc aucun sous-groupe lisse en 2^k pour une FFT radix-2. Le Circle STARK contourne ça via la courbe circulaire x² + y² = 1, dont le groupe de points a un ordre de **p+1 = 2^31**, exactement une puissance de deux. Papier: Haböck, Levit, Papini, ePrint 2024/278, annonçant 1,4× de gain sur un STARK BabyBear.
- Le vrai argument est la densité SIMD: la réduction mod 2^31−1 est un décalage cyclique, et l'arithmétique tient dans des lanes 32 bits AVX2/AVX-512/NEON/WASM-SIMD.
- Hash de commitment: **Blake2s-256 par défaut**, Poseidon252 en option pour le règlement Ethereum. L'arbre de Merkle est "lifté": le hash d'un nœud dépend des enfants **et** des valeurs de colonnes injectées à cette couche, ce qui permet de committer des colonnes de hauteurs différentes sans padding.
- Paramètres par défaut de stwo-cairo: **log_blowup = 1 (blowup 2), 70 requêtes, 26 bits de grinding, cible 96 bits de soundness _conjecturée_** (régime list-decoding), plus un proof-of-work de phase d'interaction (`INTERACTION_POW_BITS`).
- Pas de trusted setup.

**Le point architectural qui compte vraiment.** Cairo est **une AIR de CPU fixe**. Un unique jeu immuable de contraintes polynomiales prouve l'exécution valide de la machine Cairo; le programme applicatif n'est pas compilé en contraintes, il est **de la donnée** placée en mémoire publique et consommée comme trace.

> "We describe a single set of polynomial equations for the statement that the execution of a program on this architecture is valid. Given a statement one wishes to prove, Cairo allows writing a program that describes that statement, instead of writing a set of polynomial equations."
> — Cairo paper, ePrint 2021/1063

En pratique stwo-cairo décompose ça en 69+ composants (un par opcode, un par builtin) reliés par des arguments de lookup LogUp. Les builtins sont des périphériques mappés en mémoire qui remplacent un calcul coûteux dans la VM par un composant d'AIR dédié moins cher.

C'est ça, "le circuit et le contrat sont le même code": pas de DSL de circuit, pas d'AIR par application, pas de vérificateur déployé par application.

Benchmark officiel S-two (Fibonacci n = 2^20, 48 cœurs EPYC, CPU seul): 18,61 s de preuve, **808 KB de preuve**, 414 ms de vérification. SHA-256 (n = 2^18 octets) avec précompile: 121 s, **1315 KB**, 83 ms.

### 1.7 Compliance: ce que ça révèle exactement

- Une seule clé d'auditeur dans le stockage du contrat (`auditor_public_key: felt252`), posée au déploiement, modifiable par le rôle `security_governor`. Les docs parlent de support de clés à seuil; **le contrat ne stocke qu'une seule clé publique STARK**.
- Une clé de vue récupérée révèle l'historique **bidirectionnel complet**: tous les canaux entrants (qui a payé, combien, quel token), tous les canaux sortants (qui a été payé), chaque montant de note, l'appariement nullifier↔note, et le traçage avant (dépôt→notes→transferts→retrait) comme arrière (retrait→notes→dépôts d'origine). L'auditeur ne peut pas dépenser: la dépense exige une signature de compte vérifiée dans la preuve.
- **Screening de dépôt appliqué on-chain** depuis v0.14.3: chaque dépôt porte une attestation SNIP-12 `DepositorValidation { depositor, issued_at }` signée par un screener off-chain dont la clé publique STARK est en stockage; le pool vérifie l'ECDSA. Expiration 300 s, tolérance de dérive future 60 s. **Faire tourner son propre prover ne contourne pas ça.** Le fournisseur de données dans le code est Elliptic (via un proxy GCP `elliptic-proxy`), alors que les docs publiques nomment "FPI" — divergence non expliquée, avec en plus des listes opérateur d'autorisation/blocage (`blockOverrideAddresses`, `additionalBlockedAddresses`).
- Ce qui est public à chaque bord: l'événement `Deposit` porte `user_addr`, `token`, `amount` en clair; `Withdrawal` porte `to_addr`, `token`, `amount` en clair plus un `enc_user_addr` chiffré pour l'auditeur; `ViewingKeySet` lie publiquement une adresse à sa clé de vue publique.
- Limites reconnues par leurs propres docs: liaison à l'ouverture de canal, motifs de montants/timing distinctifs, et "les arêtes sont publiques par conception".

### 1.8 Deux constats de confiance qu'il faut avoir en tête

Ce ne sont pas des accusations, c'est ce que dit leur code et leurs specs.

**La clé de vue privée part en clair au proving service.**

```ts
const executeViewCalldata = callDataCompiler.compile("compile_actions", [
  userAddress, user.viewingKey, cairoActions
]);
```
— `sdk/src/internal/proof-invocation-factory.ts:128-140`

Un prover hébergé apprend donc la clé qui déchiffre l'historique entier de l'utilisateur.

**Le discovery service reçoit aussi des clés de déchiffrement et renvoie du déchiffré.**

> "The service decrypts and returns decrypted channels and unspent notes. Decryption keys must be provided per request."
> "The operator can observe: which recipients are active and when. How many channels, subchannels, and notes each recipient has. Token addresses used per channel. Timing of sync activity."
> — `crates/discovery-service/specs/05-security-considerations.md`

La mitigation est OHTTP (basé X25519, relais optionnel), et elle ne couvre que la corrélation d'IP.

**Audit OpenZeppelin.** Commit `c5e2fb53…`. Deux constats notables: le scalaire éphémère `r` est fourni par le client et seulement validé non nul — le contrat "n'impose pas l'unicité ni n'empêche la réutilisation de r"; et une `auditor_public_key` invalide déclenche des panics `EcPointTrait::new_from_x(...).unwrap()` capables de bloquer enregistrements et retraits à l'échelle du système.

### 1.9 Ce qui tourne, et depuis quand

| Date | Événement |
|---|---|
| 10 mars 2026 | Annonce STRK20 |
| 20 avril 2026 | Starknet v0.14.2 mainnet — vérification de preuve in-protocol (SNIP-36) |
| 12 mai 2026 | strkBTC, premier actif STRK20, mainnet |
| 4 juin 2026 | Annonce private DeFi |
| 25 juin 2026 | USDC privé |
| 8 juillet 2026 | Dépôt `starknet-privacy` ouvert (Apache 2.0) |

Live: swaps privés sur AVNU et Ekubo, shielding in-wallet via Ready X et Xverse. Prêt Vesu, staking Endur et stratégies de coffre privées sont annoncés en phase ultérieure. Frais: **fixe par transaction**, 4 STRK annoncés.

Seuls deux wallets implémentent la Privacy Wallet API, et un seul est exposé aux dapps: **Ready** est live côté dapp, **Xverse** a le privacy in-wallet mais son support Wallet API côté dapp est en cours.

### 1.10 La surface développeur, exactement

**Privacy Wallet API = Starknet Wallet API v0.10.3**, publiée en types TypeScript dans `@starknet-io/types-js@0.10.3`. Elle expose **exactement trois** méthodes STRK20. Il n'y a **aucune** méthode nommée shield, unshield ou claim.

```ts
wallet_strk20InvokeTransaction  // { actions: STRK20_ACTION[] } -> { transaction_hash }
wallet_strk20PrepareInvoke      // { actions, simulate? }       -> STRK20_CALL_AND_PROOF
wallet_strk20Balances           // { tokens: Address[] }        -> STRK20_BALANCE_ENTRY[]
```

Les 4 variantes d'action sont `deposit` (toujours vers soi, pas de champ recipient), `withdraw`, `transfer` (accepte le littéral `"OPEN"` comme montant), `invoke`.

Il n'y a **pas de méthode de scan de notes dans la Wallet API**. Une dapp ne peut lire que des balances agrégées par token. Le scan n'existe que dans le Privacy SDK de plus bas niveau (`discoverNotes`, `discoverChannels`), qui exige de détenir la clé de vue. C'est délibéré: "A normal dapp should not receive the user's viewing key or manage note discovery directly."

Côté dapp il faut **starknet.js ≥ 10.4.0** et la classe `WalletAccountV6`. Attention: le tag npm `latest` de `starknet` est 10.0.2; les versions capables STRK20 sont sur le tag `next` (10.5.1). À épingler explicitement.

Le SDK bas niveau utilise un builder fluide dont les verbes sont `register`, `deposit`, `transfer`, `withdraw`, `setup`, `invoke`:

```ts
await transfers.build(opts)
  .with(TOKEN, t => t.inputs(note).transfer({ recipient, amount }).withdraw({ amount }))
  .surplusTo(self)
  .execute({ provingBlockId });
```

Trois pièges de soumission documentés, qui mordront n'importe quelle intégration: `proofFacts: []` doit être **omis entièrement** (spread conditionnel) sinon starknet.js sérialise une v3 invalide; `tip: 0n` est obligatoire; et il faut appeler `invalidateProofNonceCache()` après tout échec de soumission.

Temps de preuve: chiffres contradictoires non réconciliés dans les sources — **~29 s** (12 cœurs / 46 GiB) dans le diagramme de pipeline, **~4 s** dans le README du SDK, "few-seconds area" selon l'auteur de SNIP-36.

---

## 2. Comment Protocol 01 marche — vérité terrain

Cette section corrige la fiche technique du brief là où le code dit autre chose. C'est plus important que de la confirmer.

### 2.1 Corrections à la fiche technique

| Élément | Brief PDF | Code | Verdict |
|---|---|---|---|
| Hash Merkle / Fiat-Shamir | Blake3-256 | **SHA-256** | ❌ à corriger |
| Requêtes | 32 | **27** (C0,C1,C2,C4) / **22** (C3,C5,C6) | ❌ à corriger |
| Grinding | aucun | **16 bits** | ❌ à corriger |
| Folding FRI | 8 | **2** | ❌ à corriger |
| Soundness | 128 bits | **124 bits** (27q) / **104 bits** (22q), classique | ❌ à corriger |
| Blowup | 16 | 16 | ✅ |
| Corps | Goldilocks 2^64−2^32+1 | idem, confirmé des deux côtés | ✅ |
| Taille de preuve | 60–120 KB | **80 KB (C0) à 144 KB (C4)** | ⚠️ à élargir |
| Chunks | 145 pour un shield | 145 tx de 1000 B (taille uniforme) | ✅ |
| Trusted setup | aucun | aucun, vérifié par grep exhaustif | ✅ |
| Deux phases FRI puis DEEP-ALI | oui | oui | ✅ |
| Vérification ~1,1M CU | — | **aucune mesure committée** | ⚠️ voir 2.3 |
| 7 circuits AIR en Rust | oui | oui, circuit_id 0–6 | ✅ |

**Pourquoi SHA-256 et pas Blake3.** La raison est documentée dans `stark/Cargo.toml`: le syscall `sol_blake3` est derrière un feature runtime inactif sur devnet et mainnet, donc un Blake3 logiciel coûtait ~15k CU par hash et faisait exploser le budget. `sol_sha256` coûte ~85 CU par appel. Blake3 n'apparaît plus que dans `stark/src/prover.rs`, qui est le **chemin legacy winterfell mort**, jamais vérifié on-chain.

**Pourquoi les paramètres du brief sont ceux d'un fichier mort.** `stark/src/prover.rs:45-54` construit bien un `ProofOptions::new(32, 16, 0, FieldExtension::None, 8, 31)` avec un commentaire "128-bit security". Mais rien dans le pipeline on-chain ne lit ce fichier. Le format réellement vérifié sur Solana est un protocole écrit à la main dans `stark/src/compact.rs`, qui n'importe de winterfell que `BaseElement` et `FieldElement`. Le programme on-chain n'a **aucune** dépendance winterfell.

Les vrais chiffres:

```rust
const BLOWUP: usize = 16;
// Soundness: NUM_QUERIES × log2(BLOWUP) + grinding ≈ bits of security.
// 27 × 4 + 16 = 124 bits > 100-bit target. Classical soundness.
const NUM_QUERIES: usize = 27;
const GRINDING_BITS: u32 = 16;
```
— `stark/src/compact.rs:29-38`

Nuance à assumer si on te pousse: cette formule est l'heuristique naïve, sans décote de proximity gaps, et le point OOD `z` est échantillonné dans le **corps de base** (~2^64), pas dans une extension. Le terme Schwartz-Zippel est donc bien en dessous de 124 bits. Le code ne distingue nulle part soundness conjecturée et prouvée. Eux le font ("96 bits of **conjectured** soundness").

### 2.2 Les 7 circuits, table exacte

Source: `programs/p01_stark_verifier/src/compact_proof.rs:50-166` (`CircuitConfig`, l'autorité que le parseur on-chain utilise).

| id | Nom | Largeur | Longueur | LDE | Prof. Merkle | Requêtes | Contraintes | Taille preuve |
|---|---|---|---|---|---|---|---|---|
| 0 | subscriber_ownership | 3 | 32 | 512 | 9 | 27 | 3 | 79 993 B |
| 1 | denominated_pool (pool_commitment) | 3 | 128 | 2048 | 11 | 27 | 4 | 120 665 B |
| 2 | balance_proof | 4 | 128 | 2048 | 11 | 27 | 7 | 121 113 B |
| 3 | merkle_path | 6 | 512 | 8192 | 13 | 22 | 11 | 138 293 B |
| 4 | confidential_balance | 4 | 256 | 4096 | 12 | 27 | 10 | 144 041 B |
| 5 | transfer | 7 | 512 | 8192 | 13 | 22 | 28 | 138 661 B |
| 6 | merkle_update | 10 | 512 | 8192 | 13 | 22 | 19 | 139 765 B |

Correction supplémentaire trouvée dans le code lui-même: `lib.rs:229` dit "10-23 contraintes selon le circuit", et le test dit "C5, width=6, 23 contraintes". Les deux sont faux. C5 fait **28 contraintes et une largeur de 7** (la colonne d'accumulateur de conservation de valeur a été ajoutée). Les tableaux RLC du vérificateur le confirment: `[Felt::ZERO; 28]`.

Ce que chaque circuit prouve:

- **C0**: Poseidon(secret) == commitment.
- **C1**: nullifier = Poseidon(np, secret), epoch_hash = Poseidon(epoch, mint), commitment = Poseidon(nullifier, epoch_hash).
- **C2**: chaîne de 4 Poseidon pour un commitment de balance. **Le range check n'est PAS dans l'AIR**, il est fait on-chain.
- **C3**: inclusion Merkle par Poseidon hash2 par niveau, profondeur canonique 15.
- **C4**: mise à jour de balance confidentielle, 7 Poseidon chaînés. **Conservation appliquée on-chain, pas dans l'AIR.**
- **C5**: transfert shielded 2-in-2-out, 14 Poseidon chaînés + colonne d'accumulateur de conservation.
- **C6**: remplacement de feuille old_root → new_root.

### 2.3 Compute units: ce qu'on peut réellement affirmer

Il n'y a **aucune mesure de CU committée** dans le dépôt. Les seules assertions sont `expect(cu).to.be.lessThan(1_400_000)` sur les deux phases de C5, avec les valeurs réelles imprimées à l'exécution et jamais enregistrées. Tout chiffre du type "1,1M CU" ou "1,32M/1,4M pour C6" vient d'une note de mémoire, pas du code.

Ce qui existe comme estimations de conception dans les commentaires: sol_sha256 ~85 CU/appel; multiplication Goldilocks sur BPF ~216 CU; DEEP-ALI phase 2 ~40K CU (C0), ~110K CU (C1); évaluation de colonnes périodiques C5 ~160K CU avec l'optimisation stride-16 contre ~1,4M en Horner naïf; le lookup inv_gen à deux niveaux économise ~342K CU net sur C6.

Ce qui est solidement démontrable en revanche: deux signatures devnet sont citées **dans le code** comme ayant consommé le budget complet de 1,4M à l'étape 4, ce qui a forcé le découpage en deux phases.

Formulation sûre devant un public technique: "les deux phases passent sous le plafond de 1,4M, c'est asserté en test; le chiffre exact n'est pas figé dans le dépôt et je ne vais pas l'inventer".

**Nomenclature à corriger.** Le dépôt appelle partout 1,4M le "plafond par instruction". Sur Solana, 1 400 000 est `MAX_COMPUTE_UNIT_LIMIT`, un plafond **par transaction**. Le découpage en deux phases marche parce qu'il met les deux appels lourds dans **deux transactions séparées**, et c'est exactement ce que fait le code mobile.

### 2.4 Le pool

- Seed PDA: **`denominated_pool_v4`**. Profondeur d'arbre **15** (2^15 = 32 768 notes par pool), qui doit égaler `CANONICAL_DEPTH` du circuit C6. `max_historical_roots` = **100**.
- Dénominations SOL: 0.1, 1, 10, 100, 500, 1000. USDC: 1, 10, 100, 1000, 10k, 20k, 50k.
- `commitment = Poseidon(nullifier, epoch_hash)`, `nullifier = Poseidon(nullifier_preimage, secret)`, `epoch_hash = Poseidon(deposit_epoch, token_mint)`.
- Le hash de l'arbre de notes est **Poseidon sur Goldilocks, t=3, 30 rounds pleins, S-box x^7, MDS circulante [[3,1,1],[1,3,1],[1,1,3]]** — différent du SHA-256 utilisé pour les commitments Merkle de la preuve elle-même. Cette distinction est correcte et voulue.
- Vérificateur déployé: `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`.

### 2.5 Specter — et la correction de pitch la plus importante

**"Aucune courbe elliptique dans la découverte du destinataire" est faux.** Il faut retirer cette phrase avant le pitch.

Une multiplication scalaire X25519 s'exécute des **deux côtés de chaque opération de découverte**:

```ts
export function deriveSharedSecret(privateKey, publicKey) {
  return nacl.scalarMult(privateKey, publicKey);   // X25519
}
```
— `utils/crypto.ts:41-46`, appelée en `derive.ts:49-52` (émetteur), `derive.ts:142` (claim destinataire), `derive.ts:195`, `scan.ts:124`.

Ce qui est vrai, et défendable, c'est que le combineur est **OR-sûr**:

```ts
combined = classicSecret || kemSecret;
transcriptHash = sha256(ephemeralPubKey || kemCiphertext);
info = HYBRID_HKDF_INFO || transcriptHash;
return hkdf(sha256, combined, undefined, info, 32);
```
— `utils/crypto.ts:150-171`, avec le commentaire "Security holds if EITHER the classical or post-quantum scheme is secure."

Donc la confidentialité de la découverte **survit à une casse totale de X25519**.

Formulation honnête à substituer, en style pitch:

> La découverte du destinataire est résistante au quantique. Le secret partagé ne peut pas être reconstitué sans la clé secrète ML-KEM-768, même par un adversaire qui casse X25519.

Protocole exact, côté émetteur:

```
r         = keypair X25519 éphémère
s_c       = X25519(r, V)
(ct, s_q) = ML-KEM-768.Encaps(K)
s         = HKDF-SHA256(ikm = s_c||s_q, info = "p01-hybrid-stealth-v2" || SHA256(R||ct), L=32)
viewTag   = SHA256(s)[0]
seed      = HKDF-SHA256(ikm = s, salt = spendingPubKey, info = "p01-stealth-seed", L=32)
stealth   = Ed25519_keygen_from_seed(seed)
```

Détail qui te distingue de ERC-5564 et de Monero: **il n'y a aucune addition de points de courbe dans la dérivation**. L'adresse furtive est une clé Ed25519 fraîche issue d'un seed HKDF; la clé de dépense publique du destinataire ne sert que de sel HKDF. Conséquence à assumer: la clé de dépense n'est pas requise pour dépenser — clé de vue + secret KEM suffisent à reconstruire la clé privée.

Tailles et primitives: ML-KEM-768 de `@noble/post-quantum` ^0.6.1, pk 1184 B, sk 2400 B, ciphertext 1088 B, secret partagé 32 B. Meta-adresse v2: 1249 octets bruts en base58, environ 1700 caractères — contrainte UX réelle, pas de forme courte dans le code.

Transport on-chain: PDA `StealthAccountV2`, seeds `["stealth_v2", sender, stealthAddress]`, 1220 octets. `KEM_CHUNK_SIZE = 544`, donc 1088 = exactement **2 chunks**. Un envoi complet = **3 transactions**. Programme `FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL`.

SDK publié sur npm public: `@protocol-01/specter-sdk@0.4.1`, publié le 17 juillet 2026 à 12:17 UTC, soit 3 minutes après le commit du transport chunké — le nouveau transport est bien dans l'artefact publié.

### 2.6 Faiblesses de Specter à connaître avant qu'on te les trouve

Les dire avant qu'on te les demande, c'est ce qui crédibilise le plus. Le brief a raison sur le principe; voici la liste réelle côté Specter.

- **Le view tag ne filtre rien.** `checkViewTag` calcule le tag depuis le secret **hybride**, donc il exécute une décapsulation ML-KEM-768 complète plus un scalarmult X25519 **avant** de pouvoir rejeter. Le commentaire on-chain qui dit que le tag "évite la décapsulation coûteuse" contredit l'implémentation cliente.
- **Le travail est fait deux fois.** Après le passage du view tag, `verifyStealthOwnership` refait à l'identique le scalarmult, la décapsulation et le HKDF. Rien n'est mémoïsé.
- **La bande passante de scan n'est pas bornée.** `fetchAnnouncements` ignore complètement son intervalle de slots (les paramètres s'appellent `_fromSlot`, `_toSlot`) et `getProgramAccounts` télécharge **toutes** les annonces de 1220 octets jamais créées, puis tronque côté client. Pas de `dataSlice`, pas de pagination.
- **Pas de flag de complétude sur le PDA.** `init_stealth_v2` remplit le ciphertext de zéros et rien n'impose que les deux chunks soient écrits. Un PDA à moitié écrit est indistinguable pour le scanner.
- **Les 3 transactions ne sont pas atomiques.** tx1 crée le PDA **et** transfère les fonds, avant l'écriture des chunks. Si un chunk échoue, l'argent est à une adresse furtive dont le ciphertext est incomplet, donc introuvable par le destinataire.
- **L'émetteur est identifiable.** Le PDA est dérivé de la vraie pubkey de l'émetteur, donc chaque annonce lui est publiquement attribuable, indépendamment du signataire de la transaction.
- **L'adresse furtive elle-même est Ed25519**, donc dépensable par une signature classique. La découverte est PQ, la dépense ne l'est pas. Le SDK le documente honnêtement et livre un module WOTS+, mais le vérificateur on-chain qui imposerait la seconde signature n'existe pas.
- **`announcement-v2.ts` a zéro test** et n'est pas exporté de l'API publique.
- Le chemin SPL-token est mort en v2: `sendSingleTransfer` lève dès qu'un `tokenMint` est fourni. Toute la couche PQ est **native-SOL uniquement** aujourd'hui.
- Le `constants.ts` annonce un program id mainnet-beta qui n'est pas le `declare_id` du programme actuel.

---

## 3. Le diff, axe par axe

### 3.1 Système de preuve et corps

| | STRK20 | Protocol 01 |
|---|---|---|
| Système | Stwo, Circle STARK | Winterfell 0.10.3 comme lib de corps + protocole compact écrit main |
| Corps | M31, p = 2^31 − 1, tour CM31/QM31 | Goldilocks, p = 2^64 − 2^32 + 1, **pas d'extension** |
| Astuce structurelle | courbe circulaire x²+y²=1, ordre p+1 = 2^31 | sous-groupe lisse natif de Goldilocks |
| Hash de commitment | Blake2s-256 (défaut), Poseidon252 (option L1) | SHA-256 (contrainte de syscall Solana) |
| Merkle | "lifté" (nœud = enfants + colonnes injectées) | standard |
| Blowup | 2 | 16 |
| Requêtes | 70 | 27 ou 22 |
| Grinding | 26 bits + PoW d'interaction | 16 bits |
| Soundness annoncée | 96 bits **conjecturés** | 124 / 104 bits, classique, formule naïve |
| Point OOD | QM31 (extension quartique) | **corps de base ~2^64** |
| Trusted setup | aucun | aucun |
| ZK | **pas ZK par défaut** | pas de masquage ZK non plus |

Deux points d'honnêteté qui vont dans les deux sens. Eux ont un blowup de 2 avec 70 requêtes, ce qui n'atteint 96 bits que sous l'hypothèse conjecturale de list-decoding. Toi tu as un blowup de 16, plus conservateur par requête, mais tu échantillonnes le point OOD dans le corps de base au lieu d'une extension, ce qui plafonne le terme Schwartz-Zippel bien plus bas que ta figure annoncée. **Aucun des deux ne devrait clamer un chiffre nu sans dire quel régime.**

### 3.2 Modèle d'écriture des contraintes

C'est la différence structurante, celle qui explique tout le reste.

**Eux: une AIR de CPU fixe.** Le programme est de la donnée. Zéro AIR par application, zéro DSL de circuit, zéro vérificateur déployé par application. Écrire une nouvelle fonctionnalité privacy = écrire du Cairo.

**Toi: une AIR par circuit, écrite à la main.** Et le brief sous-estime le coût. Changer **une** contrainte de transition sur le circuit N exige d'éditer **quatre** sites de code écrits à la main plus une table générée:

1. l'AIR — `evaluate_<circuit>_transition` dans `stark/src/air/<circuit>.rs`, plus la liste `TransitionConstraintDegree` et les colonnes périodiques;
2. le quotient côté prover — `compute_quotient_lde_circuit_N` dans `stark/src/compact.rs`;
3. l'évaluateur OOD du vérificateur — `evaluate_transition_at_ood_circuit_N` dans `verify.rs`;
4. **la re-vérification par requête du vérificateur** — `verify_constraints_<circuit>` dans `verify.rs`, qui ré-évalue indépendamment la même logique sur les positions alignées, et qui est une copie manuelle séparée;
5. les coefficients périodiques précalculés `CN_*_COEFFS` dans `periodic_consts.rs` si les colonnes périodiques bougent.

Une contrainte de **boundary** ajoute encore deux sites miroir (`boundary_assertions_for_circuit` côté prover, `get_boundary_assertions` côté vérificateur), **sans aucun test de cohérence croisée** entre les deux.

Le seul garde-fou automatisé qui existe est sur les constantes périodiques: sept tests `circuit_N_periodic_coeffs_match_verifier_constants` rejouent l'`inverse_ntt` du prover et comparent aux tables de `periodic_consts.rs` (666 KB de u64 générés).

Formulation juste devant un ingénieur StarkWare: "chez moi une contrainte vit dans quatre implémentations manuelles synchronisées, dont deux ne sont couvertes par aucun test de parité. C'est ma dette principale, et c'est exactement ce que le modèle Cairo supprime."

### 3.3 Où la preuve est vérifiée, et à quel coût

| | STRK20 | Protocol 01 |
|---|---|---|
| Vérificateur | S-two en **Rust dans le gateway/séquenceur** | programme Solana on-chain |
| Plafond de calcul | aucun; contrainte **économique** (125 L2gas/octet de propagation + 5 de stockage, + 10M de buffer) | **1,4M CU par transaction**, dur |
| Découpage | aucun | **deux transactions** (phase 1 puis DEEP-ALI phase 2) |
| Sécurité héritée | **dégradée**: phase 1 vérifiée par le consensus, pas par le SNOS, donc pas de sécurité rollup complète | sécurité Solana pleine, vérifié par tous les validateurs |
| Contrat | lit seulement `proof_facts` via syscall | parse la preuve entière |

C'est le point où l'échange est le plus intéressant et où tu n'es pas en position de faiblesse. Eux n'ont pas de plafond de calcul **parce qu'ils ont sorti la vérification de la couche contrat**, et StarkWare écrit noir sur blanc que ça dégrade la sécurité en phase 1. Toi tu paies 1,4M CU **parce que ta preuve est vérifiée par la chaîne elle-même**, sans confiance additionnelle.

À dire tel quel si on te compare:

> Chez eux la preuve est vérifiée par le séquenceur, pas par le contrat, et ils documentent que la sécurité est dégradée en phase 1 en attendant la récursion dans le SNOS. Chez moi elle est vérifiée on-chain par tous les validateurs, et je paie ça en compute units. Ce sont deux positions différentes sur le même arbitrage, pas une supériorité.

Note utile: la vérification dans un contrat Cairo a bien été tentée (Integrity, de Herodotus, déployé sur Starknet) et a dû être découpée en plusieurs contrats et plusieurs transactions à cause des limites de taille de classhash, de calldata et de pas Cairo (3M pas par transaction). SNIP-36 existe précisément parce que ça ne passait pas: "Including the full proof (often tens of thousands of felts) in calldata exceeds the present transaction limit (5K felts)."

Autrement dit: **ils ont rencontré exactement ton problème, et l'ont résolu en changeant le protocole de la L2 plutôt qu'en optimisant le vérificateur.** Cette option ne t'est pas offerte sur Solana. C'est un très bon angle de conversation entre pairs.

### 3.4 Transport de la preuve

| | STRK20 | Protocol 01 |
|---|---|---|
| Taille | non publiée pour STRK20; S-two en général 808 KB à 1315 KB; modèle de prix SNIP-36 basé sur 500 KB | 80 KB à 144 KB, **paddée à 145 000 B uniformes** |
| Chemin | champs `proof` / `proof_facts` d'Invoke V3, hors calldata | **145 tx de chunk de 1000 B** dans un PDA, après **14 tx de resize** de 10 240 B |
| Persistance | pas dans les blocs, pas au feeder gateway, gardée quelques semaines | PDA, rent immobilisé, fermé après usage |
| Rent | aucun | ~0,87 SOL de float transitoire |

Ta preuve est **5 à 10 fois plus petite que la leur**. C'est un point que le brief n'exploite pas et qui est réel: le corps Goldilocks avec blowup 16 et 22-27 requêtes produit une preuve nettement plus compacte que M31 avec blowup 2 et 70 requêtes. Leur coût de transport est absorbé par le protocole, le tien par 159 transactions.

`UNIFORM_PROOF_SIZE = 145 000` est défini **côté client** dans le service STARK mobile, pas en Rust, et sert à fermer deux fuites: L14 (fingerprint par taille de preuve) et, couplé au PDA à nonce d'`init_proof_buffer_v2`, L13 (circuit_id). Marge réelle au-dessus de C4 (144 041 B): **959 octets**. C'est tendu et il faut le savoir.

### 3.5 Modèle de note

| | STRK20 | Protocol 01 |
|---|---|---|
| Structure | `{ packed_value: felt252, token: ContractAddress }` | commitment Poseidon |
| Identité | **adresse de stockage** `Poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` | **feuille dans un arbre de Merkle** |
| Montant | masqué par hash-and-add, salt 120 bits | **la dénomination du pool** (pas une entrée de circuit) |
| Anonymat | pseudo-aléatoire des slots de stockage | ensemble d'anonymat de l'arbre |
| Multi-actifs | un pool pour tous les ERC-20 | **un pool par (token, dénomination)** — 6 SOL + 7 USDC |
| Conservation | registre de balance temporaire on-chain par tx | dénomination + accumulateur C5 |

Ce contraste est le cœur de la conversation technique. Tes pools dénommés sont sûrs par construction sur la valeur, mais fragmentent l'ensemble d'anonymat en 13 pools. Eux ont un ensemble unifié mais **remplacent l'anonymat d'ensemble par du pseudo-aléatoire d'adresse**, ce qui est une hypothèse de sécurité différente: la confidentialité tient tant que le `channel_key` reste secret, et la clé de vue qui le régénère est chiffrée on-chain avec de l'ECDH sur courbe.

C'est exactement là que ton argument PQ mord, et c'est plus fort que sur un modèle à Merkle: chez eux, **casser la courbe ne révèle pas seulement qui a reçu, ça révèle où sont les notes**, parce que l'adressage lui-même dérive du secret.

### 3.6 Accumulateur

Eux: aucun. Toi: arbre de Merkle Poseidon-Goldilocks de profondeur 15 (32 768 notes par pool), 100 racines historiques, maintien des sous-arbres on-chain via C6.

Leur équivalent fonctionnel de ta fenêtre de racines historiques est la **fenêtre de validité de preuve** (450 blocs, ~15 min) ancrée à un bloc de base, plus la maturation de 10 blocs. Ce n'est pas le même mécanisme: le tien résout la concurrence sur l'état de l'arbre, le leur résout la fraîcheur de l'exécution virtuelle.

### 3.7 Nullifiers

| | STRK20 | Protocol 01 |
|---|---|---|
| Formule | `Poseidon(NULLIFIER_TAG, channel_key, token, index, 0, owner_private_key)` | `Poseidon(nullifier_preimage, secret)` |
| Stockage | `Map<felt252, bool>` WriteOnce | PDA |
| Propriété notable | l'**émetteur ne peut pas** le calculer, donc ne peut pas surveiller la dépense | — |

Leur asymétrie émetteur/destinataire est une propriété que tu n'as pas et qui est élégante. À noter comme un point où ils sont devant.

### 3.8 Découverte du destinataire — l'axe central

| | STRK20 | Protocol 01 (Specter) |
|---|---|---|
| Mécanisme | seau par destinataire, indexé par **adresse Starknet en clair** | **adresse furtive** dérivée, annonce publique |
| Pré-requis | destinataire **enregistré** on-chain avec clé de vue publique | aucun — le destinataire n'a rien à faire avant |
| Coût de scan | proportionnel à **ta propre activité** | proportionnel au **volume total du pool** |
| Filtre rapide | pas nécessaire (seau déjà filtré) | view tag 1 octet — **mais il ne filtre rien**, voir 2.6 |
| Crypto | ECDH courbe STARK + Poseidon | **hybride X25519 + ML-KEM-768**, OR-sûr |
| Résistance quantique | non | **oui pour la découverte**, non pour la dépense |
| Fuite | adresse du destinataire visible à l'ouverture de canal | émetteur identifiable via les seeds du PDA |
| Ciphertext | felt252 dans le stockage | 1088 B en 2 chunks dans un PDA |

Lecture honnête: **ils gagnent sur la scalabilité du scan, tu gagnes sur la résistance quantique et sur le fait qu'un destinataire non enregistré peut recevoir.**

Leur modèle a un défaut structurel que le tien n'a pas: il faut connaître et publier l'adresse du destinataire, et l'ouverture de canal la révèle. Le tien a un défaut qu'ils n'ont pas: tu télécharges tout le pool à chaque scan.

Le vrai insight du croisement: **ton architecture d'adresse furtive résout leur problème de liaison à l'ouverture de canal, et leur architecture de seau résout ton problème de coût de scan.** C'est la conversation la plus intéressante que tu puisses avoir aujourd'hui, et elle est bidirectionnelle, pas vendeuse.

### 3.9 Chiffrement des notes

| | STRK20 | Protocol 01 |
|---|---|---|
| Schéma | ECDH courbe STARK, KDF Poseidon, masque additif | X25519 + ML-KEM-768, HKDF-SHA256 |
| Extensible | **non** — figé dans le contrat, aucun champ de version | oui côté SDK |
| Versionnage | suffixe `:V1` dans 17 tags Poseidon | version explicite dans le format d'annonce (1 octet) |
| Migration | non documentée; clés de vue immuables (WriteOnce) | v1 rejeté par défaut, opt-in pour scan historique |

La réponse à la Q2 du brief est donc: **non, ce n'est pas extensible**. Il n'y a pas de point d'extension SDK; le schéma est dans le contrat de pool, et le changer exige un upgrade via `ReplaceabilityComponent`. Et comme les clés de vue sont WriteOnce et immuables, la question de migration est ouverte et non documentée — c'est une vraie question à poser, pas une question rhétorique.

### 3.10 Viewing keys et compliance

| | STRK20 | Protocol 01 |
|---|---|---|
| Existence | **native**, obligatoire pour utiliser le pool | aucune |
| Chiffrement de la clé | **ECDH éphémère sur courbe STARK + masque Poseidon**, on-chain, immuable | — |
| Auditeur | **une seule** clé publique en stockage; "seuil" annoncé en doc, pas dans le contrat | — |
| Portée de divulgation | historique **bidirectionnel complet**, traçage avant et arrière | — |
| Screening de dépôt | **on-chain**, signature SNIP-12 obligatoire, non contournable | aucun |
| Identité de l'auditeur | **non publiée** | — |

C'est l'axe où l'écart est maximal, dans les deux sens. Ils ont une couche compliance complète, formellement vérifiée en Lean, auditée par OpenZeppelin. Tu n'as rien. Le brief a raison de le compter comme un gain structurel.

Mais c'est aussi leur surface la plus exposée au harvest-now-decrypt-later, et de très loin. Voir section 4.

### 3.11 Modèle de compte

| | STRK20 | Protocol 01 |
|---|---|---|
| Base | **abstraction de compte native**; `is_valid_signature` réutilisé pour l'autorisation de dépense | Ed25519 / PDA Solana |
| Bénéfice | multisig, hardware, smart accounts marchent sans changement de protocole | — |
| Coût | le compte destinataire doit être **déployé et finalisé ~10 blocs** avant de pouvoir s'enregistrer | — |
| Adresse dérivée | **ne peut pas recevoir** en privé sans enregistrement préalable | adresse furtive reçoit directement |
| Chemin PQ | **AA permet déjà un signer PQ** — Falcon-512 démontré par S2morrow à ~9,5M L2 gas | WOTS+ côté client, **vérificateur on-chain absent** |

Réponse à la Q5 du brief, la priorité absolue: **non, tu ne peux pas transférer vers une adresse dérivée à la volée.** Et pire que prévu: même un compte déployé doit attendre la finalisation puis l'enregistrement, parce que le prover lit le slot de clé de vue au bloc de base.

Point d'honnêteté sur le PQ des signatures: leur AA rend un wallet Falcon-512 déployable **aujourd'hui**, sans changement de protocole, et une implémentation tierce existe et tourne sur mainnet. Toi tu as un module WOTS+ client sans vérificateur on-chain. **Sur l'axe signature PQ, ils sont devant toi.** Le brief a raison de dire "on ne se disperse pas sur les signatures", mais la raison n'est pas que ce soit hors sujet: c'est qu'ils ont déjà une meilleure réponse que la tienne.

### 3.12 Composabilité et maturité

| | STRK20 | Protocol 01 |
|---|---|---|
| DeFi | swaps privés AVNU + Ekubo **live**; contrats anonymizer via `privacy_invoke` | à construire |
| Wallets | Ready live, Xverse en cours | app mobile maison |
| Statut | **mainnet** depuis avril-mai 2026 | **devnet uniquement** |
| Audit | OpenZeppelin + ~60 fichiers de preuves Lean 4 | audit de soundness interne |
| Frais | fixe, 4 STRK par tx privée | frais Solana + rent |
| Open source | Apache 2.0 depuis le 8 juillet 2026 | SDK npm public, monorepo privé |

Ne pas survendre. Devnet, pas mainnet, dit en premier.

---

## 4. Le trou PQ, précisément où

### 4.1 La formulation exacte à utiliser

Le brief dit déjà de ne pas dire "STRK20 n'est pas post-quantique". La vérification adversariale a trouvé qu'une deuxième formulation est également fausse et te ferait corriger sur place: **ne dis pas non plus "la confidentialité est hors périmètre"**. C'est faux au niveau de l'entreprise — STRK20 *est* leur produit de confidentialité, livré deux mois avant la roadmap.

Formulation vérifiée, à utiliser telle quelle:

> La roadmap post-quantique de StarkWare du 30 juin couvre le hachage et les commitments: Pedersen remplacé par BLAKE2 sur le state commitment, la dérivation d'adresse de contrat et le hash de config de l'OS, plus la migration des contrats existants et les dépendances Ethereum. Elle ne dit pas comment la couche de chiffrement qu'ils ont déjà livrée dans STRK20 sera migrée: les balances chiffrées, et la clé de vue chiffrée on-chain qu'un auditeur désigné peut déchiffrer. C'est une asymétrie qui mérite une question, pas une accusation. Le système de preuve est basé sur des hashes et tient. La couche de confidentialité a été livrée deux mois avant la roadmap et n'y figure pas.

Ce qui est établi sur la roadmap:

- Phase 1, trois items, tous des migrations de hash: state commitment Pedersen→BLAKE2, dérivation d'adresse de contrat, hash de config OS. Config OS live en testnet à la publication, mainnet début juillet; le reste ~2 mois.
- Phase 2: outillage de migration du stockage des contrats existants, ~1 mois après.
- Phase 3: dépendances Ethereum uniquement (syscalls secp256k1/r1, blobs EIP-4844 ancrés par KZG), bloquées sur la migration d'Ethereum.
- **Falcon-512 n'est cité que pour les signatures de consensus, et seulement comme exemple non contraignant** ("such as Falcon-512"). Ce n'est pas un engagement sur le schéma de signature des comptes.
- Aucun SNIP n'existe pour Falcon-512 ni pour les signatures PQ de compte. **Vérifié de façon adversariale et confirmé**: listing du répertoire reproduit à l'identique, titres des candidats plausibles vérifiés en raw, PRs et forum balayés. SNIP-6 reste la norme d'interface de compte, agnostique du schéma, et son statut est "Review", pas "Final".
- Les comptes sont couverts indirectement: "Starknet users can deploy a PQ wallet today", sans changement de protocole.

Nuance méthodologique à assumer si on te pousse: la vérification "ces termes n'apparaissent pas" a été faite via un outil qui résume, pas via un grep brut. **Ouvre la page et fais Ctrl-F toi-même avant de t'appuyer dessus en public.** C'est l'étape de vérification manuelle la plus rentable de la journée.

### 4.2 Les deux cibles concrètes

Maintenant qu'on a le code, le trou n'est plus une abstraction. Il y a exactement deux structures qui sont du chiffrement sur courbe, publiées on-chain, permanentes.

**Cible A — la séquestre de clé de vue (`EncPrivateKey`).**

```
enc_private_key = h(ENC_PRIVATE_KEY_TAG, rK.x) + private_key
```

Stockée dans `enc_private_key: Map<ContractAddress, EncPrivateKey>`, immuable (WriteOnce), émise avec un événement public `ViewingKeySet`.

Pourquoi c'est la cible la plus forte:

- ça ne protège pas une transaction, ça protège **l'historique bidirectionnel entier** d'un utilisateur;
- c'est permanent et immuable par conception, donc l'exposition ne décroît jamais;
- une seule clé d'auditeur compromise ou cassée expose **tous les utilisateurs à la fois**;
- et casser la courbe STARK dans dix ans désanonymise rétroactivement tout le pool depuis mai 2026.

**Cible B — l'ouverture de canal (`EncChannelInfo`).**

```
enc_channel_key = h(CHANNEL_KEY_TAG, rK.x) + channel_key
enc_sender_addr = h(SENDER_ADDR_TAG, rK.x) + sender_addr
```

Pourquoi c'est structurellement pire chez eux que dans un pool à Merkle: le `channel_key` ne chiffre pas seulement le contenu, il **dérive l'adresse de stockage des notes**. Récupérer un `channel_key` ne révèle pas seulement un montant, ça révèle **où sont toutes les notes de ce canal**, puisque `note_id = Poseidon(NOTE_ID_TAG, channel_key, token, index, 0)` est calculable dès qu'on a la clé.

C'est l'argument le plus fort du document. À dire en style pitch:

> Chez eux, l'adressage des notes dérive du secret de canal. Casser la courbe ne révèle pas seulement qui a reçu combien, ça révèle où toutes les notes sont stockées. La confidentialité et l'adressage reposent sur la même clé, et cette clé est chiffrée on-chain avec de l'ECDH sur courbe elliptique, pour toujours.

### 4.3 Ce qui les protège déjà, à reconnaître

- Le système de preuve Stwo est basé sur des hashes et survit à Shor. À dire en premier.
- Blake2s est déjà partiellement déployé, indépendamment de la roadmap (hachage de déclaration de contrat depuis Starknet ≥ 0.14.1).
- L'AA permet un signer PQ dès aujourd'hui, sans changement de protocole.
- Un chiffrement additif dans un corps premier n'a pas de structure exploitable par Shor **en lui-même**; la vulnérabilité est entièrement dans l'ECDH qui produit `rK.x`. C'est précisément le composant qu'un KEM remplace, et rien d'autre n'a besoin de bouger. C'est un excellent argument: **le changement est chirurgical.**

---

## 5. Point de branchement Specter — révisé

### 5.1 Ce qui tombe

L'architecture cible de la roadmap (émetteur dérive une adresse furtive, STRK20 transfère dessus) ne peut pas être implémentée. Le destinataire doit être un compte Starknet déployé **et** enregistré. Il n'y a pas d'adresse furtive dans leur modèle.

Ne pas essayer de la forcer. Ne pas proposer de reconstruire un système de notes non plus — le piège n°4 du brief tient toujours.

### 5.2 Ce qui devient le projet

Le branchement propre, et qui devient plus fort que le plan initial:

**Remplacer l'ECDH sur courbe STARK par un KEM hybride dans les deux structures chiffrées de STRK20, sans toucher au reste du protocole.**

Ce qui rend ça défendable en 12 heures:

- Le périmètre est **exactement deux fonctions**: `_compute_shared_x` produit `rK.x`, et tout le reste du système consomme un `felt252` de matière clé. Si `rK.x` est remplacé par un secret issu d'une décapsulation ML-KEM, réduit dans le corps, **rien d'autre ne change**: ni la structure des notes, ni les nullifiers, ni la discovery, ni les phases.
- Le combineur OR-sûr de Specter existe déjà et est testé: `HKDF(classic || pq, info = transcript)`. Il se transpose directement, en substituant Poseidon à SHA-256 pour rester dans leur domaine de hash.
- L'argument "on ne fait pas de mixer maison, on se branche au-dessus" devient littéralement vrai au niveau de la ligne de code.

Ce qu'il faut construire, minimal:

1. Un contrat Cairo qui **stocke** les ciphertexts ML-KEM-768 associés à une adresse — et note bien: **en stockage, pas en events**, pour rester dans leur pattern. Ils ne mettent aucun payload chiffré dans les events; toute la discovery lit du stockage. Un `pq_announcer` qui émet des events divergerait de leur architecture et se ferait remarquer.
2. Le packing felt252: 1088 octets à 31 octets par felt = **36 felts**. En stockage plutôt qu'en events, ce qui évite le coût de 5 120 L2gas par felt de données d'event (184 320 L2 gas pour 36 felts, soit 4,6 L1-gas-équivalent — pas prohibitif mais inutile).
3. L'adapteur TS qui parle à ce contrat via starknet.js, réutilisant `quantum/` de specter-sdk qui est **déjà 100% agnostique de chaîne** (zéro import Solana sur les 4 fichiers).

### 5.3 Effort de portage, mesuré

Compté fichier par fichier sur le dépôt:

| Module | Imports web3 | Refs PublicKey | Refs Connection | Verdict |
|---|---|---|---|---|
| `quantum/*` (4 fichiers) | 0 | 0 | 0 | **déjà portable** |
| `stealth/index.ts` | 0 | 0 | 0 | déjà portable |
| `stealth/quantum.ts` | 1 | 5 | 0 | ~5 lignes |
| `stealth/derive.ts` | 1 | 6 | 0 | cosmétique |
| `stealth/generate.ts` | 1 | 8 | 0 | cosmétique |
| `stealth/scan.ts` | 1 | 12 | 6 | **à remplacer par un adapteur** |
| `stealth/announcement-v2.ts` | 1 | 20 | 2 | **à remplacer par un adapteur** |

C'est une bonne nouvelle par rapport à l'estimation de la roadmap (117 références réparties sur 8 fichiers, 3-5h de refactor). La réalité: `PublicKey` est un wrapper de 32 octets et `Keypair` ne sert qu'à `.publicKey.toBytes()`. Le vrai travail est concentré sur **deux fichiers**, et ce sont précisément les deux qui doivent être réécrits de toute façon pour Starknet.

Et surtout, pour la cible retenue (remplacer l'ECDH dans le chiffrement STRK20), tu n'as même pas besoin de `stealth/` — tu as besoin de `quantum/` et de `kemEncapsulate`/`kemDecapsulate`/`deriveHybridSharedSecret` de `utils/crypto.ts`, qui n'ont aucune dépendance chaîne.

### 5.4 Règle de coupe révisée

MVP défendable: **un handshake ML-KEM-768 dont le secret partagé est réduit dans le corps STARK, utilisé pour masquer un `channel_key` selon leur formule exacte `h(TAG, secret) + value`, avec le ciphertext stocké dans un contrat Cairo sur Sepolia, et une démonstration que l'émetteur et le destinataire dérivent le même `channel_key`.**

Ça prouve la substituabilité au niveau exact où elle compte, sans dépendre du proving service, sans dépendre du screening de dépôt, sans dépendre de l'accès au pool. Ce sont les trois choses qui peuvent te bloquer et aucune n'est sous ton contrôle.

Le stretch, si le SDK et le proving service sont disponibles: faire un vrai transfert STRK20 entre deux comptes enregistrés, et montrer côte à côte le canal ouvert avec leur ECDH et le même canal ouvert avec le KEM.

Ne jamais sacrifier la vidéo de secours de 17h30.

---

## 6. Questions révisées à poser

Les questions du brief restent bonnes. Voici ce qui change maintenant qu'on a le code.

### Devenues inutiles (déjà répondues par le code)

- Q1 "comment l'émetteur adresse le destinataire" → seau par adresse en clair, pas de tag, scan de son propre seau. **Répondu.**
- Q2 "le chiffrement est-il extensible" → non, figé dans le contrat, aucun champ de version. **Répondu.** À reformuler en question de migration (ci-dessous).
- Q3 "avec quel schéma les viewing keys sont chiffrées" → ECDH éphémère courbe STARK + masque Poseidon, on-chain, immuable. **Répondu.** Garde-la quand même, mais pose-la en affirmant, pas en demandant: ça montre que tu as lu leur code.
- Q5 "puis-je transférer vers une adresse dérivée" → non, destinataire enregistré obligatoire. **Répondu.**
- Q6 "SDK gated ou public" → open source Apache 2.0. **Répondu.** Reformuler (ci-dessous).
- Q8 "coût/limite des events Cairo" → 5 120 L2gas/felt de données, 10 240/felt de clé. Mais STRK20 n'utilise pas d'events pour les payloads, donc la question perd son intérêt.

### Les vraies questions bloquantes, à poser dans la première heure

1. **URL du proving service Sepolia.** Aucune valeur publique nulle part; tous les exemples utilisent `process.env.PROVING_SERVICE_URL` sans défaut, et la demo tombe sur un mock si non défini. Y a-t-il un endpoint hébergé par StarkWare pour Sepolia? Credentials? Rate limits?
2. **URL de l'indexer de discovery.** Même problème (`process.env.INDEXER_URL`). Endpoint hébergé, ou faut-il faire tourner le container `discovery-service`?
3. **Adresse du pool sur Sepolia.** Le mainnet est publié (`0x0403…812a`), Sepolia est confirmé supporté mais l'adresse n'est publiée nulle part — elle est résolue par le wallet à l'exécution.
4. **Accès npm au SDK.** `@starkware-libs/starknet-privacy-sdk` renvoie 404 sur le registre public; c'est sur GitHub Packages. Token nécessaire, ou install git?

### Les questions techniques qui valent le détour

5. **Migration du format chiffré.** Il n'y a aucun champ de version sur `Note` ni sur `EncChannelInfo`, et les clés de vue sont WriteOnce et immuables. Si vous passez le chiffrement en post-quantique, comment migrent les canaux existants et les clés de vue déjà séquestrées? C'est la meilleure question du lot, parce qu'elle est concrète, qu'elle vient du code, et qu'elle n'a pas de réponse documentée.
6. **Qui porte la couche chiffrement dans la roadmap PQ.** La roadmap couvre hashes et commitments. La couche que vous avez livrée en avril-mai n'y est pas. Oubli, séquencement, ou chantier ouvert non publié?
7. **La clé de vue privée en clair vers le proving service.** `proof-invocation-factory.ts` compile `[userAddress, user.viewingKey, cairoActions]` et l'envoie au prover. Quel est le modèle de confiance, y a-t-il une attestation TEE prévue, une politique de rétention? Question posée sans agressivité — c'est un choix d'architecture explicite en phase 1, pas une négligence.
8. **Auditeur à seuil.** Les docs disent que le schéma supporte les clés à seuil; le contrat stocke un seul `felt252`. Est-ce déployé aujourd'hui, avec qui comme porteurs de parts, et quel est le process de requête?
9. **FPI vs Elliptic.** Les docs nomment FPI comme screener, le code appelle l'API d'Elliptic via un proxy GCP. Qui signe, qui fournit la donnée, et qui contrôle `blockOverrideAddresses`?
10. **Le `r` éphémère réutilisable.** L'audit OpenZeppelin note que `random` n'est validé que non nul, sans contrainte d'unicité. Est-ce corrigé dans la classe déployée, ou est-ce assumé côté client?

### Entre pairs

11. **M31 contre Goldilocks.** Toi tu es sur Goldilocks avec blowup 16 et 22-27 requêtes, eux sur M31 avec blowup 2 et 70 requêtes, cible 96 bits conjecturés. Quelles contraintes le choix du corps met-il sur les décompositions en bits et les range checks dans leurs circuits privacy? Tu as un vrai vécu là-dessus: tu as différé les range checks sur `confidential_balance` et `transfer` précisément parce que la décomposition en bits faisait exploser le budget CU.
12. **Circuits sous-contraints en Cairo.** Avec une AIR de CPU fixe, le risque se déplace du circuit vers la logique Cairo. Comment le traitent-ils? Ils ont ~60 fichiers de preuves Lean 4 sur notes, canaux, nullifiers, no-replay, traçage — c'est une réponse partielle et une excellente porte d'entrée. Demande ce que Lean couvre et ce qu'il ne couvre pas.
13. **SNIP-36 phase 2.** La récursion dans le SNOS et le vrai ZK sont différés sans calendrier. Quel est l'horizon, et qu'est-ce qui débloque?

---

## 7. Ce qu'il faut retirer ou reformuler avant de parler

Récapitulatif opérationnel.

| À ne plus dire | À dire |
|---|---|
| "Aucune courbe elliptique dans la découverte du destinataire" | "La découverte est résistante au quantique: le secret ne se reconstitue pas sans la clé ML-KEM-768, même si X25519 tombe" |
| "STRK20 n'est pas post-quantique" | "Le système de preuve tient. La couche de chiffrement livrée en avril n'est pas dans la roadmap PQ de juin" |
| "La confidentialité est hors périmètre de leur roadmap" | "La roadmap est silencieuse sur la migration PQ d'une couche de chiffrement qu'ils ont déjà livrée" |
| "Blake3-256, 32 requêtes, folding 8, pas de grinding, 128 bits" | "SHA-256, 27 ou 22 requêtes, folding 2, grinding 16 bits, 124 ou 104 bits en soundness classique" |
| "1,1M CU sur 1,4M" | "Les deux phases passent sous 1,4M, c'est asserté en test; le chiffre exact n'est pas committé" |
| "Preuve de 60 à 120 KB" | "80 à 144 KB selon le circuit, paddée à 145 000 octets uniformes pour ne pas fuiter le circuit" |
| "Plafond de 1,4M CU par instruction" | "par transaction — c'est pour ça que le split est en deux transactions" |
| "ANSSI recommande ML-KEM plus FrodoKEM" | **Retirer entièrement.** L'hybridation ANSSI est PQ + classique, pas PQ + PQ. ML-KEM et FrodoKEM sont deux alternatives listées séparément, et ANSSI dit explicitement ne pas publier de liste fermée d'algorithmes recommandés |
| "Les régulateurs visent 2030" | Vrai mais à sourcer: ANSSI phase 3 "probablement pas avant 2030"; UE, trois jalons 31/12/2026, 31/12/2030, 31/12/2035 |
| "Le SDK est gated" | "Le SDK est open source Apache 2.0 depuis le 8 juillet. Ce qui est gated, c'est le proving service et l'indexer" |

Sur les signatures PQ, ne pas dire "on ne se disperse pas parce que Falcon est déjà sur leur roadmap". La formulation juste: leur abstraction de compte permet déjà un wallet Falcon-512 déployé sur mainnet par un tiers, à ~9,5M L2 gas. Sur cet axe ils sont devant. Ta valeur est sur le KEM, pas sur la signature — et c'est vrai précisément parce qu'ils ont bien couvert la signature et pas du tout le KEM.

---

## 8. Sources

**STRK20 / Starknet, primaires**
- `github.com/starkware-libs/starknet-privacy` — contrat Cairo, discovery Rust, SDK TS, preuves Lean. Apache 2.0.
- `community.starknet.io/t/snip-36-in-protocol-proof-verification/116123` — SNIP-36, vérification in-protocol.
- `starkware.co/blog/the-architecture-advantage-starknets-quantum-readiness-roadmap/` — roadmap PQ du 30 juin 2026.
- `github.com/starkware-libs/stwo` et `stwo-cairo` — prover Circle STARK.
- `eprint.iacr.org/2024/278` (Circle STARKs), `eprint.iacr.org/2021/1063` (Cairo).
- `docs.starknet.io/learn/protocol/fees`, `docs.starknet.io/learn/S-two-book/`.
- `@starknet-io/types-js@0.10.3` — Wallet API v0.10.3, types.
- `openzeppelin.com/news/privacy-contracts-audit`.
- `strk20-by-example.org` — site communautaire, pas officiel, mais cite le source Cairo verbatim et concorde sur tous les points recoupés.

**Protocol 01, internes**
- `stark/src/compact.rs` (protocole réellement vérifié), `stark/src/prover.rs` (chemin legacy mort), `stark/src/air/*`.
- `programs/p01_stark_verifier/src/{verify.rs, compact_proof.rs, periodic_consts.rs, lib.rs}`.
- `programs/zk_shielded/src/state/{pool_v3.rs, merkle_tree_v3.rs}`.
- `packages/specter-sdk/src/{stealth/*, utils/crypto.ts, wallet/create.ts}`, `programs/specter/src/`.
- `apps/mobile/services/stark/index.ts`, `apps/mobile/services/denominatedPool/index.ts`.

**Réserves de vérification**
- L'absence de termes liés au chiffrement dans la roadmap PQ a été établie via un outil qui résume. À confirmer par Ctrl-F manuel avant usage public.
- Les CU de Protocol 01 ne sont mesurés nulle part dans le dépôt.
- L'affirmation ANSSI ML-KEM+FrodoKEM a été réfutée sur source primaire et doit être retirée.
