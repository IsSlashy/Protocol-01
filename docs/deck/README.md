# Deck Castle DAO, 4 septembre 2026

Double-clic sur **`lancer-deck.bat`**. C'est tout.

Ou ouvre `castle-dao-2026-09-04.html` directement dans un navigateur : le
`.bat` ne fait rien de plus que ça, il existe pour que le geste soit évident et
pour rappeler les réglages d'export PDF.

## Pourquoi il n'a besoin de rien

Pas de serveur, pas de `npm install`, pas de réseau. La police Newsreader est
**inlinée** dans le fichier, 98 Ko au total.

C'est délibéré et ce n'est pas de la coquetterie : la version publiée en
artifact chargeait la police depuis un CDN. Sur une machine hors réseau, ou
derrière un pare-feu d'entreprise, ce chargement échoue **en silence** et la
page retombe sur Georgia. Le deck aurait changé de voix devant un investisseur
sans que personne remarque pourquoi. Un deck qu'on présente doit rendre pareil
partout, y compris dans une salle sans wifi.

## Exporter un PDF

`Ctrl+P`, destination « Enregistrer au format PDF », marges **Aucune**, et
⚠️ **cocher « Graphiques d'arrière-plan »** : sans ça la page sort en noir sur
blanc et le deck est illisible.

Les règles `@media print` du fichier retirent la hauteur d'écran, coupent entre
chaque planche et neutralisent les animations d'entrée, qui sinon figent des
éléments à opacité 0 sur le PDF.

🚨 **Le piège de l'export, mesuré sur le deck précédent.** Ses planches étaient
centrées verticalement dans une hauteur fixe avec `overflow: hidden` : une
planche plus haute que la page débordait **autant en haut qu'en bas**, et le
haut est l'endroit où se trouve le numéro de planche. Deux numéros sont sortis
coupés en deux. Rien ici n'a de hauteur fixe ni d'`overflow: hidden`, mais si
tu retouches la mise en page, vérifie les onze numéros **sur le PDF rendu**, pas
à l'écran : une planche mesurait 1168 px à l'écran et 1350 px à l'impression.

## Où vit ce deck

| | |
|---|---|
| Ici, versionné | `docs/deck/`, sur `master`. La copie qui suit les `git pull`. |
| Artifact publié | `https://claude.ai/code/artifact/8d6a53a9-7c19-4cd1-ba1e-669f294845dc` — privé par défaut, à partager explicitement |
| Hors dépôt | `Protocol-01-HQ\Network\styx-pitch-deck\` — la source d'origine et le deck générique du 11-08 |

⚠️ Les deux premières peuvent diverger. La version faisant foi pour une
présentation est **celle-ci**, parce que c'est celle qui rend hors ligne.

## Ce que le deck avance, et où le vérifier

Chaque chiffre a été mesuré, pas repris de mémoire. Si tu dois le défendre :

- **Feuille 72**, dépôt relayé du 22-08 : l'adresse de l'acheteur n'apparaît pas
  dans les clés de compte de la transaction. Relu par RPC.
- **10 programmes vivants**, 4 adresses nulles, slot 486 742 009.
- **47 notes non dépensées** sur 73 déposées, pool 1 SOL.
- **809 812 / 542 150 / 19 777 CU** pour les trois verdicts du vérifieur,
  documentés dans `README.md:291,318` avec leurs codes d'erreur.
- **Démo gelée** : branche `demo/castle-dao-2026-09-04`, tag
  `demo-castle-dao-v1`, 167,76 s de bout en bout.

⛔ La planche 10 est le registre des limites, et elle passe **avant** l'ask.
Ne pas l'enlever pour gagner une minute : c'est elle qui rend les neuf autres
crédibles, et c'est ce qui tient devant un juge autant que devant un
investisseur.
