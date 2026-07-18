# Roadmap Buildathon Starknet — Privacy focused Buildathon Paris

Mercredi 22 juillet 2026, 9h00-21h00 UTC+2. 62 Rue Jean-Jacques Rousseau, Paris.
Format: ~10 builders, sprint 12h, demo en fin de journée, prototype avec le STRK20 SDK.
Enjeu: fast-track vers l'incubator "Proof of Privacy" (candidature Proof Program déjà accusée le 14/07).

## 1. Le projet

**Specter for STRK20: découverte de destinataire post-quantum pour les transferts privés STRK20.**

One-liner: STRK20 chiffre les montants et les soldes, mais la couche qui dit "qui reçoit" repose sur de la cryptographie courbe elliptique. Tout ce qui est posté on-chain aujourd'hui est déchiffrable rétroactivement le jour où un ordinateur quantique existe (harvest-now-decrypt-later). On apporte la couche de découverte de destinataire ML-KEM que l'on a déjà construite, prouvée e2e sur Solana devnet, et on la branche sur STRK20.

Pourquoi ce projet et pas un autre:

- StarkWare a publié sa propre roadmap post-quantum (30 juin 2026): BLAKE2 pour les state commitments, Falcon-512 pour les signatures de consensus. Leur roadmap couvre les hashes et le consensus, PAS la couche note-encryption / recipient-discovery de STRK20. On comble un trou qu'ils ont eux-mêmes documenté. La homepage strk20.starknet.io pointe vers cette roadmap PQ.
- Le harvest-now-decrypt-later est pire pour un privacy pool que pour une chaîne publique: les ciphertexts des notes sont éternels et publics. Casser la courbe dans 10 ans = désanonymiser rétroactivement tout l'historique du pool. C'est l'argument qui justifie l'urgence devant le jury.
- On ne construit presque rien de neuf: le cœur crypto existe dans specter-sdk 0.4.1 et tourne en prod devnet sur Solana. Le buildathon sert à prouver que la couche est chain-agnostic. Narrative incubator: "PQ privacy, cross-chain, déjà shippé ailleurs".

## 2. Ce qui est RÉUTILISÉ (zéro ligne nouvelle)

Tout vient de `packages/specter-sdk` (0.4.1, publié npm, prouvé e2e via API publique le 17/07):

| Composant | Fichiers | Rôle |
|---|---|---|
| Meta-addresses stealth | `src/stealth/generate.ts`, `derive.ts` | Génération adresse furtive + clés one-time |
| Scan destinataire | `src/stealth/scan.ts` | Détection des annonces qui nous sont destinées |
| Encodage annonce chunkée | `src/stealth/announcement-v2.ts` | Découpage ciphertext KEM en chunks on-chain |
| ML-KEM-768 | `src/quantum/` + `@noble/post-quantum` | Encapsulation PQ du secret partagé |
| Hashes/courbes | `@noble/hashes`, `@noble/curves` | Primitives auditées, déjà en dépendance |

Règle du jour: si un besoin peut être couvert par un de ces modules, on ne réécrit pas.

## 3. Ce qui est AJOUTÉ (chaque ajout justifié)

Trois ajouts, pas un de plus.

**A. Contrat Cairo `pq_announcer` (~100-150 lignes).**
Justification: le transport actuel est un programme Solana (FgKh, chunked KEM announcement). Un programme Solana ne tourne pas sur Starknet. C'est LE seul composant chain-specific de toute la stack, donc le seul qu'il est légitime de réécrire. Périmètre strict: stocker/émettre les chunks de ciphertext KEM en events Cairo, rien d'autre. Pas de logique métier, pas de token, pas de note.

**B. Adapter `StarknetTransport` dans specter-sdk (~150 lignes TS).**
Justification: specter-sdk parle à Solana via web3.js. Il faut le même contrat d'interface (publish announcement / scan announcements) en starknet.js pour brancher le cœur crypto inchangé sur le contrat A. C'est un adapter I/O, zéro crypto nouvelle. Bonus vendeur: l'existence de deux transports prouve l'architecture chain-agnostic.

**C. Glue STRK20 SDK (Privacy Wallet API 0.10.3 via starknet.js).**
Justification: c'est le SDK imposé par l'événement, et c'est lui qui fait le travail privacy (notes chiffrées, preuves client-side, nullifiers). On ne touche pas à leur système: notre couche décide QUI reçoit (échange de clés PQ + adresse furtive), leur SDK exécute le transfert privé vers cette adresse. Séparation nette: eux = confidentialité des montants, nous = confidentialité et pérennité PQ du destinataire.

**Anti-lambda — ce qu'on n'ajoute PAS et pourquoi:**
- Pas de nouveau système de notes: STRK20 en a un, en refaire un = mixer maison, disqualifiant.
- Pas de prover maison: les preuves sont gérées par le wallet via la Wallet API.
- Pas de relayer: hors périmètre 12h, notre infra Railway existante ne sert à rien ici.
- Pas de token demo custom sauf si strkBTC/STRK20 indisponible sur testnet (voir risques).
- Pas de front élaboré: une page demo minimale, le jury juge le flux crypto, pas le CSS.
- Pas de WOTS+/signatures PQ: Falcon-512 est déjà sur la roadmap StarkWare côté consensus, et l'account abstraction Starknet permet déjà des signers custom. Notre valeur = le KEM de découverte, on ne se disperse pas.

## 4. Architecture cible (fin de journée)

```
Destinataire                         Émetteur
  meta-address (stealth/generate)      |
  + pubkey ML-KEM ————— publiée ————→  encapsule (quantum/)
                                       dérive adresse furtive (stealth/derive)
                                       chunks ciphertext (announcement-v2)
                                       |
                                  [Cairo pq_announcer]  ← events sur Sepolia
                                       |
  scan events (StarknetTransport + stealth/scan)
  décapsule → retrouve la clé one-time
  reçoit le transfert privé STRK20 sur l'adresse furtive
  (shield/transfer via Privacy Wallet API)
```

## 5. Pré-event — J-4 à J-1 (18-21 juillet)

**J-4 (aujourd'hui, vendredi 18):**
- [ ] URGENT: accès STRK20 SDK. Le site dit "reach out". Envoyer la demande via strk20.starknet.io ET poster sur le chat Luma de l'événement en mentionnant Protocol 01 / Proof Program. Sans réponse d'ici lundi, le plan B (section risques) s'applique et le jour J les équipes SDK sont sur place.
- [ ] Installer la toolchain: `scarb` (via asdf ou installer Windows), `starknet-foundry` (snforge + sncast), `starknet-devnet` local. Vérifier que ça compile un hello-world.

**J-3 / J-2 (samedi-dimanche):**
- [ ] Wallet Starknet (Argent X ou Braavos) + compte Sepolia + faucet STRK.
- [ ] Contrat Cairo hello-world avec un event, déployé sur Sepolia via sncast. Objectif: le workflow declare/deploy/invoke/events est rodé AVANT le jour J. Le contrat réel s'écrit sur place.
- [ ] **Découplage specter-sdk (tâche principale de la prep, ~3-5h).** État vérifié le 18/07: `quantum/` est 100% chain-agnostic (zéro import Solana), mais `stealth/` a 117 références `PublicKey`/`Connection`/`@solana/web3` réparties sur les 8 fichiers (generate, derive, scan, announcement-v2 inclus). Plan: extraire le cœur mathématique (clés en `Uint8Array` au lieu de `PublicKey`, encodage annonce en bytes purs, interface `AnnouncementTransport` publish/scan) dans un module `stealth/core` sans dépendance chaîne; les fichiers actuels deviennent des wrappers Solana. Faire tourner les tests existants (`index.test.ts`, `parity-crypto-v2.test.ts`) après refactor pour prouver zéro régression. Si le refactor déborde, plan B: ne PAS toucher specter-sdk, copier les ~4 fonctions de dérivation dans le repo buildathon en important seulement `quantum/` + `@noble/*` (moins propre, mais le jour J n'en dépend plus).
- [ ] Lire la spec Privacy Wallet API 0.10.3 + doc STRK20 SDK si accès obtenu. Noter les appels exacts shield/transfer/claim.

**J-1 (lundi/mardi):**
- [ ] Repo `specter-strk20` prêt: workspace pnpm avec specter-sdk en dépendance + dossier `cairo/` vide + page demo squelette (deux panneaux émetteur/destinataire, boutons morts).
- [ ] Laptop: vérifier que tout tourne SUR LE LAPTOP (mémoire trip Dublin: laptop = machine active possible). Node, scarb, sncast, wallet extension, repo cloné, `pnpm install` fait, devnet local qui boote. Le venue a du wifi, pas ton setup.
- [ ] Backup: exporter les clés Sepolia, snapshot du repo sur clé USB ou GitHub privé.

## 6. Jour J — planning heure par heure

| Heure | Bloc | Détail | Critère de sortie |
|---|---|---|---|
| 9h00-9h30 | Arrivée, brief | Choper un contact équipe STRK20 SDK, valider l'accès SDK/testnet | SDK utilisable confirmé ou plan B activé |
| 9h30-11h00 | Contrat Cairo | `pq_announcer`: fn announce(chunks) + event AnnouncementChunk, tests snforge, deploy Sepolia | Event visible dans l'explorer |
| 11h00-13h00 | Adapter TS | `StarknetTransport`: publish (invoke) + scan (get_events starknet.js) | Round-trip announce→scan en script local |
| 13h00-13h30 | Déjeuner | Laisser tourner un test e2e en boucle pendant la pause | |
| 13h30-15h30 | Handshake PQ e2e | keygen destinataire → encapsulation → announce on-chain → scan → décapsulation → même secret des deux côtés | Test vert sur Sepolia, pas devnet |
| 15h30-17h30 | Intégration STRK20 | Transfert privé STRK20 vers l'adresse furtive dérivée; claim côté destinataire via Wallet API | Un transfert shielded reçu sur adresse PQ-découverte |
| 17h30-18h30 | Demo page + vidéo | Brancher les deux panneaux sur le vrai flux; ENREGISTRER une vidéo du flux complet qui marche | Vidéo backup en boîte |
| 18h30-19h30 | Buffer | Absorbe les débordements (il y en aura). Si tout est vert: polish page demo | |
| 19h30-20h00 | Pitch prep | Répéter le pitch 3 min, câbler le laptop | |
| 20h00-21h00 | Demos | | |

Règle de coupe (si retard): le MVP défendable = handshake PQ e2e on-chain Sepolia (fin bloc 13h30-15h30). L'intégration STRK20 complète est le stretch. Si à 16h30 le claim STRK20 ne passe pas, on gèle, on démontre le handshake PQ + un transfert STRK20 séparé, et on explique le branchement. Ne jamais sacrifier la vidéo backup de 17h30.

## 7. Risques et plans B

| Risque | Probabilité | Plan B |
|---|---|---|
| STRK20 SDK gated, pas d'accès | Moyenne | Les équipes SDK sont sur place le jour J (dit explicitement sur la page Luma). Sinon: demo du handshake PQ + transfert vers l'adresse furtive avec un ERC-20 Sepolia standard, en montrant le point de branchement exact. La valeur (couche PQ) est intacte. |
| STRK20 pas déployé sur Sepolia (mainnet only) | Moyenne | Même plan B; ou starknet-devnet en local avec un mock d'interface minimal. On le dit honnêtement au jury. |
| Cairo nous ralentit (syntaxe, tooling) | Moyenne | Prep J-3: hello-world + events déjà rodés. Le contrat fait une seule chose. Demander de l'aide aux devs StarkWare sur place, c'est fait pour ça. |
| Wifi/RPC venue instable | Faible | starknet-devnet local pour développer, Sepolia uniquement pour les runs de validation. Hotspot téléphone en secours. |
| Laptop | Faible | Tout vérifié J-1 (section 5). Repo pushé, clés exportées. |

## 8. Pitch (3 min, fin de journée)

Style: commercial d'abord, pas de jargon en ouverture.

1. Le problème (30s): tout ce qu'un privacy pool poste on-chain est public pour toujours. Les régulateurs ont mis des dates: ANSSI et l'UE disent migration post-quantum d'ici 2030. Un pool privacy qui n'est pas PQ vend de la confidentialité avec une date de péremption.
2. Le trou (30s): la roadmap PQ de StarkWare couvre les hashes et le consensus. Elle ne couvre pas encore la couche destinataire de STRK20. C'est précisément notre spécialité.
3. La preuve (60s): demo live ou vidéo. Deux wallets. L'émetteur ne connaît que la meta-address. Le destinataire retrouve son transfert privé STRK20 par scan, l'échange de clés est ML-KEM-768, standard NIST. Aucune courbe elliptique dans la découverte du destinataire.
4. La crédibilité (30s): cette couche tourne déjà sur Solana devnet, SDK publié sur npm, construit par une équipe d'une personne depuis janvier. Aujourd'hui on a prouvé qu'elle est chain-agnostic en une journée.
5. L'ask (30s): on veut porter ça en profondeur dans STRK20 via Proof of Privacy: notes PQ-encryptées, viewing keys PQ. Candidature Proof Program déjà déposée.

## 9. Références

- Event: https://luma.com/buildSTRK20-Paris (billet dans Gmail, pkpass + ics)
- STRK20: https://strk20.starknet.io/ + blog starknet.io "Make ERC-20 Tokens Private with STRK20"
- Privacy Wallet API spec 0.10.3 (via starknet.js)
- Roadmap PQ StarkWare (30 juin 2026): BLAKE2 state commitments, Falcon-512 consensus, 3 phases
- Notre stack: `packages/specter-sdk` 0.4.1 (npm), programme Solana FgKh (transport de référence)
