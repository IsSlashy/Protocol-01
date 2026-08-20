# État de l'unlinkability — 2026-08-21

**Branche `chore/remove-mugen-2026-08-19`, HEAD `9d7a74c4`.**
Programmes devnet : `zk_shielded` = `GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c`
(`lib.rs:39`), `p01_stark_verifier` = `DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs`
(`lib.rs:36`).

Ce document n'est pas un résumé. C'est ce qui évite de re-dériver une journée de
mesures et de reconstruire un argument déjà réfuté. Il est écrit pour être lu **froid**,
dans trois semaines, sans le contexte de la session.

Règle de lecture : chaque nombre porte sa provenance. Quand la provenance est un
`fichier:ligne`, elle est vérifiable maintenant. Quand elle est une transaction devnet
ou une exécution de session, **elle n'existe nulle part dans le dépôt** — c'est signalé,
et c'est une dette (§3.2).

---

## 0. Verdict en 60 secondes

1. La géométrie de C7 (512 lignes) a été choisie sur un chiffre qui n'a jamais été
   mesuré. Cette erreur rend le masquage **structurellement impossible**. 1024 lignes
   le permettent et coûtent bien moins que ce que le plan supposait. **§1.**
2. Il y a **quatre canaux ouverts** vers l'acheteur. Le zero-knowledge en ferme
   **exactement un**. « On mettra tout en ZK » est la fausse idée que ce document
   existe pour tuer. **§2.**
3. Le coût du masquage **n'a aucun nombre**. Personne ne l'a mesuré, aucune source
   atteignable ne le publie. Ne pas l'estimer. **§4.**
4. C7 est écrit sur `HEAD`. Le vérifieur **déployé** est `b7`, à 111 commits de là.
   C7 est donc écrit contre un vérifieur qui n'est pas celui qui tourne. **§5.**
5. `sweep_fee_escrow` **ne peut pas fonctionner** : 0,151691 SOL de frais protocole
   sont inatteignables **par le binaire déployé**, et chaque dépôt en ajoute. Ce n'est
   pas une perte définitive — un redéploiement corrigeant l'instruction les récupère.
   Ce qui est bloqué, c'est le code en place, pas les lamports. **§7.**

---

## 1. LA CHAÎNE — comment 512 a interdit le masquage

C'est la chose la plus utile apprise dans cette session, et elle était jusqu'ici
éparpillée sur quatre documents. Elle se lit comme une causalité, pas comme une liste.

### 1.1 L'ancre fantôme

`docs/C7_SPEND_CIRCUIT_PLAN.md:18` fixe la géométrie de C7 en s'ancrant sur C6 :

> « That circuit is deployed and measured at **1,316,491 CU** in phase 1. »

et `:60` rejoue le même chiffre pour écarter le risque de la phase 1.

**Ce nombre n'existe nulle part dans le dépôt comme mesure.** Un `grep` sur `docs/`,
`stark/`, `programs/` ne le trouve que dans ces deux lignes de prose.

> Rejoué le 21-08 (une relecture avait mis ce point en doute) :
> `grep -rn "1316491\|1,316,491\|1_316_491\|1 316 491" docs/ stark/ programs/`
> → `C7_SPEND_CIRCUIT_PLAN.md:18` et `:60`, plus les occurrences de cette note.
> Zéro dans `stark/`, zéro dans `programs/`. **La revendication tient.** Le pin mesuré
de C6 est :

```
programs/p01_stark_verifier/tests/cu_budget.rs:1338   (branche b7-drop-aligned-checks UNIQUEMENT)
CuCeiling { circuit_id: 6, phase1_measured: 888_220, phase1_max: 906_000,
            phase2_measured: Some(122_739), phase2_max: Some(126_000) },
```

**L'ancre était 428 271 CU trop haute** (1 316 491 − 888 220). Tout ce qui a été
décidé « parce qu'on n'a que ~83K de marge » (`:60`) a été décidé sur une marge
inventée.

### 1.2 Ce que 512 lignes coûtent : le masquage devient impossible

Géométrie C7 délivrée (`stark/src/air/spend.rs:14`) :
`width 10, length 512, blowup 16 → LDE 8192, merkle_depth 13, 22 queries, ffps 32`.

Un STARK zero-knowledge a besoin de **2·queries + 1 = 2·22 + 1 = 45** lignes libres
(lignes aléatoires que le prouveur peut sacrifier aux ouvertures sans révéler de trace).

- Le pipeline Merkle occupe 15 niveaux × 32 lignes = **480**. Sur 512, il reste **32**.
- 32 < 45. **Le masquage n'a pas la place.**
- Pire : l'AIR tel qu'écrit est plus strict que ce compte. `stark/src/air/spend.rs:44-45`
  dit textuellement « **there are no padding rows.** Every row 0..511 is an active
  Poseidon round on both pipelines » — les cycles 3-15 du pipeline commitment sont des
  Poseidon factices mais **contraints**. Dans le circuit livré il reste donc **zéro**
  ligne disponible, pas 32.

Le plan **dit lui-même** que 512 laisse 32 lignes contre 45 nécessaires, dans son
encadré « 🚨 A constraint discovered after this plan was written outranks everything
in it » (`docs/C7_SPEND_CIRCUIT_PLAN.md`, section autour de :440-454) — et il ne relie
jamais ce constat à son propre rejet de 1024, trente lignes plus haut. **La
contradiction est interne au document.** C'est le point à ne pas re-dériver.

### 1.3 Ce que 1024 lignes donnent, et ce qu'elles coûtent vraiment

| | 512 | 1024 |
|---|---|---|
| lignes libres | 32 (0 dans l'AIR livré) | **448** |
| besoin ZK (2·22+1) | 45 | 45 |
| verdict | masquage **impossible** | ~**10×** le besoin |

Coût mesuré du doublement — **côté vérifieur uniquement** :

- **+660 sha256 par preuve**, à **137,00 CU par hash de 64 octets**
  (sonde déployée sur devnet le 2026-08-20, linéaire de 1 à 2000 hashes)
  → **≈ +90 420 CU**.
- Phase 1 atterrit à **≈ 979 000 CU** contre un plafond de **1 400 000**.
- Un chiffrage indépendant a donné **936 000 – 1 046 000 CU**. Les deux **réfutent**
  le ~1,37 M supposé par le plan.

**Ce qui n'est PAS chiffré ici, et qu'il ne faut pas lire comme gratuit.** Les trois
nombres ci-dessus décrivent la vérification on-chain. Le **prouveur** est l'autre
moitié de la facture, et elle n'est pas mesurée :

| poste | attendu | état |
|---|---|---|
| temps de preuve | ~`n log n` → proche du double | **NON MESURÉ** |
| mémoire du prouveur | proche du double | **NON MESURÉ** |
| taille du blob de preuve | +1 nœud par chemin de Merkle, +1 couche FRI | **NON MESURÉ** |
| transactions de téléversement (~150 aujourd'hui) | suit la taille du blob | **NON MESURÉ** |
| rente transitoire (~0,57 SOL par dépôt) | suit le nombre de chunks | **NON MESURÉ** |

Deux de ces lignes ont déjà mordu ce projet : la preuve sur appareil dépasse **180 s**
et un dépôt coûte aujourd'hui **50-230 s**. Doubler la trace est bon marché **là où on
l'a regardé** et personne n'a regardé ailleurs. Le passage à 1024 doit donc être
mesuré sur le prouveur avant d'être décidé, pas seulement sur le plafond de CU.

**La raison structurelle, à retenir plus que les chiffres** : la phase 1 croît en
`log2(trace_length)`, **pas** en `trace_length`. Doubler la trace ajoute **un** niveau
de Merkle et **une** couche FRI. C'est pourquoi l'intuition « 1024 = 2× le coût » est
fausse, et c'est cette intuition qui a produit l'ancre fantôme.

### 1.4 La chaîne, en une ligne

> Une ancre jamais mesurée (1 316 491 au lieu de 888 220, +428 271) → une géométrie
> à 512 lignes → 32 lignes libres pour un besoin de 45 → **le masquage est
> structurellement impossible dans le circuit livré** → alors que 1024 en libère 448
> pour ≈ +90 420 CU, soit ≈ 979 000 sur un plafond de 1 400 000.

---

## 2. LES CANAUX vers l'acheteur

Quatre canaux, un fermé, trois ouverts. Plus deux choses qui **ne sont pas des canaux**
mais qui plafonnent ou trahissent quand même.

**Lire cette colonne avant tout le reste** : « le ZK ferme-t-il ça ? »

| # | Canal | Statut | Le ZK ferme-t-il ? | Ce qui ferme |
|---|---|---|---|---|
| 1 | Graphe de financement | **OUVERT** | **NON** | de l'ingénierie de flux (relais de déploiement) |
| 2 | La preuve elle-même | **OUVERT** | **OUI — le seul** | masquage (§4, coût inconnu) |
| 3 | Compute units dans les logs | **PAS UN CANAL** (mesuré) | sans objet | rien — voir §2.3 |
| 4 | Adresse du vault | **FERMÉ**, mesuré | sans objet | déjà fermé par construction |
| 5 | *(plafond)* ensemble d'anonymat | limite | **NON** | du capital, pas du code |
| 6 | *(fuite)* écart temporel | **OUVERT** | **NON** | du délai / du volume |

> **La fausse idée que ce document existe pour tuer** : « on rend tout ZK et c'est
> réglé ». Le zero-knowledge ferme **le canal 2 et lui seul**. Les canaux 1, 3 et 6
> vivent dans l'en-tête de transaction, dans les logs du runtime et dans l'horloge —
> trois endroits où aucune preuve ne peut rien. Trois d'entre eux se ferment sans
> toucher au prouveur ; celui qui exige le prouveur est aussi le seul dont le coût
> est inconnu.

### 2.1 Canal 1 — le graphe de financement · OUVERT

Sur la démo gelée, ce n'est **pas deux sauts, c'en est un seul**. La plus ancienne
transaction du payeur de frais éphémère `HYjzR8em1qKv…s` est un virement de
**1,08 SOL signé par le portefeuille `7gWpzSZALYz3…` lui-même** — parce que le harnais
live finance l'éphémère **en direct** au lieu de passer par le relais de déploiement.

Aucune cryptographie ne ferme ça : **le payeur de frais est dans l'en-tête de la
transaction**, en clair, avant toute exécution.

Ce que ça corrige le constat antérieur (mémoire `p11-green-third-party-deposit-2026-08-18`,
« à 2 sauts ») : sur ce chemin-là, il y en a **un**.

**Ce qui ferme** : que le financement passe par le relais de déploiement, jamais par
le portefeuille. C'est du câblage, pas de la crypto.

### 2.2 Canal 2 — la preuve publie le commitment · OUVERT · *le seul que le ZK ferme*

`stark/src/air/spend.rs:41` : `col 9  commit_hold  globally constant column`.
Une colonne contrainte constante **interpole vers un polynôme constant**, donc son
interpolant **est** le commitment.

Le sérialiseur publie cet interpolant **≈ 46 fois par preuve, en clair** :
`stark/src/compact.rs:4046-4120` écrit `ood_current[col]` et `ood_next[col]` **pour
chaque colonne**, plus `lde[col][pos]` et `lde[col][next_pos]` **par query** (22
queries). Le blob part en **instruction data publique**.

**MESURÉ**, pas déduit — deux tests commités en `cfcea041`, `stark/src/air/spend.rs` :

- `measured_the_published_ood_of_col9_is_the_commitment_itself` — un observateur lit
  **huit octets à l'offset 136** et a terminé : pas de témoin, pas de query, pas de
  liste de candidats, pas de travail. Confirmé à `z = 0xDEADBEEF`,
  `0x0123456789ABCDEF`, et `3`.
- `measured_the_merkle_channel_is_a_distinguisher_not_a_solve` — **supprimer la colonne
  constante ne ferme pas le canal.** Le commitment survit comme première entrée de hash
  du pipeline Merkle (colonnes 0-2). Le canal résiduel **n'est pas affine** en le
  commitment (la S-box Poseidon est `x^7`, aucune division unique ne le résout) **mais
  c'est un distingueur parfait** : sur huit candidats, huit valeurs publiées distinctes,
  et exactement une correspond.

**L'ensemble de candidats est l'ensemble des feuilles publiques du pool.** Il est petit
(§2.5). Un distingueur parfait sur un petit ensemble énuméré **est** une désanonymisation.

**Ce qui ferme** : le masquage, et rien d'autre. Le redesign « niveau moins un » ne
suffit pas — c'est la mesure 2 ci-dessus.

### 2.3 Canal 3 — les compute units dans les logs · OUVERT · *personne ne l'avait nommé*

Dix abonnements à **dénomination, taille de vault et programme identiques** :
CU de **28 918 à 40 721**, les dix **distincts**.

Cause, `programs/zk_shielded/src/instructions/subscribe_private_stark.rs:89-95` et
`:128-133` : deux PDA (`vault`, `nullifier_record`) sont dérivés **à l'exécution** avec
un `bump` nu — pas de `bump = x` :

```rust
seeds = [ SubscriptionVault::SEED_PREFIX, retailer.key().as_ref(),
          subscriber_commitment.as_ref(), denominated_pool.token_mint.as_ref() ],
bump          // <- nu : Anchor appelle find_program_address
```

Anchor appelle donc `find_program_address`, qui **sonde** les bumps en descendant depuis
255. Le nombre de sondes dépend des seeds — et les seeds **contiennent la note**. Le
compteur de CU dans les logs est donc une fonction publique du secret.

Le masquage **ne ferme pas** ce canal : il est en dehors de la preuve.
#### Correction du 21-08 — les « cinq lignes » n'existent pas, et le canal non plus

Deux choses écrites plus haut étaient fausses. Elles sont corrigées ici plutôt que
supprimées, parce que l'erreur est instructive.

**a) `bump = …` n'enlève PAS la recherche sur un compte `init`.** Lu dans le codegen
d'`anchor-syn 0.32.1`, pas supposé : pour tout compte `init` + `seeds`, le générateur
émet `Pubkey::find_program_address` **inconditionnellement**
(`codegen/accounts/constraints.rs:548-555`, inséré à `:1083`). Écrire `bump = x`
n'y touche pas — ça **ajoute** une vérification (`:512-527`). La forme à coût constant,
`create_program_address`, n'existe que sur le chemin **non-`init`** (`:1183-1188`).
Nos deux PDA sont créés par cette instruction. Le correctif proposé aurait donc
coûté un redéploiement pour **zéro CU** gagné, et le seul moyen d'y arriver vraiment
serait de sortir la création du vault de l'instruction — pas cinq lignes, un chantier.

**b) Et il n'y avait rien à fermer.** Le compteur de CU est une fonction du nombre de
sondes, donc des seeds, donc de `subscriber_commitment`. Mais `subscriber_commitment`
est écrit **en clair dans le compte vault créé par cette même transaction** — c'est
exactement la valeur que §2.4 relit pour reproduire l'adresse. Quiconque voit la ligne
de CU voit la transaction, donc voit le compte, donc a déjà la valeur en entier. Le
canal ne publie pas un secret : il **redit du public**, moins bien.

Ce qui décide si cette valeur trahit l'acheteur, c'est §2.4 — et §2.4 est **mesuré
fermé**. Le canal 3 était un fantôme habillé en trouvaille, du même genre que celui
de §1.1, et repéré par la même méthode : lire le générateur au lieu de croire la doc.

### 2.4 Canal 4 — l'adresse du vault · **FERMÉ**, et c'est mesuré

**Toutes** les feuilles du pool 1 SOL ont été passées dans la dérivation réelle :
**zéro** ne reproduit un vault vivant, tandis que le `subscriber_commitment` réel lu
dans le compte le reproduit exactement. (Le compte de feuilles bouge — 34 le 20-08,
la campagne en ajoute une par dépôt — mais la conclusion n'en dépend pas : elle tient
à la *forme* de la seed, pas au nombre de candidats.)

La seed est **`Poseidon(secret de la note)`, pas la feuille publique**. Le canal
n'existe pas. Ne pas le rouvrir en le supposant ouvert.

### 2.5 Ce qui n'est pas un canal (1) — le plafond de l'ensemble d'anonymat

Le pool 1 SOL (`BoCTorE7dDyFTaK4oCEw8K3w7F6FxrKCSqbAGVv4cxXL`, `docs/devnet-pools.md:17`)
détenait **11 notes non dépensées** au 2026-08-20. Une campagne de dépôts tourne
actuellement (`lib/privacy/pool/depositCampaign.test.ts`).

**Le plafond est le capital, pas le code** : ≈ **41 notes** aux 42,9 SOL actuels.
Aucune ligne de Rust, aucune preuve, aucun masquage n'élargit un ensemble
d'anonymat. C'est une contrainte de trésorerie. Elle borne par le haut tout ce que les
§2.1-2.3 peuvent acheter : fermer les quatre canaux dans un pool de 11 notes donne
`log2(11) ≈ 3,5 bits`.

### 2.6 Ce qui n'est pas un canal (2) — l'écart temporel · OUVERT

Mesuré, et non nommé jusqu'ici : **524 slots (~3,5 min)** entre le dépôt de la démo
gelée et la dépense qui l'a consommée, sur un pool qui reçoit **environ un dépôt par
jour**.

Sur un pool à un dépôt/jour, un écart de 3,5 minutes désigne la note **sans aucune
cryptographie**. Un observateur trie par horodatage et a fini.

**Ce qui ferme** : du délai (attente aléatoire avant dépense) ou du volume (§2.5).
Pas une preuve.

---

## 3. LES NOMBRES

### 3.1 Épinglés dans le dépôt (vérifiables maintenant)

| Nombre | Ce que c'est | Provenance |
|---|---|---|
| **888 220** CU | C6 phase 1, **la** mesure | `programs/p01_stark_verifier/tests/cu_budget.rs:1338` — **branche `b7-drop-aligned-checks` uniquement** |
| **122 739** CU | C6 phase 2 mesurée | même ligne |
| 1 316 491 CU | **fantôme** — aucune mesure | `docs/C7_SPEND_CIRCUIT_PLAN.md:18` et `:60`, prose seule |
| width 10 / 512 / blowup 16 / LDE 8192 / depth 13 / **22 queries** | géométrie C7 | `stark/src/air/spend.rs:14` |
| `col 9 commit_hold` constante globale | l'origine du canal 2 | `stark/src/air/spend.rs:41` |
| « no padding rows », lignes 0..511 actives | 0 ligne libre livrée | `stark/src/air/spend.rs:44-45` |
| `ood_current[col]`, `ood_next[col]`, `lde[col][pos]` | la publication, ~46×/preuve | `stark/src/compact.rs:4046-4120` |
| `bump` nu × 2 | l'origine du canal 3 | `subscribe_private_stark.rs:89-95`, `:128-133` |
| `SystemAccount` + `-= amount` | l'origine du bug de frais | `sweep_fee_escrow.rs:41` et `:117` |
| 4 743 / 7 267 lignes | `verify.rs` HEAD / b7 | mesuré au HEAD `9d7a74c4` |
| 111 / 4 commits | divergence stark+verifier | `git log HEAD..b7-drop-aligned-checks -- stark/ programs/p01_stark_verifier/` |

### 3.2 NON épinglés — ils n'existent que dans ce document et sur la chaîne

**Dette à traiter.** Un `grep` sur `docs/ stark/src/ programs/ apps/web/lib/ scripts/`
ne trouve **aucun** de ces nombres. Ils viennent de mesures de session (devnet, litesvm).

> Rejoué le 21-08 sur 85 218, 90 420, 137,00 et 979 000, dans les quatre écritures
> usuelles (`85218`, `85,218`, `85_218`, `85 218`) : **0 occurrence** hors de ce
> document pour chacun. La dette est réelle et elle est exactement de cette taille.
Si ce document se perd, ils sont perdus.

| Nombre | Ce que c'est | Provenance |
|---|---|---|
| **137,00 CU** | par sha256 de 64 octets | sonde déployée sur devnet le 2026-08-20, **linéaire de 1 à 2000 hashes** |
| **+660** sha256 | surcoût 512 → 1024 par preuve | dérivé de la géométrie |
| **≈ +90 420 CU** | 660 × 137,00 | dérivé |
| **≈ 979 000 CU** | phase 1 à 1024 lignes | dérivé, plafond **1 400 000** |
| 936 000 – 1 046 000 CU | chiffrage **indépendant** du même | corrobore, réfute ~1,37 M |
| **85 218 CU** | **C7 phase 2** | corroboré **identiquement par litesvm ET par devnet** — deux instruments, même nombre |
| **28 918 – 40 721** CU | écart sur **dix** dépenses identiques | canal 3, §2.3 |
| **35** feuilles | pool 1 SOL, testées une à une | canal 4, §2.4 |
| **11** notes non dépensées | pool 1 SOL au 2026-08-20 | plafond, §2.5 |
| **≈ 41** notes | plafond aux 42,9 SOL actuels | plafond, §2.5 |
| **524** slots (~3,5 min) | dépôt → dépense, démo gelée | §2.6 |
| **0,151691** SOL | frais protocole inatteignables par le binaire déployé | §7 |

> **85 218 corroboré à l'identique par litesvm et par devnet** est le nombre le plus
> solide de la liste : deux instruments indépendants, pas une extrapolation. Il mérite
> un pin dans `cu_budget.rs` avant tout le reste.

---

## 4. CE QUI N'A AUCUN NOMBRE : le coût du masquage

**Section à part, parce que c'est le trou qui décide de tout.**

Le masquage est le seul remède au canal 2 (§2.2), qui est le seul canal que la
cryptographie peut fermer. **Personne n'a mesuré ce qu'il coûte, et aucune source
atteignable ne publie ce nombre.**

**Ne pas l'estimer. L'écrire comme inconnu.** Une estimation inventée ici serait
exactement l'erreur de §1.1, rejouée : c'est ainsi que 1 316 491 est né et qu'il a
coûté la géométrie de C7.

Ce qui est connu et ce qui ne l'est pas :

- **Connu** : où le masquage doit vivre (lignes libres de la trace), combien de lignes
  il exige (**45** = 2·22+1), et que 1024 lignes en offrent **448**.
- **Inconnu** : le coût CU **côté vérifieur** d'une trace masquée ; le coût prouveur ;
  la taille de preuve ajoutée ; et si le vérifieur **déployé** (b7) accepte seulement
  une trace masquée — la mémoire `deep-ali-masking-verdict-and-cu-reconciled-2026-08-12`
  enregistre que **le vérifieur déployé échoue *fermé* sous masquage**, ce qui veut dire
  que le coût pourrait n'être pas seulement des CU mais **un redéploiement**.

### La mesure qui trancherait

Une seule expérience, dans cet ordre, et elle n'exige **aucun** redesign de C7 :

1. Prendre un circuit **déjà déployé et déjà mesuré** — C6, pin `888 220`
   (`cu_budget.rs:1338`, b7). Ne pas prendre C7 : C7 n'est pas déployé et ajouterait
   une inconnue à une mesure qui en isole une.
2. Étendre sa trace à `2×` lignes, remplir les lignes libres de valeurs **aléatoires**,
   et prouver.
3. Mesurer **trois** choses sur le vérifieur **b7 déployé**, pas sur HEAD :
   (a) CU phase 1, (b) CU phase 2, (c) **accepte ou rejette**.
4. Le delta contre `888 220` / `122 739` **est** le coût du masquage. `(c)` dit si un
   redéploiement fait partie du prix.

Un **contrôle positif** est obligatoire, comme pour
`zk_feasibility.rs` (mémoire `zk-feasibility-measured-2026-08-12`) : le test **doit
échouer** quand le prouveur devient réellement ZK. Sans contrôle positif, un vert ne
prouve rien — cette exacte erreur a déjà été payée quatre fois sur ce projet.

---

## 5. LE PROBLÈME DE BRANCHE

**C7 est écrit contre un vérifieur qui n'est pas celui qui tourne.**

| | HEAD `9d7a74c4` | `b7-drop-aligned-checks` (`836bc9cb`) |
|---|---|---|
| `verify.rs` | **4 743** lignes | **7 267** lignes |
| déployé sur devnet | non | **oui** |
| C7 (`stark/src/air/spend.rs`) | **oui** | non |
| pin CU `cu_budget.rs:1338` | **absent** | oui |

Divergence mesurée aujourd'hui sur `stark/` + `programs/p01_stark_verifier/` :
**111 commits sur b7 absents de HEAD**, **4 dans l'autre sens**. Les 4 sont
précisément le travail C7 de cette session (`b35bd7d2`, `cfcea041`, `1d69c0b0`,
`4a8f64c3`) — avant eux, ce chiffre était **1, et c'était un test**.

**Conséquence** : les 2 524 lignes de `verify.rs` qui manquent à HEAD sont le vérifieur
réel. Toute mesure CU prise sur HEAD ne dit rien de la chaîne. Toute contrainte C7
« vérifiée » sur HEAD n'a pas été vérifiée contre le binaire déployé.

Fait associé, à ne pas perdre : le vérifieur **déployé (b7) échoue FERMÉ** sur une
taille de domaine inconnue (`Err(UnsupportedDomainSize)`). **HEAD avait dérivé** vers un
`Felt::ONE` silencieux — corrigé en **`b35bd7d2`**. C'est-à-dire : HEAD acceptait
silencieusement ce que la chaîne rejette. Un exemple direct du risque ci-dessus.

---

## 6. CE QUI A ÉTÉ RÉFUTÉ — ne pas le reconstruire

Trois pistes ont été explorées et fermées. Chacune est séduisante, chacune reviendra si
elle n'est pas écrite ici.

### 6.1 Le masque public par ligne — RÉFUTÉ

L'idée : ajouter à chaque ligne un masque que le vérifieur **public** peut recalculer
et contrôler.

**Pourquoi c'est mort, en une phrase :
un masque qu'un vérifieur public peut vérifier est un masque qu'un observateur public
peut retirer.** Le vérifieur et l'observateur lisent exactement les mêmes octets — le
blob d'instruction data. Il n'existe aucune quantité que l'un calcule et l'autre pas.
Un masque n'a de valeur que s'il est **secret du prouveur**, donc invérifiable par
reconstruction, donc absorbé par les lignes libres et les ouvertures — ce qui ramène
au besoin de **45 lignes** de §1.2, c'est-à-dire au vrai masquage.

### 6.2 Le masque dérivé de Fiat-Shamir — RÉFUTÉ, causalement

L'idée : dériver le masque du challenge Fiat-Shamir, donc gratuitement et sans lignes
libres.

**Impossible dans l'ordre du temps, pas seulement difficile.** Le challenge Fiat-Shamir
est dérivé du **transcript**, et le transcript commence par la racine Merkle de la
trace : `stark/src/compact.rs` construit `root` puis étend le transcript
(`extend_transcript(&grinding_transcript, layer_root)` autour de `:4040`) avant de
dériver quoi que ce soit. **La trace est engagée avant qu'aucun challenge n'existe.**
Un masque qui dépend du challenge ne peut pas se trouver dans la trace déjà commise.
Ce n'est pas un problème d'ingénierie : c'est un cycle causal.

### 6.3 « C5 en 2-in-2-out pour tailler les frais dans la note » — RÉFUTÉ, mort au niveau du programme

L'idée (mémoire `research-fee-from-note-is-the-cure-2026-08-18`) : C5 est 2-in-2-out,
donc on paie la dénomination pleine au destinataire **et** on taille les frais dans une
note de monnaie — plus aucune arête externe, ce qui fermerait le canal 1 par
construction.

**C5 n'est utilisé que par `transfer_stark` et `unshield_stark`
(`programs/zk_shielded/src/instructions/`), et les deux ont été DÉSENREGISTRÉS au
commit `80e028ca`** (« fix(zk_shielded): unregister `unshield` and `transfer` — C5
proves no membership »). Il n'y a plus d'instruction appelable qui consomme C5.

La cure ne peut donc pas être bâtie sur C5 sans d'abord réparer et réenregistrer les
deux instructions — ce qui rouvre la classe **PERTE DE FONDS** documentée dans
`unshield-c5-no-membership-proof-2026-08-16` (C5 ne prouve **aucune** appartenance).
Le canal 1 doit être fermé par le câblage du financement (§2.1), pas par C5.

---

## 7. Le bug d'argent, tant qu'on y est : `sweep_fee_escrow`

**`sweep_fee_escrow` NE PEUT PAS FONCTIONNER.** Exécuté sur devnet le 2026-08-20,
signature :

```
4ruZQ5uksD6mGJ7rtZPcrGdBWJCbKYkCnD26qKtuGmxaSeb5g5dNFZvxVFhCLDjQ2Nbij2pVHpzHPAtgpUZJfqzU
```

Erreur : **`ExternalAccountLamportSpend`**. La cause est lisible dans le source :

```rust
programs/zk_shielded/src/instructions/sweep_fee_escrow.rs:41
    pub fee_escrow: SystemAccount<'info>,
programs/zk_shielded/src/instructions/sweep_fee_escrow.rs:117
    **escrow.try_borrow_mut_lamports()? -= amount;
```

Décrément direct de lamports sur un `SystemAccount` — un compte que le programme **ne
possède pas**. Le runtime refuse, toujours.

**0,151691 SOL de frais protocole sont inatteignables par le binaire déployé (un
redéploiement les récupère — ce n'est pas une perte), et chaque dépôt en
ajoute** (`shield_denominated_v3.rs:197`, `unshield_denominated_stark_v3.rs:159`
alimentent cet escrow). La campagne de dépôts qui tourne en ce moment **augmente ce
montant**.

---

## 8. LES RÉFÉRENCES — ce que chacune donne, et ce qu'elle ne donne pas

### eprint 2024/1037 — Haboeck & Al Kindi, « A note on adding zero-knowledge to STARKs »

- **Atteignable** : l'abstract **uniquement**. Le PDF n'a pas pu être récupéré.
- **Donne** : deux techniques nommées — (1) randomisation par des polynômes sur le
  corps de base, (2) décomposition du quotient.
- **Ne donne pas** : **aucun nombre.** Pas de coût vérifieur, pas de coût prouveur, pas
  de taille de preuve, pas de nombre de lignes. Cette référence **ne peut pas** clore
  §4.

### eprint 2025/1741 — Winterfell 0.12 sur Solana

- **Réel et directement pertinent** : vérification STARK mesurée sur Solana à
  **moyenne 1,10 × 10⁶ CU**, **max sous 1,19 × 10⁶**, **≈ 248,9 CU par octet de preuve**.
- **Donne** : la confirmation qu'un STARK Winterfell tient dans le budget CU Solana, et
  un coût par octet exploitable pour estimer l'effet d'une preuve plus grosse.
- **Ne donne pas** : **rien sur le masquage.** L'article ne traite pas le
  zero-knowledge. Il borne le coût de vérifier, pas celui de cacher.

**Conclusion sur les références** : la littérature atteignable confirme que
**vérifier** tient dans le budget, et reste **muette** sur ce que **masquer** coûte.
D'où §4.

---

## 9. Prochaine mesure, dans l'ordre

Chaque pas est une **mesure**, pas une édition. Il n'y a plus d'exception : le pas 1
de la première version de cette note prescrivait cinq lignes de Rust qui, vérification
faite dans le codegen d'Anchor, n'auraient rien acheté (§2.3, correction du 21-08).

1. ~~Canal 3~~ — **retiré**. Ni à corriger ni à mesurer : le correctif est un no-op sur
   un compte `init`, et le canal redit une valeur déjà publiée en clair par la même
   transaction. Le budget qui lui était destiné va au pas 3.
2. **Épingler les nombres de §3.2** dans `cu_budget.rs`, en commençant par **85 218**
   (deux instruments concordants). Un nombre non épinglé redevient un fantôme — c'est
   exactement le mécanisme de §1.1.
3. **La mesure du masquage** (§4), sur C6 et **contre b7 déployé**, avec contrôle
   positif obligatoire.
4. **Canal 1** : router le financement par le relais de déploiement, puis re-vérifier
   l'ancienneté de la plus vieille transaction du payeur de frais éphémère.
5. **Le problème de branche** (§5) : décider *où* C7 vit, avant d'écrire une ligne de
   C7 de plus. Aujourd'hui il est écrit contre un vérifieur qui n'existe pas en
   production.

**Ne pas faire** : redéployer, élargir la géométrie, ou « rendre tout ZK » avant que
§4 ait un nombre.

---

## Ce que ce document ne dit pas

Par discipline de maison — aucune phrase ici ne revendique une propriété que le code
n'a pas :

- Le pool **n'est pas** unlinkable aujourd'hui. Trois canaux sont ouverts (§2).
- C7 **n'est pas** déployé, **n'est pas** mesuré sur la chaîne, et **n'est pas** ZK.
- Le masquage **n'a pas** de coût connu (§4).
- Passer à 1024 lignes **rend le masquage possible** ; ça ne le réalise pas.
