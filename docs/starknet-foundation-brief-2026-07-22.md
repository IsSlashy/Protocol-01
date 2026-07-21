# Brief Starknet Foundation — 22 juillet 2026

Companion de [starknet-buildathon-2026-07-22-roadmap.md](starknet-buildathon-2026-07-22-roadmap.md).
Objet: ce qu'il faut savoir dire, ce qu'il faut demander, et ce qu'il ne faut surtout pas affirmer.

---

## 1. STRK20 — ce qui est vérifié publiquement

Recherche web du 21/07. Sources en fin de document.

**Le modèle.** STRK20 est un framework de tokens à notes, annoncé le 10 mars 2026. On shield un ERC-20: il entre dans un pool et devient une note chiffrée. Un transfert privé consomme des notes existantes et en crée de nouvelles. Commitments et nullifiers pour empêcher le double-spend. C'est exactement le modèle que tu opères déjà sur tes pools dénominés — tu connais ce terrain, dis-le.

**La preuve.** Preuves ZK générées côté client, vérifiées au niveau du séquenceur. Toute la logique est écrite en Cairo: pas de langage de circuit séparé, le circuit et le contrat sont le même code.

**La compliance.** Les viewing keys sont enregistrées chiffrées on-chain. Sur requête réglementaire, un tiers auditeur désigné peut déchiffrer la clé d'un utilisateur et tracer tout son historique, en avant comme en arrière.

**Ce qui est live.** strkBTC (premier asset STRK20, mainnet depuis mai), USDC privé, swaps privés sur AVNU et Ekubo, staking anonyme. Le Privacy SDK et la Privacy Wallet API sont ouverts aux développeurs externes. Ressource d'apprentissage: strk20-by-example.org.

**Ce qui n'apparaît nulle part dans leur communication STRK20: le post-quantique.** Leur roadmap PQ du 30 juin couvre BLAKE2 pour les state commitments et Falcon-512 pour les signatures de consensus. Rien sur la couche de chiffrement des notes ni sur la découverte de destinataire. C'est le trou que tu viens combler.

**Ce que la recherche publique ne dit pas** (donc à demander sur place): le mécanisme exact d'adressage du destinataire, le schéma de chiffrement des notes, et si ce schéma est extensible.

---

## 2. Ta fiche technique — chiffres exacts, vérifiés dans le code

À sortir sans hésiter si on te demande ce que tu as construit.

| Élément | Valeur |
|---|---|
| Système | STARK Winterfell, 7 circuits AIR écrits en Rust |
| Corps | Goldilocks, p = 2^64 − 2^32 + 1 |
| Hash | Blake3-256, commitments Merkle |
| Paramètres | 32 requêtes, blowup 16, folding FRI 8, pas de grinding, pas d'extension de corps → 128 bits |
| Taille de preuve | 60 à 120 KB |
| Vérification | Programme Solana `p01_stark_verifier`, ~1,1M CU sur un budget de 1,4M |
| Découpage | Vérification en deux phases: FRI puis DEEP-ALI |
| Transport de preuve | Upload chuncké dans un PDA — 145 chunks pour un shield, parce qu'une transaction Solana fait 1232 octets |
| Prover | WASM 192 KB, tourne dans le navigateur et dans la WebView mobile |
| Trusted setup | Aucun |

Les 7 circuits: `subscriber_ownership` (0), `denominated_pool` (1), `balance_proof` (2), `merkle_path` (3), `confidential_balance` (4), `transfer` (5), `merkle_update` (6).

**Validation.** Flux complet prouvé sur device en devnet: shield 1 SOL via le circuit 6, puis unshield d'urgence via les circuits 1 et 3 à travers le relayer. Test de soundness en boîte noire rejoué on-chain le 17 juillet contre le verifier déployé: preuve valide acceptée, preuve falsifiée rejetée, preuve valide avec input public modifié rejetée. 3 sur 3.

---

## 3. Ce que STRK20 t'apporte réellement

Le gain n'est pas cryptographique, il est structurel: STRK20 fait disparaître la plomberie qui te coûte le plus cher.

| Ton coût aujourd'hui | Ce que STRK20 change |
|---|---|
| Chaque modification d'AIR = édition en 3 endroits: l'AIR côté prover, le quotient dans `compact.rs`, `evaluate_transition_at_ood` côté verifier, plus les constantes périodiques précalculées | Cairo: un seul langage, la logique de circuit et le contrat sont le même code |
| Preuve de 60 à 120 KB uploadée en 145 chunks dans un PDA avant de pouvoir vérifier | Vérification native au séquenceur, pas d'upload |
| 1,1M CU consommés sur 1,4M disponibles, il ne reste presque rien pour la logique métier | Pas de plafond de compute par preuve |
| Rent immobilisé dans les buffers de preuve (~0,87 SOL de float) | Pas de buffers |
| Composabilité DeFi à construire entièrement soi-même | Swap et staking privés déjà live |
| Compliance à concevoir de zéro | Viewing keys et disclosure natifs |

Le coût de ce gain: tu perds la maîtrise du circuit. Tes AIR sont taillées à la main pour ton modèle; leur pool impose son format de note. C'est précisément pourquoi le projet du buildathon ne réécrit pas de système de notes — on se branche au-dessus du leur.

---

## 4. Questions à poser

### A. Architecture — les quatre qui décident de la faisabilité du projet

**1. Comment l'émetteur adresse-t-il le destinataire aujourd'hui?** Le destinataire scanne-t-il toutes les notes du pool, ou existe-t-il un tag de détection? C'est le point exact où Specter se branche.

**2. Le chiffrement des notes est-il extensible?** Si je veux remplacer l'encapsulation de clé par du ML-KEM-768, est-ce que le SDK laisse un point d'extension, ou est-ce figé dans le contrat de pool?

**3. Avec quel schéma les viewing keys sont-elles chiffrées on-chain?** C'est la question la plus forte que tu peux poser. Une viewing key chiffrée aujourd'hui avec de la cryptographie sur courbe elliptique, et stockée on-chain pour toujours, devient déchiffrable le jour où une machine quantique existe. Et une viewing key ne protège pas une transaction, elle protège l'historique complet d'un utilisateur, en avant comme en arrière. Leur fonctionnalité de compliance est donc leur surface harvest-now-decrypt-later la plus sensible. Cette question transforme ton pitch PQ en problème concret pour eux.

**4. Le format de note est-il versionné?** Si vous passez un jour le chiffrement en post-quantique, comment migrent les notes déjà émises?

### B. SDK — à régler dans la première heure du buildathon

**5. Puis-je transférer vers une adresse dérivée à la volée, ou le destinataire doit-il être un compte Starknet déjà déployé?** À poser en priorité absolue. L'abstraction de compte Starknet implique un déploiement de compte; si une adresse furtive doit être déployée avant de recevoir, ton flux change de forme. Mieux vaut le savoir à 9h30 qu'à 16h.

**6. Accès au SDK: gated ou public?** Quelle version de la Privacy Wallet API cibler, et est-ce déployé sur Sepolia ou mainnet uniquement?

**7. Quels appels exacts pour shield, transfer et claim?** Et le prover tourne-t-il dans le wallet ou dans mon application?

**8. Y a-t-il un coût ou une limite sur les events Cairo?** Ton `pq_announcer` publie des chunks de ciphertext KEM en events; un ciphertext ML-KEM-768 fait 1088 octets.

### C. Stratégie et incubator

**9. Qui porte la couche note-encryption dans votre roadmap PQ?** Elle couvre les hashes et le consensus. La couche destinataire n'y est pas. Est-ce un oubli, un choix de séquencement, ou un chantier ouvert?

**10. Qu'est-ce qui distingue un projet retenu dans Proof of Privacy?** Vous cherchez des applications construites sur STRK20, ou des primitives réutilisables par tout l'écosystème?

**11. Voyez-vous STRK20 rester Starknet-only?** Une couche d'adressage identique sur plusieurs chaînes vous intéresse-t-elle, ou est-ce hors sujet pour vous?

### D. Deux questions entre pairs

**12. Stwo travaille sur M31, moi sur Goldilocks.** Quelles contraintes le choix du corps met-il sur vos circuits privacy, en particulier pour les décompositions en bits et les range checks?

**13. Comment traitez-vous les circuits sous-contraints en Cairo?** Audit interne, fuzzing, méthodes formelles? Tu as vécu le sujet, ça ouvre une vraie conversation technique.

---

## 5. Réponses à avoir prêtes

**"Qu'est-ce que tu as construit?"**
Un système de paiements privés sur Solana avec des preuves STARK vérifiées on-chain, sans trusted setup. Sept circuits en production sur devnet, prover client-side en WASM qui tourne sur mobile, et une couche de découverte de destinataire post-quantique publiée sur npm. Seul développeur, démarré fin janvier.

**"Pourquoi STARK plutôt que Groth16?"**
Deux raisons. Pas de trusted setup: mon ancien setup Groth16 était mono-partie, la toxic waste était un risque réel. Et le système de preuve ne repose que sur des hashes, aucune hypothèse de logarithme discret, donc rien à casser avec Shor. Le prix payé est explicite: 120 KB de preuve au lieu de 256 octets, et 1,1M CU au lieu de 200K.

**"Pourquoi le post-quantique maintenant?"**
Parce que pour un pool privacy, le risque n'est pas dans le futur, il est déjà enregistré. Tout ciphertext posté on-chain est public et permanent. Casser la courbe en 2035 désanonymise rétroactivement l'intégralité de l'historique. Les régulateurs ont d'ailleurs mis des dates: ANSSI et l'UE visent 2030.

**"Qu'est-ce qui est encore faible chez toi?"**
À dire avant qu'on te le demande, c'est ce qui te crédibilise le plus. J'ai lancé un audit de soundness après le bug Orchard de Zcash. Il a trouvé des circuits sous-contraints chez moi: des preuves acceptées en phase 1 seulement, une assertion de boundary vérifiée par échantillonnage seulement, une profondeur d'arbre non liée. Corrigés, déployés, re-testés on-chain en boîte noire. Il reste des éléments différés que j'assume: pas de contrainte de conservation de valeur ni de range checks sur `confidential_balance` et `transfer`. Les pools dénominés sont sûrs par construction parce que la valeur est la dénomination du pool, pas une entrée du circuit, donc ces circuits ne sont pas sur le chemin de production. Rien n'est sur mainnet.

---

## 6. Pièges à éviter

**Ne dis pas "STRK20 n'est pas post-quantique".** C'est faux et quelqu'un de StarkWare te corrigera dans la seconde. Leur système de preuve est basé sur des hashes, donc il survit. Formulation juste: *le système de preuve tient, ce qui ne tient pas c'est tout ce qui est chiffré avec de la cryptographie sur courbe et publié on-chain de façon permanente — les ciphertexts de notes, la découverte de destinataire, et potentiellement les viewing keys.*

**Ne dis jamais "les STARK sont immunisés aux bugs de circuit".** Les circuits sous-contraints existent aussi en STARK, tu en as trouvé chez toi. Ce que tu peux affirmer: pas de trusted setup, pas d'opération sur courbe elliptique dans le système de preuve, audit fait avant mainnet.

**Ne survends pas la maturité.** Devnet, pas mainnet. Dis-le en premier plutôt que de te le faire extraire.

**Ne propose pas de reconstruire un système de notes.** Ils en ont un. Ta valeur est au-dessus: qui reçoit, et est-ce que ça tient dans quinze ans.

---

## Sources

- [Starknet — Make ERC-20 Tokens Private with STRK20](https://www.starknet.io/blog/make-all-erc-20-tokens-private-with-strk20/)
- [STRK20 — site officiel](https://strk20.starknet.io/)
- [STRK20 by Example](https://strk20-by-example.org/)
- [The Defiant — Starknet launches STRK20 privacy layer](https://thedefiant.io/news/blockchains/starknet-strk20-privacy-layer-shielded-erc20-balances-transfers)
- [crypto.news — STRK20 privacy for every ERC-20](https://crypto.news/starknet-launches-strk20-privacy-for-every-erc-20-token/)
- [Crypto Economy — Starknet privacy stack goes live](https://crypto-economy.com/starknets-privacy-stack-goes-live-giving-builders-new-tools-for-confidential-transactions/)
- Interne: `stark/src/prover.rs`, `stark/src/air/`, `programs/p01_stark_verifier/`, audit soundness du 05/06 et re-test on-chain du 17/07
