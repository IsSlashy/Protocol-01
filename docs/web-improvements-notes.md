# protocol-01.dev — notes d'amélioration (2026-05-29)

> ## ⛔ BROUILLON PÉRIMÉ — NE PAS REPRENDRE LES FORMULATIONS
>
> **Annoté le 2026-08-17.** Ce document est un brouillon de copie de mai 2026. Ses
> suggestions d'ergonomie et de structure restent utiles ; **ses formulations ne
> le sont pas**. Il propose des promesses que le code contredit, mesurées depuis :
>
> | ce que le brouillon propose | ce qui est mesuré |
> |---|---|
> | « Nothing they can trace », « Move funds no one can trace » | depuis une dépense, **une commande** retrouve le dépôt et le portefeuille du déposant (sonde P4) |
> | « without anyone seeing who you are » | le portefeuille est atteint en **3 appels RPC** — le préfinancement et le balayage le nomment (sonde P6) |
> | « no on-chain link between the two » (Privacy Pools) | la dépense republie l'engagement que le dépôt a publié. C'est une propriété des entrées publiques du circuit ; aucun changement côté client ne l'enlève |
> | « nobody can link back » (Stealth Transfers) | reformulé le 2026-08-17 : l'adresse est à usage unique, et remonter au destinataire exige sa clé de visualisation |
> | « without the merchant or the chain seeing your wallet or the amount » | le montant du coffre d'abonnement est **on-chain** |
> | « readable only by you » (Confidential Balances) | `p01_zkspl` n'est **pas déployé** |
> | « no observer can trace the path end to end » (Multi-Hop) | jamais démontré |
>
> Le garde qui empêche ces phrases de revenir dans les dictionnaires est
> `apps/web/__tests__/lib/claims-lexicon.test.ts` — quatre règles, chacune avec
> son contrôle qui vérifie qu'elle mord. Une reprise mécanique d'un bullet
> ci-dessous le fera rougir, et c'est voulu.
>
> Le mot juste pour ce que le protocole livrera est **absence**, pas
> non-liabilité. Voir `verify/README.md` pour ce que l'outil prouve réellement.

Copy vit dans `apps/web/i18n/{en,fr,ja}.ts`. Composants : `Hero.tsx`, `Problem.tsx`, `CTA.tsx`, + la grille de features. Style copy : pas de tirets longs, pas de flèches ; le **gras** est OK ici (c'est voulu, cf. point 4).

---

## 1. Hero — être explicite sur LE QUOI

**Problème** : "EVERYTHING YOU NEED. NOTHING THEY CAN TRACE." est punchy mais vague. Un visiteur ne sait pas ce que fait le produit. anonmesh ("transact confidentially on Solana, message privately, no internet needed") et Umbra ("Incognito mode for your money") disent immédiatement le quoi.

**Reco** : garder la punchline en accroche, mais ajouter UNE ligne explicite juste en dessous.

- Punchline (gardée) : `Nothing they can trace.`
- Sous-ligne explicite (nouvelle), au choix :
  - `Pay, subscribe, send and swap on Solana without anyone seeing who you are, what you bought, or how much.`
  - ou plus court, façon Umbra : `Incognito mode for your money on Solana.`
- Garder ensuite : `Self-custody. Open source. No KYC.`

Idéalement une ligne de 3 verbes concrets pour ancrer l'usage : `Pay merchants. Subscribe privately. Move funds no one can trace.`

Fichier : clés hero dans `i18n/en.ts` (+ fr/ja).

---

## 2. Hero — bouton Download + mockup interactif

- **CTA primaire** = `Download the app` (lien APK v1.0.1 pour l'instant ; on basculera sur TestFlight plus tard, sans changer le wording). **CTA secondaire** = `Integrate the SDK` (vers la doc). C'est le combo gagnant d'Umbra (Download + Integrate SDK).
- **Mockup téléphone interactif** (discret) : rendre le téléphone à côté cliquable/swipeable pour faire défiler 3 vrais écrans (Shield, Subscribe privé, Stealth send). Affordance discrète : un petit point qui pulse + label `tap to explore` qui disparaît au premier tap. Ça augmente le temps passé et montre le produit réel au lieu d'une image figée.

Fichier : `CTA.tsx` / composant Hero + un petit state de carousel sur le mockup.

---

## 3. "One privacy stack" — une description par feature + meilleure présentation

**Reco présentation** : regrouper les 14 en 3 familles (Payments / Privacy primitives / Infrastructure) avec un sous-titre, plutôt qu'une grille plate de 14. Et une phrase simple sous chaque nom (langage normal, pas de jargon).

**Payments**
- **Auto-Shield** — Your funds slide into the private pool automatically, so your balance never sits exposed on the public ledger.
- **Private Subscriptions** — Pay recurring bills like Netflix without the merchant or the chain seeing your wallet or the amount.
- **Subscription Vaults** — An on-chain account that pays a fixed amount to a merchant over time, privately, and cancels when you want.
- **Token Swap** — Trade one token for another without broadcasting your move to front-runners.
- **Stealth Transfers** — Send to a one-time address that nobody can link back to the receiver's real wallet.

**Privacy primitives**
- **Privacy Pools** — Deposit into a shared pool and withdraw later with no on-chain link between the two.
- **ZK Proofs** — Math that proves a payment is valid without revealing any of its details.
- **Confidential Balances** — Token balances that stay encrypted on-chain, readable only by you.
- **Stealth Meta-Addresses** — One address you can share publicly; it spawns a fresh, unlinkable address for every payment you receive.
- **Note Splitting** — Split a private balance into smaller notes so a withdrawal never reveals your total.

**Infrastructure**
- **Multi-Hop Routing** — Payments bounce through several hops so no observer can trace the path end to end.
- **Privacy Router** — Automatically picks the best private path (relayer, hops, pool) for each transaction.
- **Service Registry** — Merchants register on-chain, so you can subscribe to real services privately, with no account.
- **AI Agent** — An on-device assistant that runs your privacy actions (shield, pay, rebalance) on command.

Fichier : composant grille de features + clés `i18n`.

---

## 4. Problem — mettre en gras les mots clés

Le texte plat ne fait pas ressortir le message. Mettre en gras les mots qui choquent.

> Traditional blockchains offer pseudonymity, **not privacy**. Every transaction you make creates a **permanent, public trail** that can be **traced back to you**, forever.

Autres endroits à graisser : montants visibles, "anyone can see", "forever", "linked to your identity".

**Détail technique** : les chaînes i18n rendues en texte brut n'affichent pas le gras. Deux options : (a) découper la phrase en segments + wrapper les mots clés dans un `<strong>` côté composant, ou (b) autoriser un mini-markdown (`**`) rendu via un petit parseur. Option (a) plus propre.

Fichier : `Problem.tsx` + clés `i18n`.

---

## 5. NOUVELLE section — "Pourquoi ça rapporte" (valeur concrète)

Manque une section qui dit à chaque audience ce qu'elle gagne. Trois colonnes.

**Traders & whales — accumulate or exit before the crowd does**
On a public chain, watchers track big wallets in real time. The moment a whale loads up, snipers pile in and front-run the entry; the moment it exits, the chain dumps with it. Here your accumulation, your size, and your exits stay invisible until you choose to reveal them. You trade on your information, not everyone else's.

**Merchants — get paid, prove the subscription, store nothing**
Accept private payments and verify a subscriber's license without ever holding their wallet or identity. No customer database to secure, no breach to leak, no compliance liability for data you never collected.

**Builders — ship privacy without building privacy**
Adding privacy yourself means hiring cryptographers, writing and auditing circuits, and running proving servers, relayers and indexers. With the SDK you import a few functions; the proofs, the encryption and the on-chain settlement are handled for you. You skip the multi-month build, the specialist hires, and the server and relayer running costs. Time to market goes from quarters to days, and the recurring infra bill is close to zero because the chain does the work.

(Note : pas de chiffres €/$ inventés. Rester sur le concret : pas de serveurs de preuve, pas d'embauche crypto, pas d'audit from scratch, time-to-market. C'est l'angle "Stripe pour la privacy" du pitch deck.)

Fichier : nouvelle section/composant + clés `i18n`.

---

## 6. CTA finale — "Initialize Protocol" → bouton Download

Le bouton final `Initialize Protocol` (qui mène à la doc) doit devenir le **bouton de téléchargement de l'app** (APK v1.0.1). La doc reste accessible en lien secondaire. On veut convertir le visiteur en utilisateur, pas en lecteur de doc.

- Primaire : `Download the app`
- Secondaire (petit lien) : `Read the docs` / `Integrate the SDK`

Fichier : composant CTA finale + `i18n`.

---

## Ordre d'impact suggéré
1. Hero explicite + CTA Download (points 1, 2, 6) — c'est ce qui convertit.
2. Section valeur concrète (point 5) — c'est ce qui vend.
3. Descriptions features + gras (points 3, 4) — c'est ce qui rassure et fait comprendre.
