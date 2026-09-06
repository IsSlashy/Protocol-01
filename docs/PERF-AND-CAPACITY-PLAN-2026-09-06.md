# Vitesse et capacité, 2026-09-06

Deux problèmes posés par le fondateur le 2026-09-06 :

1. Déposer, dépenser (retrait ou abonnement) prend 6 à 8 minutes. Cible : moins
   d'une minute par étape.
2. Un pool est plein à 32 768 feuilles (profondeur 15). Ensuite plus personne
   ne peut déposer et rien ne bascule sur un autre arbre.

Tout ce qui suit est lu dans le code à `f8119221` ou dans les mesures datées
du dépôt (`docs/BENCHMARK-2026-09-02.md`, `docs/MOBILE_PROVER_LATENCY.md`).
Les estimations sont marquées comme telles.

## 1. Où passent les minutes

**La preuve n'est pas le goulot.** Mesuré le 2026-09-02, blob expédié, Node :
C7 médiane 2,7 s, C6 2,2 s, C1 1,7 s. Sur un téléphone le chiffre n'existe
toujours pas, mais le seul point mesuré (C3, 1,5 s en 2026-08) est plus rapide
que le bureau.

**Ce qui coûte, par ordre :**

| poste | mesure ou arithmétique | source |
|---|---|---|
| Rate limit devnet (429) | retrait v4 630 s ; dépôt + abonnement 775 s | benchmark §4, wall clock |
| Transactions par preuve | 94 tx sur ~311 slots ≈ 2 min de chaîne | benchmark §3, éphémères `He5gifXH`, `GY79Rpua` |
| Confirmations séquentielles | init 1 + resize 7 à 8 + barrière chunks 1 + verify 1 + verify 2 + dépense + close + préfinancement + sweep ≈ 15, à 2 à 3 s chacune ≈ 35 à 45 s | `stark.ts:718-800`, `signSendConfirm` (blockhash `finalized` + confirm `confirmed`) |
| Envoi des chunks | 80 à 83 chunks de 1 000 o, cadencés à 120 ms par `pacedFetch` ≈ 10 s, puis polling à 2,5 s | `stark.ts:48`, `pacedFetch.ts:20`, `confirmSignatures` |
| Scan des feuilles (dépense et abonnement seulement) | 1 `getTransaction` **par signature du pool**, cadencé à 120 ms. Aujourd'hui 154 signatures sur le pool 1 SOL ≈ 20 à 25 s ; à 1 000 signatures ≈ 2 min ; à 32 000 ≈ 1 h | `fetchPoolCommitments`, `denominatedPool.ts:2040-2113` ; comptage devnet du 06-09 |
| Mobile, en plus | ~61 s de `setTimeout` par preuve (vagues de 3 tx / 700 ms, gigue 30 à 120 ms par appel, polling 1,5 s) | `MOBILE_PROVER_LATENCY.md` §2.1 (juillet ; à re-mesurer après la bascule v4) |

Le scan croît avec **toute** l'activité du pool, pas seulement les dépôts : chaque
retrait ajoute des signatures que le prochain scan relit.

**Plancher physique de la conception actuelle**, sans 429 et sans gigue : environ
50 à 60 s par preuve. La cible « moins d'une minute par étape » n'est donc pas
atteignable en réglant des constantes. Il faut supprimer des transactions
séquentielles et supprimer le scan.

## 2. Plan pour passer sous la minute

Quatre leviers, du moins cher au plus structurant. Les trois premiers sont
indépendants du système de preuve : la preuve reste la même, seule la façon de
la poser sur la chaîne change.

### L1. Client seul, zéro redéploiement (gain ≈ ×2, insuffisant seul)

- RPC payé pour la production (Helius). Sur devnet gratuit, le 429 domine tout et
  aucune optimisation ne tient.
- Ne plus cadencer les chunks à 120 ms : les 80 envois partent en parallèle avec
  `skipPreflight`, une seule barrière de confirmation. La chaîne les absorbe en 1
  à 2 slots.
- Polling de confirmation à 400 ms au lieu de 2 500 ms ; blockhash `confirmed`
  plutôt que `finalized` pour les transactions courtes.
- Mobile : retirer les vagues 3 / 700 ms et la gigue par appel (déjà démontré en
  juillet comme du temps mort pur).

Estimation après L1 : 60 à 90 s par étape sur un bon RPC. Les 8 resizes et les 4
transactions de vérification/dépense restent séquentiels.

### L2. Vérifieur : plus de resize (1 redéploiement du vérifieur)

Le buffer de preuve est une PDA, donc limité à 10 240 o à la création et à
+10 240 o par transaction de realloc : 8 transactions séquentielles pour 83 Ko.
Deux options, la seconde est la meilleure :

- (a) Buffer sur un compte **keypair** créé côté client par
  `SystemProgram.createAccount` à la taille finale (pas de plafond 10 Ko hors
  CPI), puis `assign` au vérifieur et initialisé par une instruction
  `init_proof_buffer_v3`. 1 transaction au lieu de 9. Le vérifieur doit accepter
  un buffer dont il n'a pas dérivé l'adresse ; l'autorité reste un champ signé.
- (b) **Buffers réutilisables** : `init_proof_buffer_v2` (graine
  `stark_proof_v2` + nonce, existe déjà) plus une instruction `reset_proof_buffer`
  (remet `verified`, `deep_ali_verified`, `bytes_written` à zéro, accepte tout
  `proof_size` ≤ capacité). Le relayeur garde un parc de buffers de 90 Ko déjà
  alloués : zéro init, zéro resize par dépense. Pour le chemin direct (sans
  relayeur), le portefeuille garde un buffer par circuit après la première
  opération.

### L3. Pool : une seule transaction pour vérifier et dépenser (1 redéploiement du pool)

Les instructions d'une même transaction voient les écritures des précédentes ;
rien dans le vérifieur n'exige un slot différent entre phase 1, phase 2 et la
consommation. Mesures CU du 02-09 :

| circuit | phase 1 | phase 2 | instruction pool | total | tient en 1,4 M ? |
|---|---|---|---|---|---|
| C7 (retrait, abonnement) | 878 756 | 192 715 | 176 404 | 1 247 875 | oui, marge 11 % |
| C6 (dépôt) | 1 316 491 | ~190 000 | 302 672 | 1 809 000 | non : 2 tx (phase 1 seule, puis phase 2 + dépôt + close) |

Retrait/abonnement : `[verify_v2, verify_deep_ali_phase2, unshield_v4, close]`
en une transaction, 4 confirmations séquentielles de moins. Le
`insert_with_root_v3` reste tel quel.

### L4. Supprimer le scan (indexeur, puis stockage des nœuds sur la chaîne)

- **Tout de suite, zéro redéploiement** : une route `apps/web/app/api/pool-leaves/[pool]`
  qui sert la liste dense des feuilles depuis KV, rafraîchie par webhook Helius
  ou par le cron existant. Le client ne fait plus 1 appel par signature mais 1
  appel HTTP, puis reconstruit et vérifie le chemin comme aujourd'hui (le
  pre-flight de racine contre l'anneau on-chain reste l'autorité : un indexeur
  menteur ne peut que faire refuser une dépense, jamais en voler une). Mobile et
  extension consomment la même route.
- **Ensuite, structurel** : stocker les **nœuds** de l'arbre dans un compte
  dédié (8 o par nœud, 2 × 2^profondeur). Le dépôt écrit `profondeur` nœuds ; une
  dépense lit ses `profondeur` frères par `getAccountInfo` + `dataSlice`, en 1 à
  2 appels, sans indexeur ni reconstruction. À profondeur 19 : 8 Mo de compte,
  sous les 10 Mio de Solana. C'est un nouveau layout, donc à livrer avec le
  passage à la profondeur 19 (§3).

### Résultat attendu (estimé, RPC payé)

| étape | aujourd'hui | après L1 + L2 + L3 + L4 |
|---|---|---|
| dépôt (C6) | 6 à 8 min sur devnet, ~75 s mobile mesuré en juillet | preuve 2 s + upload 2 à 4 s + 2 tx ≈ **15 à 20 s** |
| retrait v4 (C7) | 630 s devnet | scan 0 + preuve 3 s + upload 2 à 4 s + 1 tx + sweep ≈ **10 à 15 s** |
| abonnement v4 (C7) | ~4 min devnet | idem ≈ **10 à 15 s** |

Ces chiffres supposent le relayeur pour le retrait (préfinancement et sweep
disparaissent du chemin critique). En direct, ajouter ~5 s.

## 3. Capacité de l'arbre

**État.** `DEFAULT_TREE_DEPTH = 15` → 32 768 feuilles par pool, et il y a un
pool par (jeton, dénomination). Au-delà, `insert_with_root_v3` renvoie
`MerkleTreeFull` et aucun client ne bascule. Les graines du pool sont
`(denominated_pool_v4, mint, denomination)` : pas d'ère, donc impossible
d'ouvrir un second pool de même dénomination sans changer le programme.

**Ce qui est déjà prêt.** Le compte d'arbre est taillé pour la profondeur 20
(`LEN` réserve 21 sous-arbres, table `ZEROS` de 21). Le repli on-chain est
paramétrique : `fold_insertion` (dépôt) et `resolve_pool_root` (dépense)
marchent sur `tree_depth − 11` niveaux, plafond `MAX_TOP_LEVELS = 8` →
**profondeur 19 = 524 288 feuilles, ×16**, sans toucher aux circuits. Coût CU
mesuré 34 469 par `hash2` : dépôt 16 hashs ≈ 552 k (budget à passer de 700 k à
~950 k), dépense 8 hashs ≈ 276 k + 176 k = 452 k. Les deux tiennent.

**Le vrai mur arrive avant la profondeur.** À 32 000 feuilles, le scan client
c'est 32 000 `getTransaction` et la reconstruction JS de 65 000 Poseidon. L4
est un prérequis à toute augmentation de capacité, pas une option.

**Anneau de racines.** `MAX_HISTORICAL_ROOTS = 100` : une preuve préparée sur
la racine R est refusée dès que 100 dépôts ont suivi. Acceptable aujourd'hui,
pas à 1 dépôt/seconde. Passer à 1 000 (32 Ko de Vec, migration de `LEN`) dans
le même redéploiement.

### Option A. Profondeur 15 → 19 en place (recommandée en premier)

Une instruction d'administration `migrate_tree_depth(19)` :
`root' = fold(root, ZEROS[15..18])`, même repli sur les 100 racines
historiques (elles restent valides pour les preuves en vol), `tree_depth = 19`,
`filled_subtrees[15..18] = ZEROS`. Aucune nouvelle PDA, aucun reçu invalidé.
Côté clients : lire `tree_depth` sur le compte au lieu de la constante
`MERKLE_DEPTH = 15` (trois surfaces), et envoyer 8 frères au lieu de 4 dans les
instructions v4 (les tests épinglent « 4 siblings » : à ré-épingler sur
`tree_depth − 11`).

### Option B. Ères de pool avec création automatique (filet de sécurité)

Nouvelle graine `(denominated_pool_v5, mint, denomination, era: u16)` et un
compte `PoolDirectory(mint, denomination)` qui nomme l'ère active. Les pools
actuels restent l'ère 0 sous leurs graines d'origine. Un gardien (le cron
GitHub Actions déjà en place, ou le relayeur) crée l'ère N + 1 dès que
`leaf_count ≥ max − marge` et bascule le directory ; n'importe qui peut aussi
l'appeler, l'instruction est permissionless et idempotente. Les dépôts vont à
l'ère active ; les dépenses partent du pool inscrit dans le reçu, ce qui est
déjà le cas. Coût : deux comptes de rente par ère. Effet de bord accepté :
l'ensemble d'anonymat est borné par ère (524 288 avec A).

Faire A et B dans le **même** redéploiement du pool que L3, avec l'anneau à
1 000. Un seul gel, une seule campagne de re-vérification.

## 4. Ordre proposé

| # | quoi | redéploiement | effort estimé | gain |
|---|---|---|---|---|
| 1 | L4 indexeur de feuilles (route + KV + webhook), 3 clients | non | 1 à 2 jours | scan 20 s → 0,3 s, et le mur des 32 k feuilles recule |
| 2 | L1 client : chunks parallèles, polling, mobile sans vagues | non | 1 jour | ~×2 |
| 3 | L2(b) buffers réutilisables + parc relayeur | vérifieur | 2 à 3 jours | −8 tx séquentielles |
| 4 | L3 verify + dépense en 1 tx, A profondeur 19, B ères, anneau 1 000 | pool | 1 semaine + gel + gates | −4 tx, ×16 capacité, plus jamais plein |
| 5 | L4 structurel : nœuds sur la chaîne | pool (avec 4) | dans le même lot si possible | plus d'indexeur du tout |

Avant d'ouvrir la porte à des centaines de milliers de dépôts, une chose du
registre des risques change d'échelle : la collision de feuille 64 bits
(`pool-v3-64bit-leaf-collision-2026-08-23`, 2^32 ≈ 0,5 heure-cœur). Elle n'est
pas dans ce plan et doit être traitée dans le même redéploiement du pool.

## Ce qui n'a pas été mesuré ici

- Aucun chronométrage pas à pas d'un retrait complet sur un RPC payé. Le
  plancher « 50 à 60 s » est de l'arithmétique sur les constantes, pas une
  mesure. Le premier pas concret est d'instrumenter `submitAndVerifyStarkProof`
  et le scan avec des horodatages par étape (aucun n'existe côté web).
- Le temps de preuve sur téléphone, toujours.
- La vitesse de Poseidon en JS BigInt (borne la reconstruction côté client).
