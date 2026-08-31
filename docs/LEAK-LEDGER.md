# Registre des fuites — Protocol 01

## Ce qu'est ce registre

Ce fichier est l'inventaire des **canaux** : tout chemin par lequel une valeur privée (le secret de note, le commitment, le lien dépôt↔retrait, l'identité du dépensier) peut atteindre un observateur. Rien ne se mesure « en général » : on ne mesure qu'un canal nommé.

**Règle unique : un canal absent de ce fichier est un défaut de ce fichier, pas un canal qui n'existe pas.** Un canal incertain reste inscrit, marqué `?`. Aucune affirmation ici sans `fichier:ligne` ou mesure nommée ; là où un nombre n'est pas mesuré, c'est écrit.

Le registre compte ~110 canaux ; ils sont groupés en **familles** pour tenir en un document lisible, chaque famille nommant ses membres. Les sections détaillées portent sur les familles ouvertes, pas sur chaque membre.

Statuts : **O** ouvert · **?** inconnu · **F** fermé (et sous quelles conditions).

## Le tableau

| id | ce qui fuit | statut | épinglé par |
|---|---|---|---|
| A1 | ~~C1/C3/C6 n'ont aucun masque~~ **FERMÉ 2026-08-31.** Les trois portent une région d'aveuglement ET une colonne de lift. L'attaque qui récupérait les 4 entrées privées de C1 échoue maintenant sur les trois, avec contrôle contrefactuel : *« la différence est le masque, pas l'arithmétique »* | **F** | `air_aware_recovery_c1.rs` (`the_mask_closes_the_columns_that_gave_up_all_four_witnesses`), `_c3.rs` (`c3_now_sits_with_c6_and_c7_on_the_under_determined_side`), `_c6.rs` (`the_mask_closes_the_four_columns_that_used_to_fall`) |
| A2 | **C0 = secret de note.** `pause/resume_private_stark.rs:104/:103` exigent `circuit_id==0` ; récupération par Lagrange | O | `witness_recovery_positive_control.rs` (abstrait, pas relié aux instructions) |
| A3 | **Jointure inter-circuits** : un secret récupéré via C0 rend le masque C7 sans objet pour la même identité (`spend.rs:920,:1052`). ⚠️ **La moitié C1 est tombée le 2026-08-31** — voir A1, l'attaque n'aboutit plus sur C1. La voie C0 reste entière (A2), donc le canal reste OUVERT avec une surface réduite de moitié | O | rien |
| A4 | ~~Système publié surdéterminé~~ **FERMÉ 2026-08-31.** Le fil entier est compté sur des octets réels, **par canal** — un total groupé cachait un déficit de 132 sur le canal A de C3. Les cinq circuits sont SOUS-déterminés sur le canal A ; C7 : 1 350 publiés contre 1 760 aléatoires | **F** (sauf canal B de C5, voir A5) | `stark/tests/full_wire_ledger.rs` (`the_split_that_decides_per_channel`, `the_whole_wire_counted_off_real_bytes`) |
| A5 | ~~Ouvertures quotient et FRI hors couverture du masque~~ **FERMÉ sur C1/C3/C6/C7 le 2026-08-31.** La colonne de lift rend **384 valeurs de quotient engagées sur 384** affines en un élément de masque, donc exactement uniformes ; la colonne randomizer couvre FRI et le terminal. ⛔ **C5 reste OUVERT** : ni lift ni randomizer, canal B à 0 aléatoire contre 200 publiés | **F** sur C1/C3/C6/C7, **O** sur C5 | `compact::zk_hiding` (`quotient_leaves_are_exactly_uniform_on_every_circuit`), `full_wire_ledger.rs` |
| A6 | ~~Pas de sel FRI, feuilles Merkle non salées~~ **FERMÉ 2026-08-31, et le sel n'est PAS le remède.** Le coset de la LDE ne touche jamais le domaine de trace, donc chaque coefficient de Lagrange d'une ligne d'aveuglement est non nul à **toute** position engagée : une feuille non ouverte est exactement uniforme, min-entropie ≥ 2·largeur·63 bits, indevinable — donc le SHA-256 non salé la cache dans le ROM. 🚨 Sur un sous-groupe (`h = 1`) ce serait faux : `blowup` positions tomberaient sur des lignes de trace et `Z_T = 0` y annulerait tout le masque | **F** | `compact::zk_hiding` (`the_lde_domain_never_meets_the_trace_domain_on_any_circuit`, `every_committed_trace_value_is_exactly_uniform_in_one_blinding_element`) |
| A7 | **Colonne 9** = `hash2(secret, cycle)` : dérivé du secret, invariant d'une preuve à l'autre (`spend.rs:1152-1157`). ⚠️ **La borne « 96..383 » date de la profondeur 12 et n'a pas été re-dérivée** : à `CANONICAL_DEPTH = 11`, `FIRST_FREE_ROW` vaut 352, donc la plage témoin est 96..351 et non 96..383. À re-mesurer avant de citer, pas à corriger de tête | O | rien |
| A8 | **Le masque est fourni par l'appelant**, seule sa *longueur* est vérifiée (`compact.rs:9557-9562`) — **reste OUVERT**. ~~`draw_spend_mask` n'existe que sous `feature="wasm"`~~ **FERMÉ 2026-08-30** : renommé `draw_blinding_mask` (partagé C6/C7 depuis le 29-08) et sorti de `mod wasm_api`, gaté `feature = "csprng"` qui est **par défaut** (`lib.rs:112,:129`). C'était le vrai défaut : derrière `wasm`, chaque appelant non-wasm écrivait son propre xorshift déterministe, et un masque déterministe ne cache rien. Cinq appelants prennent le vrai | **O** (clause 1), **F** (clause 2) | rien pour la clause 1 |
| A9 | **Canal subliminal** : 1 280 felts libres = 10 240 o choisis par le prouveur, publiés à jamais | O | rien |
| A10 | Nonce de grinding : ~`log2(travail)−22` bits choisis par preuve (`verify.rs:1386`, borne inférieure seule) | O | rien |
| A11 | **Preuves répétées** : ~+320 équations nettes par preuve sur un témoin fixe ; `prepareUnshieldJobV4` peut échouer après le prouvage | O | rien |
| B1 | **v3 publie le commitment en clair** (octet 80/160) ; v3 reste enregistré et l'extension *émet encore* des notes v3 | O | P1/P2 en CI (`v3-subscribe`) |
| B2 | **Payee en clair** : octet 88 (v3) / 115 (v4) + clé de compte ; balayage vers le portefeuille mesuré (`C4MqLbEx…`, +8 s) | O | P10 (offsets ; branches PASS/FAIL v3 sans fixture) |
| B3 | Nullifieur en clair + **PDA `NullifierRecord` énumérables** : recensement complet des dépenses en un `getProgramAccounts` | O | `nullifier_canonical_bound` (soundness, pas confidentialité) |
| B4 | **`directions` (3 o) + 3 frères + `merkle_root` choisi** : bucket sur 8, borne d'ancienneté | O | **rien** — `spend_root.rs:239-251` n'assère que des littéraux ; il ne peut pas rougir |
| B5 | Aucun **délai de maturité** : `dynamic_delay` calculé puis jeté (`_v4.rs:565`) | O | rien |
| B6 | **Dépôt entièrement public** : déposant, commitment, index, racines (`LeafInserted`) | O | utilisé comme vérité de base par P4 |
| B7 | État du pool : dénomination, `note_count`, **histogramme 32 époques**, anneau de 100 racines | O | P5 est un INFO ; **la sonde P5 n'existe pas** dans `p01-verify.mjs` |
| B8 | Abonnements : `subscriber_commitment`, **retailer**, rate/interval, longueur 196/228 (licence), 3 tailles de vault, événements `claim`/`pause` | O | offsets seulement |
| B9 | Emplacement `min_epoch` (octet 72) non lu par le programme : y écrire l'époque republierait le blinding 63 bits | O | constantes clients seulement |
| B10 | Notes **pré-blinding** : commitment reconstruit par énumération de quelques milliers d'époques ; ces notes ne peuvent se dépenser qu'en v3 | O | rien |
| C1 | **`circuit_id` dans les graines du PDA de buffer** (chemin v1, celui de la production), dans les données de compte, et dans `msg!` v2 | O | `cu_budget.rs` — **exclu de la CI** (`:2085-2094`) |
| C2 | **CU consommés** distincts par circuit (phase 1 et 2) : écrits par le runtime, inatteignables depuis le programme | O | `cu_budget` (ratchet ; hors CI) |
| C3 | **Enveloppe** : 77 965 o / 78 chunks (C7) vs 147 038 / 148 (C1+C3), taille du dernier chunk, loyer du buffer, arité des entrées publiques | O | rien côté web (le padding 145 000 est mobile) |
| C4 | **Entrées publiques en clair chez le vérifieur**, deux fois, *avant* la dépense : nullifieur + `sha256(payee)`. Survit à un envoi abandonné | O | rien |
| C5 | **Payeur de frais** (`accountKeys[0]`) et jointure buffer↔dépense sur une clé | O | P6/P11 (P11 PASS uniquement sur `v4-relayed`) |
| C6 | Empreintes montantes : récompense relayeur **constante 2 500 000**, delta d'escrow, discriminant relayé/direct, compteur de prix CU `i+1` **encore présent dans 2 paquets npm** | O | rien |
| D1 | **Même IP, même clé RPC** pour le dépôt et le retrait ; rafale de ~150 tx en ~2 min | O | rien |
| D2 | Le **garde anti-liaison interroge le RPC** avec (portefeuille, financeur) au moment de la dépense (`shieldClient.ts:813,:854`) | O | rien |
| D3 | Résidu L4 : `getAccountInfo(nullifierPDA)` sur 4 chemins de préparation, y compris ceux qui échouent | O | rien |
| D4 | **KV serveur** : portefeuille payeur → code → adresse de note ; **sans expiration, par décision** | O | rien |
| D5 | **La graine du trésor dérive chaque note émise** : ensemble d'anonymat = 1 face à l'émetteur, et *dépensable* par lui | O | impossible en code |
| D6 | **Le worker exporte la graine** (`handlePoolExportSeed`, `seedHex`), protégé par une chaîne littérale publique et `?treasury=1` | O | rien |
| D7 | Disque : clé acheteur en clair, reçus de relais en clair, résidu v1 en clair, **longueurs des blobs scellés** non paddées | O | `storeEncryption.test` épingle la *persistance* du résidu |
| D8 | **Presse-papiers / feuille de partage** portent le porteur ; le web ne l'efface jamais | O | rien |
| D9 | Adresse de note **statique par identité**, sans diversification | O | rien |
| D10 | Le **relayeur voit tout** hors chaîne (payee, nullifieur, preuve, IP) ; `/health` publie `busy`, les compteurs et la clé opérateur, sans auth | O | rien |
| D11 | Graine de portefeuille : ni secret avant, ni secret après — une fuite unique déanonymise tout l'historique | O | rien |
| D12 | L'**extension** est une pile parallèle non auditée, et son agent IA POSTe le solde et le texte de l'utilisateur vers Groq et Google | O | rien |
| D13 | **SNI/DNS** : contacter l'hôte du relayeur révèle l'opération avant toute preuve. Aucun proxy dans l'arbre | O | rien |
| E1 | Graphe monétaire : l'acheteur paie la caisse en clair ; **P11 ne remonte que 2 sauts** alors que la topologie en fait 4 | O | P11 (aveugle au-delà du flotteur) |
| E2 | Le règlement caisse→flotteur est une arête publique ; le plancher de lot est réglable à 1 par variable d'environnement | O | tests d'unité purs |
| E3 | **Adjacence achat↔dépense** non décorrélée (le délai minimal ne couvre que `/issue-note`, pas `relay-to-buyer`) | O | rien |
| E4 | Réemploi d'éphémère : une souscription abandonnée et le retrait ultérieur partagent une clé | O | rien |
| E5 | Le **stock du trésor est classifiable** (financeur, cadence, plages IP GitHub Actions) : `note_count` surestime la foule | O | rien |
| E6 | L'**autorité d'upgrade** est la clé CLI par défaut, aussi trésorerie et nœud relayeur, et a payé le retrait vedette | O | `publicPayer.test` (refus contournable par variable d'environnement) |
| E7 | Un seul opérateur tient émission + relais de fonds + relais de dépense : carte complète hors chaîne | O | impossible en code |
| F1 | Poseidon : constantes **non conformes à leur provenance annoncée** (répétitions de différences, p≈2⁻⁵²) ; `MDS_MATRIX_T5` **n'est pas MDS** (60 mineurs singuliers) ; 30 tours pleins contre 4+22+4 documentés | O | vecteurs de sortie seulement |
| F2 | Capacité d'éponge 64 bits → collisions en 2³² sur chaque feuille | O | `zz_skeptic_leaf_width.rs` — `#[ignore]` |
| F3 | Plancher Fiat-Shamir : **C7 ≈ 47 conjecturé / 42 inconditionnel**, et **C7 est exclu du test** (`b1_deep_binding.rs`, `0..=6`, `[u32;7]`) | O | rien pour C7 |
| G1 | **Décroissance des mesures** : P11 dépend du plafond `--max-chunk-tx` et de la rétention RPC ; une absence expire en silence | O | rien |
| G2 | **Fermetures conditionnelles** : offset 115 ne vaut qu'à profondeur 15 ; bucket 0 ne vaut qu'en dessous de 4 097 feuilles ; la faille SPL v3 n'est latente que parce que les deux pools sont SOL | O | rien ne lit ces faits en chaîne |
| G3 | **La prose lue comme preuve** : commentaires périmés (lignes miroir « inutilisées » alors que `verify.rs:1937-1944` les consomme ; L4 décrit comme actuel), chiffre « 48-50 s » présent dans 5 fichiers sans artefact | O | rien |
| ?1 | C7 hors trace : décomposition du quotient, polynôme DEEP, engagement vectoriel — **aucun argument de simulation** (`spend.rs:262-268`) | ? | rien |
| ?2 | C3 et C6 : jamais attaqués. C3 a la même structure de lignes de padding que C1 et aucun masque | ? | rien |
| ?3 | Système conjoint C1+C3(+C6) sur un témoin partagé : jamais formé | ? | rien |
| ?4 | Provenance du blob wasm : l'ascendance git prouve qu'il a été *commité* après le masquage, jamais qu'il en a été *construit* | ? | `wireFormat.test.ts` n'épingle que des longueurs, et le masquage est neutre en longueur |
| ?5 | Regrouper les tx par blockhash ; compteur Memo mobile ; CU de l'instruction de dépense ; 15 paquets npm publiés jamais audités ; sauvegardes OS mobiles | ? | rien |
| ?6 | Les deux programmes restent-ils upgradables aujourd'hui ? Non vérifiable depuis le dépôt | ? | rien |
| F-a | Aucun point de requête LDE n'est un point du domaine de trace (coset h=7) : la **copie verbatim** du commitment en colonne 9/5 est retirée | F | `shift_is_outside_every_shipping_lde_domain` |
| F-b | L'instruction v4 ne porte **aucun commitment** | F | P1/P2/P4 sur `v4-live` + contrôle positif `v4-synthetic`, en CI |
| F-c | `ood_z` et les positions de requête sont redérivés et comparés côté vérifieur | F | comparaisons explicites dans `verify.rs` |
| F-d | L4 par note remplacé par **un seul `getProgramAccounts` par pool** | F | `poolResolveSpent.test.ts` (`chain.calls == [POOL_58]`) |
| F-e | Pré-financement à montant exact : jitter côté web | **F web / O mobile** — `jitterPrefund` n'existe pas dans `apps/mobile` |
| F-f | `shield`/`transfer`/`unshield` de base (C5) désenregistrés ; alias de nullifieur non canonique borné dans les 5 instructions vivantes ; ordre d'inventaire mélangé ; montant payé identique en relayé et direct | F | tests en CI |

## Les familles ouvertes, en clair

**A1–A3 — les circuits sans masque.** Trois des quatre circuits vivants ne masquent rien. Sur C1 les 35 lignes de padding sont des copies d'autres lignes : 128 inconnues tombent à 93 effectives contre 110 ouvertures, et le système se résout par élimination gaussienne. Ce n'est pas un distingueur, c'est une **récupération** — et la valeur récupérée est l'autorité de dépense. **Mesure qui trancherait** : pointer le solveur existant sur des octets réassemblés d'un vrai envoi devnet et comparer le commitment reconstruit à la feuille publiée. **Coût de fermeture** : masquer C1/C3/C6 comme C7 (surface et CU en hausse), ou retirer les chemins v3 — ce qui échoue les notes pré-blinding.

**A4–A9 — le fil de C7 au-delà de la trace.** Le fil publie ~1 600 felts ; la marge « 128 contre 90 » n'en couvre que 900. Les 700 autres (quotient, FRI, polynôme final) sont des équations dans les mêmes inconnues, et aucun test ne les transforme en équations. **Mesure** : étendre `air_aware_recovery_c7.rs` au système conjoint, avec contrôle positif (masque effondré) sous peine de vert infalsifiable. **Coût** : sel FRI + feuilles randomisées = redéploiement du vérifieur et croissance du fil.

**B1–B4 — ce que l'instruction dit encore.** v3 publie le commitment ; v4 publie le payee, le nullifieur, 3 bits de bucket et 3 frères. **Mesure** : regrouper les dépenses enregistrées par `bucket_index(directions)` et publier la plus petite population. **Coût** : prouver 15 niveaux au lieu de 12 (CU), ou padder le chemin web.

**C1–C6 — l'enveloppe est plus bruyante que la preuve.** L'adresse du buffer nomme le circuit, les CU le renomment, l'arité le renomme encore, la taille et le nombre de chunks le confirment. `init_proof_buffer_v2` + `verify_uniform` existent et **la production ne les appelle pas**. **Mesure** : lire un journal de vérification vivant et les clés de compte d'une dépense enregistrée. **Coût** : migrer le client vers v2 + padding à 145 000 o — 145 chunks au lieu de 78, plus de loyer, et interaction avec le plafond de P11.

**D1–D13 / E1–E7 — hors chaîne.** Le fournisseur RPC voit les deux moitiés depuis une IP ; le KV joint le paiement à l'adresse de note ; l'émetteur peut recalculer *et dépenser* chaque note émise ; une seule clé publiée est autorité d'upgrade, trésorerie et relayeur. **Aucune mesure en chaîne ne tranche ces canaux** : ce sont des faits de garde et de topologie. **Coût** : séparer les rôles, faire tourner la clé, écrire une politique de rétention.

**F1–F3 — les paramètres.** Les constantes Poseidon ne correspondent pas à leur provenance annoncée (mesuré), `MDS_MATRIX_T5` n'est pas MDS (mesuré, aujourd'hui non câblé), et C7 — seul circuit de retrait vivant — n'a **aucun niveau de sécurité assuré** par un test.

## Ce que le masque de C7 NE couvre pas

Le masque écrit 1 280 felts CSPRNG dans les lignes 384..511 de la trace. Il ferme **un** canal sur plusieurs, et voici ce qu'il ne touche pas, d'après le code lui-même (`stark/src/air/spend.rs:262-268`) :

- la **décomposition du quotient**, le **polynôme de composition DEEP**, l'**engagement vectoriel** — aucun argument de simulation ;
- l'**absence de sel FRI** — chaque couche est engagée sans aléa dans la préimage ;
- les **lignes miroir** de la Route C, qui doublent R de 46 à 90 et consomment la moitié de la marge (et qui **sont consommées** par `verify.rs:1937-1944`, contrairement à leur commentaire) ;
- le **remplissage `hash2(secret, cycle)`** de la colonne 9, invariant d'une preuve à l'autre ;
- toute l'**enveloppe** (PDA, CU, chunks, journaux, payeur) ;
- **C1, C3, C6, C0**, qui n'ont pas de masque du tout.

Ce que la mesure du jour établit, et rien de plus : *la colonne « hold » de C7 ne se résout pas par le solveur linéaire de C1, calibré par l'effondrement du masque* (`air_aware_recovery_c7.rs`). Le fichier écrit lui-même qu'un résultat de rang n'est pas un résultat de secret, et que son masque de test est un xorshift déterministe. Cette phrase-là peut être gravée. « Rien ne fuit » ne le peut pas.

## Ce qu'on ne peut pas mesurer, et pourquoi

- **La garde des clés** : graine du trésor, graine de portefeuille, autorité d'upgrade, clé du relayeur. Aucun test ne peut établir qui les détient.
- **Ce que retiennent les tiers** : fournisseur RPC, relayeur, hébergeur, Groq/Google via l'extension. On ne peut mesurer que ce qui *part*, jamais ce qui est *gardé*.
- **La provenance du blob prouveur** : rien dans le dépôt ne reconstruit le wasm ; le masquage est neutre en longueur, donc aucun test de longueur ne peut le voir.
- **L'absence** : P11 à 0 sur 94 transactions et P10 « pas encore balayé » sont des absences ; une absence expire silencieusement et doit être *re-mesurée*, jamais citée.
- **L'état on-chain courant** (autorité d'upgrade, `next_leaf_index`, `token_mint`) : lu nulle part par un test.

## L'ordre de fermeture proposé

1. **Cesser d'émettre des notes v3** (extension, mobile) et compter les notes pré-blinding restantes. Aucun code cryptographique ; retire des notes de la classe A1/B1/B10.
2. **Rendre les épingles inertes réelles** : sortir `cu_budget` de la liste d'exclusion CI, faire lire à `spend_root.rs:239-251` le compte de feuilles réel, assérer C7 dans `b1_deep_binding.rs` (`0..=7`). Trois modifications mécaniques ; sans elles, C1–C2, B4 et F3 sont non gardés.
3. **Migrer le client vers `init_proof_buffer_v2` + `verify_uniform` + padding.** Déplace C1, C3, une partie de C2 et les journaux d'un coup ; coût connu : 145 chunks.
4. **Écrire les harnais manquants** : C3, C6, puis le système conjoint C1+C3, sur le modèle de `air_aware_recovery_c1.rs`, chacun avec son contrôle positif.
5. **Étendre le solveur C7 au quotient et à FRI** (A4/A5/?1). C'est la mesure la plus chère et la plus décisive : elle dit si le masque vaut quelque chose.
6. **Ajouter sel FRI et feuilles randomisées**, puis re-mesurer taille et CU. Redéploiement du vérifieur.
7. **Séparer les rôles opérateur** et faire tourner l'autorité d'upgrade (E6/E7). Décision organisationnelle, pas de code.
8. **Régénérer les paramètres Poseidon** depuis le script de référence, ou remplacer la phrase de provenance par ce qui s'est réellement passé (F1).
9. **Mécaniser la règle de preuve** : tout commentaire affirmant une propriété de confidentialité doit nommer un test ou un artefact, sinon la construction échoue (G3). C'est le défaut qui rend ce registre faux tout en le laissant vert.
