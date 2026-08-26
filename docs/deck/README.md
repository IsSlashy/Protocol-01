# Les decks

Deux decks, deux formats, un seul système visuel. Double-clic sur
**`lancer-deck.bat`** pour le long, ou ouvre le fichier voulu dans un
navigateur.

| Fichier | Format | Pour qui |
|---|---|---|
| `hackathon-3min-2026-09-04.html` | **7 planches présentées en 180 s**, puis 10 planches d'annexe qui ne sont jamais présentées | Jury de hackathon, créneau court, questions après |
| `castle-dao-2026-09-04.html` | 11 planches, lecture longue | Investisseur qui lit seul, ou créneau de 8 à 10 minutes |

Chacun a son PDF à côté, exporté et vérifié page par page.

## Pourquoi le format court existe

Le template Superteam qu'on nous a demandé d'analyser porte, une fois les
doublons de variantes retirés, **369 mots à l'écran sur 12 planches**. En 180
secondes, à 145 mots par minute, un présentateur en prononce **435**. Lire les
planches à voix haute mangerait 85 % du temps de parole, et il ne resterait rien
pour le pitch.

Le même test appliqué au deck long donne **1 156 mots sur 11 planches**. Il est
bon, mais il est fait pour être lu, pas présenté en trois minutes.

Le format court tient parce qu'il a été **coupé à l'horloge, pas à l'œil** :

- **110 mots à l'écran** sur les 7 planches présentées, contre 369 pour le
  template et 1 156 pour le deck long.
- **398 mots prononcés**, soit 165 s sur un budget de 180. Les 15 s de marge
  sont pour la démo, seul endroit où un run peut caler.
- **Chaque planche porte son horloge**, en haut à droite, à côté de son numéro.
  Un deck construit pour un créneau doit montrer le créneau.
- **Une affirmation par planche.** Ce qui est écrit sous le titre est la preuve
  que l'orateur énonce, pas un texte que la salle doit lire.

⚠️ Les plafonds ne sont pas décoratifs : `src/build-deck.py` **compte les mots à
chaque build** et sort `WORD CAPS: VIOLATED` si une planche dépasse. Le compte
exclut deux choses, et le dit : la mention légale en pied de planche 01, et la
transcription du terminal en planche 03, qui est l'objet qu'on regarde, pas un
texte à lire.

## Régénérer le deck court

```bash
python docs/deck/src/make-head.py    # extrait l'en-tete du deck long, une fois
python docs/deck/src/build-deck.py docs/deck/src docs/deck/hackathon-3min-2026-09-04.html
```

Le texte des planches vit dans `src/plates.py`, jamais dans le HTML. `src/` porte
aussi `deck-extra.css`, les ajouts au système Styx.

🧠 Le deck court **ne contient pas sa propre copie du système visuel**. Il prend
l'en-tête du deck long tel quel, police inlinée comprise, ce qui veut dire deux
choses : les deux decks ne peuvent pas diverger, et la police n'est stockée
qu'une fois dans le dépôt. `deck-head.html` est donc un fichier **dérivé**, non
versionné, que `make-head.py` régénère en une seconde.

`three-minute-script.md` est lui aussi **généré**, depuis `plates.py`, donc le
script parlé ne peut pas diverger des planches.

## Ce que la planche 03 montre, et pourquoi

`demo/merchant-gate.mjs`, mesuré à **273 ms**, sans clé, sans SOL, sans compte,
depuis un dossier vide.

🚨 **Elle prouve l'habilitation, pas la confidentialité**, et la planche le dit
en toutes lettres. Son premier appel est un `getProgramAccounts`, c'est-à-dire
exactement la fuite d'énumération que l'annexe A8 reconnaît. Un juré qui le
repère seul a attrapé le deck en train de survendre ; autant le dire avant lui.
La revendication de confidentialité est un autre objet : le dépôt en feuille 72,
et `verify/p01-verify.mjs`, qui tourne **hors ligne** en une seconde et rapporte
notre propre fuite d'engagement v3 en **FAIL**, exprès.

⛔ Le run de bout en bout à 167,76 s **n'est pas la démo** : il ne tient pas dans
180 secondes, et surtout la branche `demo/castle-dao-2026-09-04` et le tag
`demo-castle-dao-v1` **n'existent pas dans ce dépôt**. Le chiffre reste en annexe
A3, avec cette réserve écrite à côté.

## Exporter un PDF

Le fichier court porte déjà les deux correctifs d'impression, donc `Ctrl+P`,
marges **Aucune**, suffit. Le deck long a toujours besoin qu'on **coche
« Graphiques d'arrière-plan »**, sinon la page sort en noir sur blanc.

🚨 **Le piège de l'export, mesuré.** Les planches du deck de juillet étaient
centrées dans une hauteur fixe avec `overflow: hidden` : une planche plus haute
que la page débordait autant en haut qu'en bas, et le haut porte le numéro de
planche. Deux numéros sont sortis coupés en deux. Vérifie toujours les numéros
**sur le PDF rendu**, jamais à l'écran : une planche mesurait 1168 px à l'écran
et 1350 px à l'impression.

## Où vivent ces decks

| | |
|---|---|
| Ici, versionné | `docs/deck/`, la copie qui suit les `git pull` et qui rend hors ligne |
| Artifact, deck court | `https://claude.ai/code/artifact/7999f47a-a697-4289-8e60-0fcd5d2d2b88` |
| Artifact, deck long | `https://claude.ai/code/artifact/8d6a53a9-7c19-4cd1-ba1e-669f294845dc` |
| Hors dépôt | `Protocol-01-HQ\Network\styx-pitch-deck\` — la source d'origine et le deck générique du 11-08 |

⚠️ Ces copies peuvent diverger. La version faisant foi pour une présentation est
celle du dépôt : c'est la seule où la police Newsreader est **inlinée**. Un
`<link>` vers un hôte de polices échoue **en silence** derrière un pare-feu, et
le deck change de voix devant un investisseur sans que personne comprenne
pourquoi.

## Les dix lignes qu'on n'écrit plus

Écrites, mesurées contre le dépôt, coupées. Chacune tombe à la première question,
et la liste complète avec ses preuves est dans `three-minute-script.md` :

- « un test en CI vérifie que l'acheteur est absent » : l'assertion existe, mais
  sa suite est `describe.skipIf(!LIVE)` derrière `P01_LIVE_RELAY=1`, que la CI ne
  pose jamais.
- « 77 965 octets contre 258 958 » : 258 958 est la paire d'**avant** B4. Mesuré
  aujourd'hui, C1+C3 = **147 038**. Le gain est 1,9x, pas 3,3x.
- « 167,76 s de bout en bout » : le run a eu lieu, le gel nommé pour lui n'existe
  pas dans le dépôt.
- « une preuve fait maintenant le travail de deux » : C7 est **mesuré**, pas
  déployé.
- « notre commission est de 1 % » : 1 % opérateur **plus** 0,3 % de frais de
  shield on-chain, soit 1,3 % aujourd'hui sur un dépôt relayé de 1 SOL.
- « un ensemble d'anonymat de 47 » : 47 est un **plafond**. L'ensemble effectif
  est de **un**, parce que chaque dépense déployée republie l'engagement que son
  dépôt avait déjà publié.
- « dix programmes vivants » sans le dénominateur : toujours **10 sur 14**.
- toute phrase contenant *annuler* ou *renouveler* : aucune des deux instructions
  n'existe, et A9 le dit.
- « aucun dossier client nulle part » : vrai du marchand, faux de la chaîne. Le
  paiement de l'acheteur vers la caisse, un saut plus tôt, nomme son portefeuille.

## Les deux registres de limites

⛔ **A8** porte les limites de confidentialité et de cryptographie, **A9** les
limites d'exploitation : une seule clé peut remplacer les dix-huit programmes
déployés, un abonnement ne peut être ni renouvelé ni annulé, le drapeau
`is_active` de la chaîne est faux, et l'opérateur du relais voit ce que la chaîne
ne voit pas.

Elles ne sont pas présentées, mais elles sont ce qui rend les sept autres
planches crédibles quand un juré ouvre l'annexe. Ne pas les alléger.

## Deux commentaires du dépôt à corriger

La passe adversariale a trouvé que **`258 958` octets est la taille de la paire
C1+C3 d'AVANT** le changement B4 pair-leaf du 28 juillet. Mesurée aujourd'hui :
C1 68 881 + C3 78 157 = **147 038**, confirmée par un scan on-chain d'un vrai
upload (`verify/README.md:261`, 172 tx, 148 chunks). Le gain de C7 est **1,9x**,
pas 3,3x.

Le deck est corrigé. Trois commentaires du dépôt portent encore le chiffre
périmé, sans test derrière : `stark/src/compact.rs:5105`,
`programs/zk_shielded/src/lib.rs:391`,
`programs/p01_stark_verifier/src/compact_proof.rs:263`.
