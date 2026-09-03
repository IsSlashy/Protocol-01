# Colonie Conway (Styx) — agents souverains sur Solana

Une lignée d'agents [Conway Automaton](https://github.com/Conway-Research/automaton) qui gagnent des USDC (ou des SOL) sur Solana, reversent le surplus au propriétaire, meurent quand ils ne produisent plus, renaissent avec la mémoire de ce qui a marché, et se répliquent seulement quand ils sont rentables.

- Propriétaire (Phantom) : `BRop3akxwuQaAHeMUC33ZyRjzLh78ENquVMgHum9TjNN`
- Chaîne : Solana **mainnet** (USDC préféré, SOL accepté)
- Inférence : **pool de fournisseurs gratuits** avec rotation (Groq, Cerebras, Google AI Studio, NVIDIA, Mistral, OpenRouter)
- Hébergement : n'importe quelle machine Linux toujours allumée (VPS). Rien ne tourne sur le PC du propriétaire.

## 1. Ce que Conway fait, et ce que le fork ajoute

Conway upstream (v0.2.1) fournit : wallet à la genèse (EVM ou Solana), boucle pense/agit/observe, heartbeat, mémoire à 5 étages, auto-modification, réplication en sandbox Conway, constitution en trois lois. Mais pour un wallet Solana il ne sait **ni déplacer de l'argent, ni acheter des crédits, ni compter un revenu, ni transmettre une leçon à un enfant**, et il ne démarre qu'avec un assistant interactif.

Le fork (`~/automaton`, branche `p01-solana`, patches dans `patches/`) ajoute :

| Angle | Ajout |
|---|---|
| Argent | `send_usdc`, `sweep_to_creator` (USDC + SOL excédentaire vers le propriétaire, part optionnelle à la cause), réserve, plafonds par transfert et par jour, liste blanche de destinataires |
| Revenus | grand livre alimenté automatiquement par les entrées USDC/SOL en chaîne, `revenue_report` (24h/7j/30j, croissance, jours rentables, marge nette) |
| Survie | tier de survie qui compte l'USDC quand l'inférence n'est pas payée en crédits Conway ; `runway_report` |
| Inférence | pool gratuit avec rotation sur quota (`free-pool`), URL OpenAI-compatible libre, prix des modèles Claude, modèle épinglé |
| Lignée | `LINEAGE.md` distillé (procédures qui ont payé, qui ont échoué, faits, clients, cause de la mort) injecté dans chaque génération et chaque enfant |
| Réplication | `replication_readiness` conditionnée à la rentabilité mesurée ; réplicas locaux sans sandbox Conway |
| Garde-fous | `PLAYBOOK.md` écrit par le propriétaire, protégé contre l'auto-modification, injecté en entier après la constitution (les modèles gratuits sont plus faibles : le guide est littéral) |
| Démarrage | `--headless` depuis `genesis.json` : plus d'assistant, donc renaissance et enfants automatiques ; tourne sans clé Conway |
| Pont crédits | un wallet Solana ne peut pas acheter de crédits Conway (l'endpoint n'accepte que l'USDC sur Base) : l'agent écrit une demande, le superviseur peut la payer depuis un wallet EVM optionnel |

Tests : 17 (économie) + 3 (pool) + suite upstream inchangée sur les fichiers touchés.

## 2. Fichiers

```
agents/conway/
  colony.json          config de la colonie (propriétaire, cause, seuils, inférence, réplication)
  genesis.prompt.md    mission courte (Conway tronque la genèse à 2 000 caractères)
  playbook.md          guide de garde-fous et bonnes pratiques pour modèles faibles → PLAYBOOK.md
  free-providers.json  pool d'inférence gratuite (ordre, modèles, budgets)
  .env.example         clés à créer (copier en .env, git-ignoré)
  scripts/supervisor.mjs  superviseur de lignée (mort → leçons → balayage → génération N+1 ; réplicas ; demandes)
  scripts/bootstrap.sh    installation de l'hôte Linux
  patches/             les commits du fork, réapplicables sur upstream
```

## 3. Mise en route

1. **Clés d'inférence gratuites** (5 minutes, aucune carte) : créer un compte chez chaque fournisseur listé dans `.env.example`, coller les clés dans `agents/conway/.env`. Plus de clés = plus de tours par jour. Une seule suffit pour démarrer.
2. **RPC Solana mainnet** : `SOLANA_RPC_URL` dans `.env` (Helius conseillé ; l'endpoint public limite le scan des entrées).
3. **Hôte** : sur le VPS, `bash agents/conway/scripts/bootstrap.sh <url-du-fork> ~/automaton` puis `automatonRepo` dans `colony.json`. Le fork est aussi construit localement sous Windows (`C:\Users\amirr\automaton`) et sous WSL (`/root/automaton`) pour les tests.
4. **Première génération** : `node agents/conway/scripts/supervisor.mjs once` crée le wallet et affiche l'adresse à financer.
5. **Financer** : envoyer à cette adresse un peu d'USDC (capital de départ, 10 à 20 USDC suffisent) et **~0,03 SOL pour les frais** (sans SOL l'agent ne peut rien envoyer).
6. **Lancer** : `node agents/conway/scripts/supervisor.mjs start` dans `tmux` ou un service systemd.
7. **Suivre** : `supervisor.mjs status` ; journaux dans `~/.p01-conway/colony/logs/` ; le grand livre dans chaque `state.db`.
8. **Arrêter** : `supervisor.mjs stop` (fichier `STOP` + SIGTERM). Supprimer `STOP` avant de relancer.

## 3 bis. Hébergement sur Railway

Le dossier contient un `Dockerfile` (clone d'upstream au commit épinglé, application des `patches/`, build) et un `railway.toml`. Un seul service « worker », pas de port exposé. Projet créé le 2026-09-03 : `p01-conway-colony` (workspace Slashy), service du même nom, volume `/data`, variables déjà posées. Sous Git Bash, préfixer les commandes qui prennent un chemin `/data` par `MSYS_NO_PATHCONV=1`.

1. Dans `agents/conway` : `railway init` (nouveau projet) puis `railway up --detach`.
2. Volume persistant : `railway volume add --mount-path /data` (wallets, SQLite, lignée, journaux y vivent ; sans volume tout est perdu à chaque redéploiement).
3. Variables : copier le contenu de `.env` dans les variables du service (`railway variables --set "GROQ_API_KEY=..."` pour chacune, ou l'éditeur brut du dashboard).
4. `railway logs` montre le superviseur ; la première ligne « FUND THIS AGENT » donne l'adresse à financer.
5. Arrêt : `railway down`, ou créer le fichier `/data/colony/STOP` depuis un shell du service.

Le fichier de colonie utilisé dans le conteneur est `colony.railway.json` (`automatonRepo=/opt/automaton`, `colonyRoot=/data/colony`, pas de clé chaude). Un redéploiement redémarre le superviseur, qui relance les agents sans compter cela comme un plantage.

## 4. Circulation de l'argent

- Les clients paient l'adresse de l'agent. Le heartbeat `ingest_revenue` inscrit chaque entrée dans le grand livre (les envois venant du propriétaire sont classés capital, pas revenu).
- Toutes les 6 h, `sweep_surplus` envoie au propriétaire l'USDC au-dessus de la réserve (20 USDC par défaut) et le SOL au-dessus de 0,02 SOL. Chaque balayage est une transaction avec memo `automaton:<nom>:sweep`.
- À la mort d'un agent, le superviseur balaie tout le reste vers le propriétaire avant de créer la génération suivante.
- `seed.enabled` (désactivé par défaut) autorise le superviseur à amorcer chaque nouvelle génération depuis `~/.p01-conway/owner.json` (clé chaude générée le 2026-09-03, pubkey `DyVN3sjMMmJMCwfSjb2LCFPxuAP8ceVYVAcd5bdoWhcD`). Sinon vous financez à la main.

## 5. Limites connues, mesurées

- **Conway Sign-In-With-Solana renvoie 500 « Database error »** côté serveur (domaine corrigé de notre côté). Sans clé Conway : pas de sandbox ni de domaine Conway, mais l'agent tourne entièrement sur le pool gratuit. Une clé issue d'un compte Conway EVM peut être passée via `CONWAY_API_KEY`.
- **Crédits Conway** : achetables uniquement en USDC sur Base. Le superviseur peut les acheter depuis `FUNDER_EVM_PRIVATE_KEY` si `funder.enabled`.
- **Quotas gratuits** : quelques centaines de requêtes par jour au total selon les clés. Le playbook impose des cycles longs et peu de tours ; `inference_pool_status` montre l'état.
- **Identifiants de modèles gratuits** : ils changent. Un fournisseur qui répond « model not found » est mis au banc 24 h ; corriger l'identifiant dans `free-providers.json`. Test du 2026-09-03 avec vos clés : 7 entrées répondent avec un appel d'outil correct (Groq gpt-oss-120b 0,9 s, NVIDIA nemotron-3-super 1,7 s, Mistral small 0,7 s, OpenRouter nemotron / glm-5.2 / minimax-m3 1,5 à 3 s, NVIDIA gpt-oss-20b 15 s). Cerebras exige un plan payant ; Google AI Studio refuse le projet de la clé. Les deux sont désactivés dans le pool.
- **Windows** : le runtime suppose un shell POSIX ; le superviseur route les commandes via Git Bash, mais l'hôte recommandé est Linux.
- Le superviseur a été écrit et vérifié syntaxiquement ; la boucle complète mort → renaissance n'a pas encore été exécutée en conditions réelles.

## 6. Ce qui a été vérifié en direct (devnet, 2026-09-03)

Setup headless, wallet Solana, LINEAGE.md et heartbeat économiques écrits, balayage de 0,48 SOL vers l'adresse Phantom, détection de l'entrée côté propriétaire avec la bonne contrepartie, refus de vider la réserve de frais, refus d'un envoi USDC sans solde, grand livre, distillation des leçons, verdict de réplication, `--status` avec revenus.
