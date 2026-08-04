# /pay — plan de refonte UX

**2026-08-04.** Écrit après le **premier parcours utilisateur complet de /pay jamais exécuté à la main** :
shield 1 SOL, retrait, balayage, puis abonnement, tous aboutis sur devnet contre le vérifieur coset
déployé le même jour. Tout ce qui suit est une **observation**, pas une hypothèse de design. Chaque défaut
cité a été rencontré, et huit correctifs sont déjà partis dans la foulée.

Ce document dit quoi construire et dans quel ordre. Il ne dit pas à quoi ça ressemble : la direction
visuelle reste à trancher.

---

## 1. Le diagnostic, par ordre de gravité pour l'utilisateur

### D1 — On ne peut pas distinguer « ça travaille » de « c'est planté »
Un shield ou un abonnement dure **plusieurs minutes** : ~162 transactions de chunk, deux preuves STARK
d'environ 60 s chacune, une reconstruction d'arbre. Pendant tout ce temps l'interface affiche une phrase
qui ne bouge pas, par exemple `Scanning the 0.1 SOL pool...`.

Preuve que le problème est réel et pas théorique : **je m'y suis trompé moi-même** en croyant le scan
bloqué, et j'ai relancé un agent deux fois pour rien sur la même illusion.

Aggravant : le scan du pool est **combinatoire** — `poolNotes.ts:117-126` énumère toute la fenêtre
d'epochs candidats, par note, sur six dénominations. Il ne finit pas dans un temps qu'un humain attend.

### D2 — Des boutons désactivés qui ne disent pas pourquoi
`SubscribePanel` calculait `busy = submitting || scanning`. Le bouton restait donc gris **indéfiniment**,
avec un fournisseur choisi, une note choisie, et son propre libellé affichant « Escrow 1 SOL with
Bitwarden Test ». `blockedReason` était nul, donc **rien à l'écran ne pouvait l'expliquer**.

🚨 **Règle à graver : aucun bouton d'action ne doit être conditionné à `scanning`.** Seuls les boutons
« Rescan » y ont droit. L'erreur a été commise deux fois dans la même soirée, dont une par moi.

### D3 — Ce que l'utilisateur a fait n'existe nulle part
Un abonnement a été créé — vault `7WaBm7Kq…`, 1 SOL séquestré, clé `P01-JKYH-…` — et **l'interface n'en
garde aucune trace**. Pas de liste, pas de détail, pas de moyen de retrouver la clé. Le mobile, lui, a
déjà `subscription-vaults.tsx` et `vault-detail.tsx`.

### D4 — Les états se contredisent à l'écran
Vu simultanément : « Shielded balance 0 SOL » et « 2 unspent notes · 2 stored locally ». Plus la mention
`unconfirmed` sans explication de ce qui la lèvera, ni de quand.

### D5 — Le mur de texte noie l'action
Chaque onglet ouvre sur cinq paragraphes de divulgation. **Ce contenu est juste et doit rester** — c'est
l'honnêteté du produit et elle a été durement gagnée. Mais il est servi en bloc, avant l'action, à chaque
visite, y compris à la centième.

### D6 — Le vocabulaire est celui du protocole, pas celui de l'utilisateur
« leaf #19 », « commitment 150061…7923 », « proof-buffer rent », « nullifier ». Exact, et illisible pour
qui n'a pas écrit le circuit.

---

## 2. Priorité 1 — Une progression qui dit la vérité

**C'est faisable dès maintenant et sans deviner.** Le worker émet déjà ~30 étapes nommées via
`onProgress`, et le nombre de chunks est **connu à l'avance** (`totalChunks`).

Découpage proposé, avec des poids tirés des durées réellement mesurées ce soir :

| phase | étapes émises | poids |
|---|---|---|
| Lecture de l'arbre | `Fetching pool leaves…`, `Matching notes…`, `Reading on-chain tree state…` | 15 % |
| Preuve C1 | `Generating C1 (pool_commitment) STARK proof…` | 20 % |
| Téléversement C1 | `Uploading proof chunk i/N` — **progression réelle** | 25 % |
| Preuve C3 | `Generating C3 (merkle_path) STARK proof…` | 15 % |
| Téléversement C3 | `Uploading proof chunk i/N` — **progression réelle** | 20 % |
| Vérification + envoi | `Verifying…`, `Opening the subscription vault…` | 5 % |

Exigences :
1. **Afficher les étapes suivantes**, pas seulement l'étape courante. L'utilisateur doit voir où il en est
   dans un chemin dont il connaît la longueur.
2. **Un temps restant estimé**, recalculé sur la vitesse observée des chunks plutôt que sur une constante.
3. **Dire ce qui est en jeu** pendant l'attente : « ~1 SOL de caution immobilisée, rendue à la fermeture ».
4. **Ne jamais mentir sur un échec.** Un 429 pendant la vérification n'est pas un rejet — cette distinction
   a déjà sauvé une porte de déploiement le même jour.

---

## 3. Priorité 2 — Les abonnements doivent exister dans l'interface

Parité avec le mobile, qui affiche déjà : **Status · Retailer · Total Deposited · Rate · Claimed Periods**,
plus Pause et Resume.

Le web doit ajouter, parce que son parcours est différent :
- **La clé de licence**, re-dérivable du secret de la note et donc jamais stockée. Dire les deux choses :
  qu'elle se recalcule sur n'importe quel appareil tenant le secret, **et** que c'est un titre au porteur.
- **Les périodes restantes** et la date de fin estimée, calculées depuis `claimed / total` et
  `intervalSlots`.
- **Le lien explorateur** du vault et de la transaction d'ouverture.
- ⚠️ **Rappeler l'irréversibilité** : `claim_period` est la seule instruction qui ferme un vault, et au
  dernier claim le solde restant, la poussière et le rent partent au marchand. Aucune annulation, aucun
  remboursement. Cette phrase doit être visible sur le détail, pas seulement avant l'achat.
- 🚨 **Les vaults existent en trois tailles.** Toute lecture passe par `data_len()`, jamais par `LEN`.

---

## 4. Priorité 3 — La divulgation sans le mur

Contrainte non négociable : **le contenu reste vrai et reste accessible.** Ce qui change, c'est la
livraison.

- Un **résumé d'une ligne** par onglet, toujours visible : « Les montants sont cachés. L'appariement
  dépôt-retrait ne l'est pas. »
- Le détail derrière un dépli, **ouvert par défaut à la première visite**, refermé ensuite.
- ⛔ Ne jamais résumer au point de rendre la phrase fausse. L'ensemble d'anonymat vaut **1** ; aucune
  formulation ne doit laisser croire autre chose.

---

## 5. Priorité 4 — Des états qui se nomment

- Un bouton désactivé **affiche toujours sa raison**, à côté de lui.
- « unconfirmed » devient « vérification en cours contre la chaîne », avec ce qui la lèvera.
- Le solde et le compte de notes ne peuvent plus se contredire : un seul état source.
- Le vocabulaire protocolaire passe au second plan — « note de 1 SOL » devant, `leaf #19` en détail.

---

## 6. Ce qui n'est PAS dans ce plan

- **Aucune promesse de privacy nouvelle.** La refonte ne change rien à ce que le protocole cache. Toute
  formulation qui donnerait à croire le contraire est un défaut, pas une amélioration.
- **Pas de refonte du worker ni du chemin de preuve.** Le scan combinatoire est un problème réel, mais
  c'est un chantier séparé, avec ses propres mesures.

---

## 7. À trancher par le fondateur

1. **Direction visuelle** : on garde le vocabulaire actuel (sombre, cyan, monospace) ou on repart d'une
   direction neuve ?
2. **Le mobile est-il la référence** à égaler, ou le web doit-il diverger ?
3. **Le scan combinatoire** : on l'accepte en le rendant lisible, ou on ouvre le chantier de sa
   réécriture ?

---

Mesures d'appui : [[pay-web-proven-end-to-end-2026-08-04]] pour les chiffres du parcours,
[[b7-reship-landed-gate-4-to-1-2026-08-04]] pour l'état du vérifieur déployé.
