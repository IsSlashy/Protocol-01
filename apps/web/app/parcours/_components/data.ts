/**
 * Toutes les valeurs chiffrées de /parcours vivent ici, pour qu'il y ait
 * exactement un endroit à auditer.
 *
 * Règle de la page : aucune valeur n'entre dans ce fichier sans avoir été
 * vérifiée à la source. Les onze programmes vivants ont été revérifiés par
 * `getMultipleAccounts` sur api.devnet.solana.com au slot 482 140 743, le
 * 8 août 2026 : les onze renvoient `executable: true` sous
 * BPFLoaderUpgradeab1e. La page n'en liste que huit, ceux du chemin principal,
 * et le dit là où elle donne le chiffre. Les versions npm ont été lues sur registry.npmjs.org
 * le même jour. La transaction de preuve STARK a été relue par
 * `getTransaction` : slot 481 215 821, `err: null`, 809 812 CU.
 *
 * Rien ici n'est sur mainnet. Ce mot n'apparaît sur la page que pour dire
 * qu'il n'y a pas de mainnet.
 */

export const GITHUB = 'https://github.com/IsSlashy';
export const REPO = 'https://github.com/IsSlashy/Protocol-01';
export const EMAIL = 'amirramy.chatbi@gmail.com';

export const explorerUrl = (id: string): string =>
  `https://explorer.solana.com/address/${id}?cluster=devnet`;

export const txUrl = (sig: string): string =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

export const sourceUrl = (path: string): string => `${REPO}/blob/master/${path}`;

export const npmUrl = (pkg: string): string =>
  `https://www.npmjs.com/package/@protocol-01/${pkg}`;

export const VERIFIED = {
  rpc: 'api.devnet.solana.com',
  slot: '482 140 743',
  date: '8 août 2026',
} as const;

/* --- dépôts, par section ----------------------------------------------------
 * Visibilité vérifiée via l'API GitHub le 8 août 2026 : 9 dépôts publics,
 * 3 privés. Un dépôt privé est annoncé comme tel plutôt que présenté comme
 * s'il était ouvrable.
 * -------------------------------------------------------------------------- */

export interface RepoRef {
  label: string;
  href: string;
  visibility: 'public' | 'privé';
  note?: string;
}

export const REPOS = {
  styx: [
    {
      label: 'IsSlashy/Protocol-01',
      href: REPO,
      visibility: 'public' as const,
      note: 'le monorepo entier',
    },
    {
      label: 'programs/',
      href: `${REPO}/tree/master/programs`,
      visibility: 'public' as const,
      note: 'les 15 programmes Anchor',
    },
  ],
  stark: [
    {
      label: 'stark/',
      href: `${REPO}/tree/master/stark`,
      visibility: 'public' as const,
      note: 'le prouveur',
    },
    {
      label: 'programs/p01_stark_verifier/',
      href: `${REPO}/tree/master/programs/p01_stark_verifier`,
      visibility: 'public' as const,
      note: 'le vérifieur on-chain',
    },
    {
      label: 'programs/p01_quantum_vault/',
      href: `${REPO}/tree/master/programs/p01_quantum_vault`,
      visibility: 'public' as const,
      note: 'la signature WOTS+',
    },
  ],
  sdk: [
    {
      label: 'packages/',
      href: `${REPO}/tree/master/packages`,
      visibility: 'public' as const,
      note: 'les 16 paquets',
    },
    {
      label: 'npm @protocol-01',
      href: 'https://www.npmjs.com/search?q=%40protocol-01',
      visibility: 'public' as const,
      note: '11 en ligne',
    },
  ],
  makora: [
    {
      label: 'IsSlashy/Makora',
      href: `${GITHUB}/Makora`,
      visibility: 'public' as const,
      note: '138 commits, 8 jours',
    },
  ],
  client: [
    {
      label: 'IsSlashy/client_1',
      href: `${GITHUB}/client_1`,
      visibility: 'public' as const,
      note: 'Vegas Corporate Videos, livraison client',
    },
    {
      label: 'IsSlashy/monetise',
      href: `${GITHUB}/monetise`,
      visibility: 'public' as const,
      note: 'MON3TIZE, livraison client',
    },
    {
      label: 'monetise-ashen.vercel.app',
      href: 'https://monetise-ashen.vercel.app',
      visibility: 'public' as const,
      note: 'en ligne',
    },
  ],
  portfolio: [
    {
      label: 'IsSlashy/slashy-exe',
      href: `${GITHUB}/slashy-exe`,
      visibility: 'privé' as const,
      note: 'le code reste fermé',
    },
    {
      label: 'slashy.space',
      href: 'https://slashy.space',
      visibility: 'public' as const,
      note: 'le site est ouvrable',
    },
  ],
  ultrakill: [
    {
      label: 'IsSlashy/ULTRAKILL-DamageTweaker',
      href: `${GITHUB}/ULTRAKILL-DamageTweaker`,
      visibility: 'public' as const,
      note: 'le mod, avec installateur en un clic',
    },
  ],
  autres: [
    {
      label: 'github.com/IsSlashy',
      href: GITHUB,
      visibility: 'public' as const,
      note: 'tous les dépôts',
    },
  ],
} satisfies Record<string, RepoRef[]>;

/* --- bandeau d'ouverture ---------------------------------------------------- */

export const STATS = [
  { value: '1 036', label: 'commits, monorepo principal' },
  { value: '11', label: 'programmes vivants sur devnet' },
  { value: '11', label: 'paquets npm publiés' },
  { value: '809 812', label: 'unités pour une preuve acceptée' },
  { value: '4', label: 'plateformes clientes livrées' },
] as const;

/* --- programmes Solana ------------------------------------------------------ */

export interface ProgramRow {
  name: string;
  id: string;
  role: string;
  sourcePath?: string;
}

export const PROGRAMS: ProgramRow[] = [
  {
    name: 'p01_stark_verifier',
    id: 'DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs',
    role: "Vérifieur STARK on-chain, écrit à la main : contraintes Poseidon et Merkle sur le corps Goldilocks, test de bas degré FRI, liaison DEEP-ALI hors domaine. Aucune courbe elliptique, aucun setup de confiance.",
    sourcePath: 'programs/p01_stark_verifier/src/lib.rs',
  },
  {
    name: 'zk_shielded',
    id: 'GbVM5yvetrSD194Hnn1BXnR56F8ZWNKnij7DoVP9j27c',
    role: "Pool blindé : les dépôts se font à dénomination fixe et sont stockés comme des commitments Poseidon insérés dans un arbre de Merkle, le retrait est conditionné à une preuve STARK. Porte aussi les coffres d'abonnement. 383 comptes de test créés par moi sur devnet, aucun utilisateur.",
    sourcePath: 'programs/zk_shielded/src/lib.rs',
  },
  {
    name: 'specter',
    id: 'FgKhXakZGsd4PdiGgACYy8gwj1JLMYA691yQr2PhUNfL',
    role: "Comptes furtifs et annonces de paiement : le transport on-chain sur lequel circulent les adresses à usage unique.",
    sourcePath: 'programs/specter/src/lib.rs',
  },
  {
    name: 'p01_quantum_vault',
    id: 'HazoS6VKk4fqzjJg2yNYSPYTSq8yEHm2EZyb23seTh7o',
    role: "Coffre à signature WOTS+ : 67 chaînes de hachage vérifiées on-chain pour 97 787 unités de calcul. Le seul endroit du système où une primitive post-quantique est vérifiée par la chaîne elle-même.",
    sourcePath: 'programs/p01_quantum_vault/src/lib.rs',
  },
  {
    name: 'p01_relayer',
    id: '2okhzLVr6FEq5jP19KT6VurcSutx2zE4RhkRamrk5WpW',
    role: "Réseau de relayeurs avec mise en jeu : soumission des travaux par morceaux et réputation à décroissance, pour que l'utilisateur ne signe pas lui-même la transaction du pool.",
    sourcePath: 'programs/p01_relayer/src/lib.rs',
  },
  {
    name: 'p01_registry',
    id: 'QaQwpvBi1EQpevNE21D2oNBHFsLtoLwa7aXH26zRhQB',
    role: "Registre des services marchands : la seule source publiée à laquelle un SDK peut comparer un coffre d'abonnement pour savoir s'il correspond à une vraie vente.",
    sourcePath: 'programs/p01_registry/src/lib.rs',
  },
  {
    name: 'p01_mugen',
    id: 'EURLevwgmunRQU5piF7QLB1ithMPfxYFXp6jp6eGEAJN',
    role: "Séquestre pair à pair pour l'échange fiat vers crypto : création d'ordre, séquestre wSOL, confirmation, litige, expiration.",
    sourcePath: 'programs/p01_mugen/src/lib.rs',
  },
  {
    name: 'p01-fee-splitter',
    id: 'UdxXEvcAzmGsqUtoBgnNkbmfnky4En2kLxNnsVQU5BM',
    role: 'Répartition des frais de protocole vers un portefeuille fixe.',
    sourcePath: 'programs/p01-fee-splitter/src/lib.rs',
  },
];

/* --- la transaction qui prouve tout ----------------------------------------- */

export const PROOF_TX =
  '2sLVyzPWseoVuCwPoDaZWUPRB8u8NXmmCGTVnBvZnEiJXHkPT1vAzMKMwhhHbPaXPDYSdTw39drzVCgUN49jZiBR';

export const WOTS_TX =
  '3XTeF2sT1htNrTK6yTN3ynmrmqDVzUM7u1iAgkYobTn2GWV8FUXiiQd2fznBhijrWPXVUJd2Ma57orCkPvj5eun5';

/**
 * Les trois jambes du test de bout en bout du 4 août 2026. L'écart de 27 fois
 * entre les deux refus est le résultat intéressant : une forgerie cohérente
 * avec sa propre transcription doit payer tout le FRI avant de mourir, alors
 * qu'une entrée publique trafiquée casse Fiat-Shamir et meurt immédiatement.
 */
export const VERDICTS = [
  {
    leg: 'Preuve honnête',
    verdict: 'ACCEPTÉE',
    kind: 'ok' as const,
    cu: '809 812',
    where: 'les cinq étapes passent',
  },
  {
    leg: 'Preuve forgée, un octet retourné',
    verdict: 'InvalidProof 6003',
    kind: 'warn' as const,
    cu: '542 150',
    where: "meurt après l'étape 3, dans le DEEP puis le FRI",
  },
  {
    leg: 'Entrée publique trafiquée',
    verdict: 'InvalidProof 6003',
    kind: 'warn' as const,
    cu: '19 777',
    where: "meurt sur un désaccord sur z, juste après l'étape 1",
  },
] as const;

/* --- paquets npm ------------------------------------------------------------ */

export interface NpmRow {
  name: string;
  version: string;
  role: string;
}

export const NPM_PACKAGES: NpmRow[] = [
  {
    name: 'merchant-sdk',
    version: '0.1.3',
    role: "Côté marchand : vérifier un paiement ou un abonnement contre sa propre connexion RPC. Sans adaptateur de portefeuille, sans effet réseau à l'import.",
  },
  {
    name: 'specter-sdk',
    version: '0.4.2',
    role: "Adresses furtives, échange hybride X25519 plus ML-KEM-768, et le signeur WOTS+ côté client.",
  },
  {
    name: 'privacy-sdk',
    version: '1.0.4',
    role: 'Client de haut niveau du pool blindé, des notes et des adresses furtives.',
  },
  {
    name: 'privacy-toolkit',
    version: '1.0.4',
    role: 'Primitives isolées : commitments Poseidon, arbres de Merkle, encodage de notes.',
  },
  {
    name: 'zk-sdk',
    version: '1.0.2',
    role: "Surface historique du système de preuve, aujourd'hui une coquille de réexport au-dessus de stark-prover.",
  },
  {
    name: 'stark-prover',
    version: '0.1.2',
    role: 'Prouveur STARK compilé en WebAssembly, celui qui tourne dans le navigateur et sur le téléphone.',
  },
  {
    name: 'zkspl-sdk',
    version: '0.1.3',
    role: 'Soldes SPL confidentiels engagés par Poseidon.',
  },
  {
    name: 'p01-js',
    version: '0.3.2',
    role: 'Client JavaScript généraliste du protocole.',
  },
  {
    name: 'auth-sdk',
    version: '0.1.1',
    role: "Authentification par signature de portefeuille et jetons d'accès.",
  },
  {
    name: 'rpc-config',
    version: '0.1.2',
    role: 'Configuration RPC partagée et bascule de secours entre fournisseurs.',
  },
  {
    name: 'arcium-sdk',
    version: '0.1.2',
    role: "Vestige d'une intégration MPC retirée du protocole le 17 juillet 2026. Toujours en ligne sur npm, plus utilisée.",
  },
];

/* --- les quatre mouvements du protocole ------------------------------------- */

export const STEPS = [
  {
    no: '01',
    name: 'Dépôt',
    body: "L'utilisateur dépose une dénomination fixe. Ce que la chaîne enregistre est un commitment Poseidon inséré dans un arbre de Merkle : un haché, pas un propriétaire.",
    metaLabel: 'zk_shielded [source]',
    metaHref: sourceUrl('programs/zk_shielded/src/lib.rs'),
  },
  {
    no: '02',
    name: 'Adresse',
    body: "Le destinataire publie une adresse furtive à usage unique, dérivée par un échange hybride X25519 et ML-KEM-768 (FIPS 203). Les annonces transitent par le programme specter.",
    metaLabel: 'specter [source]',
    metaHref: sourceUrl('programs/specter/src/lib.rs'),
  },
  {
    no: '03',
    name: 'Preuve',
    body: "Une preuve STARK établit que le retrait dépense une vraie note de l'arbre, en n'utilisant que des hachés : contraintes Poseidon sur Goldilocks, contrôlées par FRI. Aucune courbe elliptique dans la preuve.",
    metaLabel: 'stark/src/air [source]',
    metaHref: `${REPO}/tree/master/stark/src/air`,
  },
  {
    no: '04',
    name: 'Règlement',
    body: "Le vérifieur on-chain contrôle la preuve à l'intérieur du budget de calcul et libère les fonds. La transaction extérieure reste signée en Ed25519, parce que Solana ne vérifie rien d'autre.",
    metaLabel: "la transaction sur l'explorateur",
    metaHref: txUrl(PROOF_TX),
  },
] as const;

/* --- projets secondaires ----------------------------------------------------- */

export interface ProjectCard {
  name: string;
  status: string;
  statusKind?: 'ok' | 'warn' | 'neutral';
  body: string;
  stack: string;
  links?: { label: string; href: string }[];
}

export const OTHER_PROJECTS: ProjectCard[] = [
  {
    name: 'PQ-Attest',
    status: 'public',
    statusKind: 'ok',
    body: "Journal de transparence post-quantique pour l'inférence IA confidentielle. Journal Merkle en ajout seul au format RFC 6962, signé en SLH-DSA, cosignatures de témoins contre les vues divergentes, vérifieur client en WebAssembly, ancrage on-chain optionnel.",
    stack: 'Rust, WebAssembly, SLH-DSA, X-Wing, RFC 6962, Solana',
    links: [{ label: 'code', href: `${GITHUB}/PQ-Attest-Transparency` }],
  },
  {
    name: 'specter-strk20',
    status: 'public',
    statusKind: 'ok',
    body: "Découverte de destinataire post-quantique (ML-KEM-768) pour le format de chiffrement STRK20. Une seule graine, deux chaînes : Starknet et Solana, vérifié on-chain. Démo de buildathon.",
    stack: 'TypeScript, Starknet, Solana, ML-KEM-768',
    links: [{ label: 'code', href: `${GITHUB}/specter-strk20` }],
  },
  {
    name: 'solana-security-checklist',
    status: 'public',
    statusKind: 'ok',
    body: "Les douze classes de bugs qui vident les programmes Solana, chacune avec le motif vulnérable et le correctif d'une ligne. Anchor et Rust natif. Gratuit, autonome, copiable tel quel.",
    stack: 'Rust, Anchor, documentation technique',
    links: [{ label: 'code', href: `${GITHUB}/solana-security-checklist` }],
  },
  {
    name: 'ZK-KYC, circuit de non-inclusion',
    status: 'conception',
    statusKind: 'neutral',
    body: "Un agent autonome ne peut pas passer de KYC, il n'a pas de passeport. J'ai conçu une conformité par paliers de montant, et surtout écrit le circuit qui prouve qu'une adresse n'est PAS dans une liste de sanctions. Ma première version était fausse : elle acceptait deux feuilles quelconques encadrant l'adresse, ce qui ne prouve rien. Corrigé en engageant une liste chaînée triée dans l'arbre, pour forcer les deux feuilles à être réellement voisines.",
    stack: 'Circom, TypeScript, arbre de Merkle indexé, Poseidon',
    links: [{ label: 'code', href: `${GITHUB}/p01-ows-zkkyc` }],
  },
  {
    name: 'Mugen Exchange',
    status: 'devnet',
    statusKind: 'warn',
    body: "Échange pair à pair, fiat vers crypto, sans KYC, pensé pour ne pas casser la confidentialité d'un portefeuille blindé. Séquestre wSOL, litiges et réputation anonyme tournent dans un vrai programme Anchor sur devnet.",
    stack: 'Next.js 16, Anchor, Hono, WebSocket chiffré',
    links: [{ label: 'démo', href: 'https://mugen-exchange.vercel.app' }],
  },
  {
    name: 'ULTRAKILL DamageTweaker',
    status: 'public',
    statusKind: 'ok',
    body: "Mod BepInEx et Harmony pour un jeu Unity commercial, avec menu en jeu et installateur en un clic qui déploie BepInEx tout seul. À côté, un niveau personnalisé injecté dans le jeu livré via un assemblage de marqueurs écrit pour l'occasion.",
    stack: 'C#, .NET, BepInEx, Harmony, Unity',
    links: [{ label: 'code', href: `${GITHUB}/ULTRAKILL-DamageTweaker` }],
  },
  {
    name: 'Atom Music 4.0',
    status: 'fork public',
    statusKind: 'neutral',
    body: "Client de bureau YouTube Music, forké de th-ch/youtube-music, avec un thème glassmorphique sur mesure et une lecture de fichiers audio locaux écrite de zéro. Trois versions Windows publiées.",
    stack: 'Electron, TypeScript, Vite',
    links: [{ label: 'code', href: `${GITHUB}/Atom-Music-4.0` }],
  },
  {
    name: 'anon0mesh SDK',
    status: 'npm, déprécié',
    statusKind: 'neutral',
    body: "Portage d'un client de relais Solana hors réseau, à l'origine en Python avec un sous-processus Node, vers le mobile et le navigateur. Publié sur npm puis déprécié par son propre auteur.",
    stack: 'TypeScript, Python, Solana',
  },
  {
    name: 'USB-Guardian',
    status: 'public',
    statusKind: 'ok',
    body: "Surveillance des périphériques USB et gestion d'alimentation sous Windows, avec réponses de sécurité automatisées. Écrit contre l'API Windows directement.",
    stack: 'C++, API Windows',
    links: [{ label: 'code', href: `${GITHUB}/USB-Guardian` }],
  },
];

/* --- compétences ------------------------------------------------------------- */

export const SKILLS = [
  {
    title: 'Langages',
    items:
      "TypeScript, Rust, Python, C++, C#, Dart, PHP, Java, SQL. Le Rust et le TypeScript sont ceux que j'utilise tous les jours. Le Rust dont il est question ici est du Rust contraint, compilé pour SBF avec 4 Ko de pile et un plafond de calcul.",
  },
  {
    title: 'On-chain',
    items:
      "Solana et Anchor 0.32, conception de programmes, dérivation de PDA, comptes zéro-copie, mesure de budget de calcul, déploiement et retour arrière vérifiés par hachage. Quinze programmes écrits, onze vivants sur devnet.",
  },
  {
    title: 'Cryptographie appliquée',
    items:
      "STARK et FRI, AIR Poseidon sur Goldilocks, arbres de Merkle et engagements, Groth16 et Circom, signatures à base de hachage WOTS+, ML-KEM-768, adresses furtives. Et savoir lire un système de contraintes assez finement pour voir quelle assertion est conditionnée et laquelle ne l'est pas.",
    note: 'Autodidacte, non audité par un tiers.',
  },
  {
    title: 'Front et applications',
    items:
      "Next.js 16 App Router, React 19, Tailwind v4, React Native et Expo, extensions Chrome MV3, Web Workers et WebAssembly dans le navigateur. Le même pipeline de preuve implémenté trois fois, parce que les trois runtimes ne peuvent pas partager un bundle.",
  },
  {
    title: 'Backend et infrastructure',
    items:
      'Node et Bun, Hono, Express, NestJS, GraphQL avec Apollo et TypeORM, PostgreSQL, MongoDB, Redis via Upstash, Docker, Vercel, Railway, Fly.io, GitHub Actions.',
  },
  {
    title: 'Méthode',
    items:
      "Mesurer plutôt qu'affirmer. Un harnais litesvm qui charge le vrai binaire et refuse de publier un chiffre pour un artefact périmé, des passes adverses contre mon propre code, et la règle que le dépôt applique : un test vert n'est une preuve que s'il a été muté.",
  },
] as const;

/* --- parcours ---------------------------------------------------------------- */

export const TIMELINE = [
  {
    when: '2026, en cours',
    role: 'Fondateur et unique développeur',
    org: 'Styx Protocol, anciennement Protocol 01',
    body: "Couche de confidentialité pour Solana. Quinze programmes Anchor, un prouveur et un vérifieur STARK écrits à la main, seize paquets dont onze publiés sur npm, quatre surfaces clientes. Seul, sans levée de fonds.",
  },
  {
    when: '2025, en cours',
    role: 'Développeur freelance',
    org: 'Micro-entreprise Volta',
    body: "Livraisons clientes de bout en bout : un portfolio de vidéaste avec CMS sur mesure, une plateforme de formation pour créateurs de contenu. Cadrage, développement, mise en production.",
  },
  {
    when: '2025',
    role: 'Master Cybersécurité',
    org: 'Epitech',
    body: "Sécurité réseau, tests d'intrusion, analyse de menaces. C'est l'angle qui explique le reste de cette page : les audits adverses que je mène contre mon propre code viennent de là.",
  },
  {
    when: '2023 à 2024',
    role: 'Développeur fullstack et chef de projet cybersécurité',
    org: 'Captn Boat',
    body: "Plateforme d'administration CRM de bout en bout : gestion des clients et des skippers, signature de contrats, personnalisation du site. Coordination d'une équipe transverse, développeurs, QA et parties prenantes.",
  },
  {
    when: '2023',
    role: 'Bachelor ingénierie logicielle',
    org: 'Epitech',
    body: 'Développement fullstack, Angular et Spring Boot.',
  },
  {
    when: '2022 à 2023',
    role: 'Développeur fullstack',
    org: 'Thales, puis Shop My Influence',
    body: "Plateforme SaaS et application mobile menées du cadrage au lancement : périmètre, livrables et indicateurs, pilotage d'une équipe à distance, suivi des risques et des délais. Puis interface de gestion des commandes pour une équipe de production, et optimisation des temps de chargement.",
  },
  {
    when: '2019',
    role: 'Premières lignes de code',
    org: 'En autodidacte',
    body: "Sept ans de développement au total au moment où cette page est écrite.",
  },
] as const;

/* --- registre d'honnêteté ---------------------------------------------------- */

export const LIMITS = [
  {
    label: 'Devnet uniquement',
    body: "Tous les programmes cités tournent sur le devnet Solana. Il n'y a aucun déploiement mainnet, aucun utilisateur en production, et aucun fonds réel nulle part. Le SOL de devnet ne vaut rien, et c'est précisément ce qui rend l'exercice possible.",
  },
  {
    label: 'Aucun audit externe',
    body: "Aucune partie de ce système n'a été auditée par un tiers. Les chiffres de solidité donnés plus haut sont mes propres mesures, re-dérivées par un second chemin de code indépendant, mais jamais relues par quelqu'un d'autre.",
  },
  {
    label: 'Ce que la solidité vaut',
    body: "47 à 52 bits sous conjecture, 42 à 46 bits inconditionnellement. Pas 128. Sous Grover ces chiffres sont divisés par deux, autour de 21 à 26 bits : post-quantique décrit ici le CHOIX des primitives, à base de fonctions de hachage et sans couplages, pas un niveau de sécurité post-quantique quantifié.",
  },
  {
    label: 'Liaison dépôt-retrait',
    body: "Le retrait republie le commitment de la note en entrée publique, donc n'importe qui peut apparier un retrait à son dépôt. Ce n'est pas un défaut d'interface, et aucun correctif côté client ne le répare : c'est la forme même des entrées publiques du circuit. Le circuit qui ferme ce trou est spécifié et en cours.",
  },
  {
    label: "Ce qui est publié n'est pas à jour",
    body: "Le paquet npm stark-prover 0.1.2 embarque un blob WebAssembly antérieur au vérifieur déployé, et ne peut donc produire aucune preuve que la chaîne accepte. Le code correct existe dans le dépôt, la republication n'a pas eu lieu. Je le signale ici plutôt que de laisser quelqu'un le découvrir.",
  },
  {
    label: "Une seule paire d'yeux",
    body: "Tout ce qui est décrit ici a un seul auteur. C'est la force du dossier et sa faiblesse : personne n'a relu ces choix, et la seule contre-mesure que j'ai trouvée est de m'attaquer moi-même et d'écrire les résultats même quand ils me contredisent.",
  },
] as const;
