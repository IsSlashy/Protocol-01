# Séquence X — STRK20 comme point d'entrée vers la waitlist

Contexte: STRK20 (privacy native sur Starknet) valide publiquement la catégorie.
Slashy est builder sélectionné au buildathon Starknet Foundation du 22/07.
Objectif: capter l'attention builders/ZK et convertir vers la waitlist protocol-01.dev.

Style appliqué: pas de gras, pas de tirets cadratins, pas de flèches, angle humain avant la technique.

---

## Pourquoi cette séquence et pas un thread d'analyse

Le réflexe serait de commenter la news STRK20. Mauvais calcul: l'audience STRK20
est sur Starknet, le produit est sur Solana, et un commentaire de plus sur une
annonce de mars n'apporte rien.

Ce qui n'est pas copiable, c'est la participation. Dix builders sélectionnés, une
journée, un résultat. On part de là. La news sert de contexte, pas de sujet.

Corollaire de timing: le post le plus fort est celui du 22 au soir avec un
résultat réel, pas l'annonce de la veille.

---

## Post 1 — mardi soir, mise en place

Court, aucun call to action, sert uniquement à exister avant le résultat.

```
Demain je suis à Paris au buildathon privacy de la Starknet Foundation.
Dix builders, douze heures.

Je construis une couche de découverte de destinataire post-quantique.

Traduction: aujourd'hui, quand tu reçois un paiement privé, la partie qui dit
"c'est pour toi" est chiffrée avec de la crypto que les ordinateurs quantiques
casseront. Le montant est protégé. Le destinataire, pas pour toujours.

Résultat demain soir.
```

---

## Post 2 — le thread principal, mercredi soir

À poster une fois le résultat en main. Le beat 5 se remplit avec ce qui a
réellement tourné dans la journée.

```
1/
Starknet a rendu la confidentialité native pour ses tokens. Un L2 majeur vient
de décider que la vie privée n'est plus une case à cocher.

Meilleure nouvelle de l'année pour qui construit là-dedans. Et elle rend un
autre problème beaucoup plus urgent.
```

```
2/
Tout ce qu'un système privé publie on-chain est public et permanent.

Les montants sont chiffrés, très bien. Mais la partie qui désigne le
destinataire repose encore sur de la cryptographie à courbe elliptique.

Cassez la courbe en 2035, vous désanonymisez rétroactivement tout l'historique.
```

```
3/
Ce n'est pas une hypothèse de laboratoire. L'ANSSI et l'Union européenne ont
posé une date: migration post-quantique d'ici 2030.

Un produit qui vend de la confidentialité sans réponse là-dessus vend quelque
chose qui a une date de péremption.
```

```
4/
Je construis cette couche depuis fin janvier, seul.

ML-KEM-768, standard NIST. L'émetteur ne connaît qu'une méta-adresse. Le
destinataire retrouve son paiement en scannant. Aucune courbe elliptique dans
la découverte du destinataire.

Publié sur npm, prouvé de bout en bout sur Solana devnet.
```

```
5/
Aujourd'hui, au buildathon de la Starknet Foundation, j'ai prouvé que cette
couche ne dépend pas d'une chaîne.

[RÉSULTAT RÉEL DU JOUR: ce qui a tourné, sur quel réseau, avec la capture]

Deux chaînes, le même cœur cryptographique, un adaptateur de transport.
```

```
6/
La confidentialité devient l'infrastructure par défaut. C'est acté.

Ce qui ne l'est pas, c'est qu'elle tienne plus de dix ans.

Je construis un wallet là-dessus, et j'ouvre par vagues.
protocol-01.dev
```

---

## Posts autonomes, à dégainer n'importe quand

### A. La prise de position technique (meilleure portée builders)

```
Toutes les discussions sur la privacy portent sur comment cacher les montants.

Presque personne ne parle de la partie qui désigne le destinataire.

C'est pourtant la seule qui reste déchiffrable rétroactivement le jour où la
courbe tombe. Le montant d'un café en 2026 n'intéressera personne en 2035.
Savoir qui payait qui, si.
```

### B. La crédibilité par l'honnêteté (le plus fort des trois)

```
Depuis fin janvier, seul:

Sept circuits STARK sans trusted setup, vérifiés on-chain.
Un prover qui tourne sur mobile.
Une couche de découverte de destinataire post-quantique publiée sur npm.
Un audit de soundness lancé après le bug Orchard de Zcash. Il a trouvé des
circuits sous-contraints chez moi. Corrigés, redéployés, retestés on-chain.

Rien sur mainnet. Devnet, et je le dis avant qu'on me le demande.
```

### C. Le post waitlist qui se suffit à lui-même

```
J'ai coupé les téléchargements publics de l'app.

À la place, une liste d'attente. J'ouvre par vagues et je veux parler aux
premiers utilisateurs un par un, plutôt que de compter des installations que
personne n'ouvre.

protocol-01.dev
```

---

## Règles d'exécution

Mentions. Remercier et mentionner la Starknet Foundation sur les posts de
participation et de résultat. Ne pas les mentionner sur les beats qui pointent
ce qui manque dans leur pile. La critique passe en public, la mention la
transforme en interpellation.

Formulation à ne jamais utiliser. "STRK20 n'est pas post-quantique" est faux,
leur système de preuve est basé sur des hashes et survit. Dire plutôt: ce qui
ne survit pas, c'est ce qui est chiffré sur courbe et publié on-chain de façon
permanente.

Jamais non plus: "les STARK sont immunisés". Les circuits sous-contraints
existent aussi en STARK, tu en as trouvé chez toi.

Call to action. Une ligne, à la fin, jamais le sujet du post. Un thread qui
existe pour placer un lien se lit comme une publicité et ne circule pas.

Mesure. La source d'inscription est déjà enregistrée. Les signups arrivés par
ces posts remonteront dans le tableau de bord, et le bilan des deux semaines
dira si le canal vaut la peine d'être répété. Pour isoler X du reste, utiliser
le lien protocol-01.dev/?src=x et non le lien nu.
