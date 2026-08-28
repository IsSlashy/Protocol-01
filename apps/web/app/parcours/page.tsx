/**
 * /parcours : page d'ingénieur, lecture longue, destinée à un recruteur.
 *
 * Portée sur le système Styx (app/_styx/styx.css) : institutionnel, presque
 * monochrome, éditorial. Un blanc cassé chaud sur un noir profond, des filets
 * d'un pixel, une seule voix serif pour les affirmations et du monospace pour
 * les preuves. Le cyan ne survit que comme sceau, l'ambre est dépensée une
 * seule fois, sur l'admission du hero, et le gleam une seule fois, sur deux
 * mots du titre.
 *
 * Le principe de la page ne change pas avec la peinture : chaque affirmation
 * est posée à côté de ce qui permet à un inconnu de la vérifier, et ce qui
 * n'est pas fini est écrit dans le même corps de texte que le reste.
 *
 * Rendu sur le serveur, à une exception près : la visionneuse 3D de la
 * section 08 est le seul composant client de cette page, et elle ne charge
 * three.js qu'une fois défilée dans le viewport. Le gabarit racine, hors du
 * contrôle de cette page, monte ses propres composants clients sur toutes les
 * routes (SmoothScroll, DepthBackground, CorruptionOverlay, I18nProvider) ; le pied de page le dit désormais au lieu de prétendre que la
 * visionneuse est le seul client de la route. C'est pour garder l'arbre de cette
 * page côté serveur qu'elle fournit son propre cadre (StyxShell en
 * chrome={false}) au lieu de l'en-tête partagé, qui est un composant client.
 *
 * ⚠ Les {' '} collés après une balise fermante sont LOAD-BEARING, ne pas les
 * réécrire en espace simple. Mesuré le 11 août 2026 sur Next 16 : le
 * transformateur JSX de SWC supprime l'espace de tête d'un noeud de texte qui
 * court sur plusieurs lignes, donc `</strong> Elle part` rend « morceaux.Elle ».
 * Prettier, qui suit les règles de Babel, réinline ces espaces et casse seize
 * phrases d'un coup : après un `prettier --write` sur ce fichier, relire le HTML
 * rendu avant de committer.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import StyxShell from '../_styx/StyxShell';
import styles from './parcours.module.css';
import ModelViewer from './_components/ModelViewer';
import {
  DataTable,
  Ext,
  Points,
  ProjectGrid,
  Register,
  RepoLine,
  Reserve,
  Section,
  serifH1,
  SkillGrid,
  StatBand,
  Steps,
  SubHead,
  Timeline,
} from './_components/blocks';
import {
  EMAIL,
  GITHUB,
  LIMITS,
  NPM_PACKAGES,
  OTHER_PROJECTS,
  PROGRAMS,
  PROOF_TX,
  REPO,
  REPOS,
  SKILLS,
  STATS,
  STEPS,
  TIMELINE,
  VERDICTS,
  VERIFIED,
  WOTS_TX,
  explorerUrl,
  npmUrl,
  sourceUrl,
  txUrl,
} from './_components/data';

export const metadata: Metadata = {
  title: 'Ramy Chatbi, ingénieur logiciel : cryptographie appliquée et systèmes on-chain',
  description:
    'Un vérifieur STARK écrit à la main qui tient dans le budget de calcul de Solana, onze programmes vivants sur le devnet Solana, onze paquets publiés sur npm, quatre surfaces clientes : le web, React Native, une extension Chrome MV3 et le SDK npm. Chaque chiffre renvoie à la transaction ou au fichier source qui le porte. Styx Protocol, anciennement Protocol 01.',
};

/* Les ancres restent en ASCII : un identifiant accentué dans une URL est
   ré-encodé par le navigateur et casse le lien de partage. Seuls les
   libellés portent les accents. */
const NAV = [
  ['#resume', 'Résumé'],
  ['#styx', 'Styx'],
  ['#stark', 'STARK'],
  ['#sdk', 'SDK'],
  ['#makora', 'Makora'],
  ['#client', 'Client'],
  ['#portfolio', 'Portfolio'],
  ['#ultrakill', 'Unity'],
  ['#autres', 'Autres'],
  ['#parcours', 'Parcours'],
] as const;

/**
 * Capture du power-up : 33 secondes, transcodée en 1080p depuis un original
 * 4K de 114 Mo pour tomber à 12,6 Mo, avec l'atome de déplacement placé en
 * tête de fichier pour que la lecture démarre avant la fin du téléchargement.
 */
const DEMO_VIDEO = '/videos/ultrakill-powerup.mp4';
const DEMO_POSTER = '/videos/ultrakill-powerup.jpg';

export default function ParcoursPage() {
  return (
    /* chrome={false} : la page a sa propre marque, son propre index de dix
       ancres et son propre pied en français. `styx-has-chrome` réserve malgré
       tout les 4rem que l'en-tête fixe ci-dessous occupe. */
    <StyxShell chrome={false} className="styx-has-chrome">
      {/* Le document racine est en lang="en" ; cette page est en français. */}
      <div lang="fr">
        <a href="#main" className="styx-skip-link">
          Aller au contenu
        </a>

        {/* ligne d'état. Fixe et non collante : le layout racine enveloppe la
            page dans un overflow caché, mesuré, qui emporte un en-tête sticky
            avec le contenu. Sur une page de 16 000 px, perdre l'index n'est pas
            acceptable. */}
        <header className="styx-header">
          <div className="styx-container styx-header-inner">
            <Link href="/parcours" className="styx-wordmark">
              <span className="styx-wordmark-name">Ramy Chatbi</span>
              <span className="styx-wordmark-suffix">Ingénieur</span>
            </Link>
            <nav
              className="styx-nav"
              aria-label="Sections"
              /* Dix ancres plus le lien externe : sous 1 100 px la barre
                 défile latéralement au lieu de tronquer la fin de l'index. */
              style={{ gap: '1.1rem', minWidth: 0, overflowX: 'auto' }}
            >
              {NAV.map(([href, label]) => (
                <a key={href} href={href} className="styx-nav-link">
                  {label}
                </a>
              ))}
            </nav>
            <div className="styx-header-right">
              <Ext href={GITHUB} className="styx-nav-link">
                GitHub
              </Ext>
            </div>
          </div>
        </header>

        {/* Le layout racine fournit déjà le repère <main> ; ceci n'est que la
            cible du lien d'évitement. */}
        <div id="main">
          {/* hero */}
          <section className="styx-container styx-hero">
            <div className="styx-btn-row" style={{ alignItems: 'center' }}>
              <span className="styx-chip">
                <span className="styx-dot" aria-hidden="true" />
                devnet
              </span>
              <span className="styx-chip">non audité</span>
            </div>

            <p className="styx-overline" style={{ marginTop: '1.6rem' }}>
              slashy@parcours:~ $ cat PROJETS.md
            </p>

            {/* serifH1 : styx.css sort les balises h1..h6 de la police du thème
                avec un sélecteur plus spécifique que .styx-h1, donc le serif est
                remis ici avec les jetons du système. Voir blocks.tsx. */}
            <h1 className="styx-h1" style={serifH1}>
              Je construis des systèmes cryptographiques, et je publie les mesures qui{' '}
              <em className="styx-em styx-gleam-strong">me contredisent</em>.
            </h1>

            <div className="styx-hero-rule" aria-hidden="true" />

            <div className="styx-hero-body">
              <div className="styx-stack">
                <p className="styx-lede">
                  Ingénieur logiciel, sept ans de développement, un master cybersécurité. Depuis
                  janvier 2026 je construis seul une couche de confidentialité pour Solana : quinze
                  programmes on-chain, un prouveur et un vérifieur STARK écrits à la main, onze
                  paquets publiés sur npm, quatre surfaces clientes, à savoir le web, React Native,
                  une extension Chrome MV3 et le SDK npm. Avant cela, quatre ans de fullstack en
                  entreprise et en freelance.
                </p>

                <div className="styx-prose">
                  <p>
                    Cette page ne demande pas d&apos;être crue. Chaque chiffre renvoie à la
                    transaction, au paquet npm ou au fichier source qui le porte, et ce qui ne
                    marche pas est écrit dans le même corps de texte que ce qui marche.
                  </p>
                </div>

                <p className="styx-note">
                  Un audit adverse que j&apos;ai mené moi-même contre mes propres affirmations
                  publiques, en juillet 2026, sur 224 assertions, en a trouvé 46 fausses.
                  L&apos;artefact n&apos;est pas publié : ces deux nombres sont déclaratifs, ils ne
                  se vérifient pas. Ce qui se vérifie, c&apos;est la page qui reste après.
                </p>
              </div>

              {/* La seule ambre de la page. */}
              <div className="styx-admission" role="note">
                <p className="styx-admission-title">À lire en premier</p>
                <p className="styx-admission-body">
                  Tout ce qui est décrit ici tourne sur le devnet Solana. Aucun déploiement mainnet,
                  aucun utilisateur en production, aucun fonds réel, aucun audit externe. Le
                  registre complet de ce qui n&apos;est pas fait est en{' '}
                  <a className="styx-link" href="#limites">
                    section 10
                  </a>
                  , avec la même place que le reste.
                </p>
              </div>
            </div>

            <div style={{ marginTop: 'clamp(2.5rem, 6vw, 4rem)' }}>
              <StatBand
                stats={[
                  ...STATS,
                  /* Sixième carte : elle referme la grille de trois et dit la
                     seule chose que les cinq chiffres ne disent pas. */
                  { value: 'aucun', label: 'déploiement mainnet' },
                ]}
              />
              <p className="styx-note" style={{ marginTop: '1.1rem' }}>
                Les onze programmes vivants sur devnet ont été revérifiés par{' '}
                <code>getMultipleAccounts</code>{' '}sur {VERIFIED.rpc} au slot {VERIFIED.slot}, le{' '}
                {VERIFIED.date} : les onze renvoient <code>executable: true</code>. La section 02 en
                liste huit, ceux qui portent le chemin principal. Les versions npm ont été lues sur
                registry.npmjs.org le même jour. Les quatre surfaces clientes sont le web, React
                Native, l&apos;extension Chrome MV3 et le SDK npm.
              </p>
            </div>
          </section>

          {/* 01 résumé */}
          <Section
            id="resume"
            idx="01"
            index="Résumé"
            title="En une minute"
            dek="Si vous ne lisez qu'une section, prenez celle-ci. Le reste de la page dit la même chose, en plus profond."
          >
            <div className="styx-prose">
              <p>
                Je sais prendre un problème qui n&apos;a pas de solution toute faite et le porter
                jusqu&apos;à quelque chose qu&apos;un inconnu peut ouvrir et installer.
                L&apos;exemple le plus net : Solana limite chaque instruction à 1 400 000 unités de
                calcul, et une preuve cryptographique STARK n&apos;y rentre pas. J&apos;ai écrit le
                vérifieur à la main, en Rust compilé pour la machine virtuelle de Solana, et je
                l&apos;ai fait descendre à <strong>809 812 unités</strong>. La transaction qui le
                prouve est publique et date du 4 août 2026.
              </p>
              <p>
                Je livre sur plusieurs plateformes à la fois. Le même pipeline de preuve existe
                trois fois dans mon code : dans un worker Next.js, dans une WebView cachée sous
                React Native, et dans un service worker d&apos;extension Chrome. Ces trois
                environnements ne peuvent pas partager un bundle. C&apos;est du travail ingrat, et
                c&apos;est exactement ce que veut dire livrer.
              </p>
              <p>
                Enfin, je mesure au lieu d&apos;affirmer. Ce dont je suis le plus fier dans ce
                dossier n&apos;est pas un chiffre flatteur. C&apos;est le moment où j&apos;ai mesuré
                la solidité de mon propre système, découvert qu&apos;elle valait un huitième de ce
                que ma documentation annonçait, corrigé la cause, puis re-mesuré et constaté que le
                correctif ne rapportait presque rien. Les trois étapes sont écrites dans le dépôt.
              </p>
              <p>
                Je cherche un poste où ces trois choses servent : systèmes contraints, cryptographie
                appliquée, ou fullstack exigeant. Je suis en France, ouvert à la Suisse et au
                télétravail.
              </p>
            </div>
          </Section>

          {/* 02 Styx */}
          <Section
            id="styx"
            idx="02"
            index="Styx"
            alt
            title="Styx Protocol"
            dek={
              <>
                Anciennement Protocol 01. Une couche de confidentialité pour Solana. L&apos;objectif
                : payer quelqu&apos;un sans que le montant et le destinataire soient inscrits en
                clair et pour toujours dans un registre public. Le dépôt, lui, reste une transaction
                Solana signée, donc le déposant y est inscrit en clair : c&apos;est une cible de
                conception, pas un état livré. Seul, depuis janvier 2026, sans levée de fonds.
              </>
            }
          >
            <RepoLine repos={REPOS.styx} />

            <div className="styx-prose">
              <p>
                Un virement Solana ordinaire publie cinq choses, à tout le monde et pour toujours :
                qui envoie, qui reçoit, combien, quand, et le mémo. Pour un salaire, un loyer, une
                facture fournisseur ou un abonnement, cela revient à publier sa comptabilité. Styx
                répond par un pool blindé : on dépose une dénomination fixe, la chaîne
                n&apos;enregistre qu&apos;un haché, et on ressort avec une preuve cryptographique
                établissant qu&apos;on possède bien une note du pool, sans dire laquelle. Avec la
                réserve de la{' '}
                <a className="styx-link" href="#limites">
                  section 10
                </a>
                , qui vaut aujourd&apos;hui : le retrait republie le commitment du dépôt, donc
                apparier un retrait à son dépôt reste possible.
              </p>
              <p>
                Le choix structurant a été d&apos;abandonner Groth16 pour les STARK en mars 2026.
                Groth16 demande une cérémonie de setup de confiance et repose sur des courbes
                elliptiques, que l&apos;ordinateur quantique casse. Un STARK ne repose que sur des
                fonctions de hachage : pas de setup, pas de couplages, rien à faire fuiter. Le prix
                à payer, c&apos;est qu&apos;il faut alors écrire soi-même un vérifieur FRI qui
                tienne dans le budget de calcul de la chaîne, parce qu&apos;il n&apos;en existait
                aucun.
              </p>
            </div>

            <div>
              <SubHead>Les quatre mouvements</SubHead>
              <Steps steps={STEPS} />
            </div>

            <div>
              <SubHead>Les programmes, et comment les vérifier</SubHead>
              {/* Trois colonnes et non quatre : la colonne de contenu d'une
                  section Styx mesure environ 750 px, et un identifiant base58 de
                  44 caractères plus une colonne de liens y écrasaient le rôle sur
                  huit lignes. L'identifiant EST le lien vers l'explorateur, et le
                  lien vers la source vit sous le nom du programme : les deux URL
                  de l'ancienne colonne « Vérifier » sont toutes les deux là. */}
              <div className="styx-table-wrap">
                {/* table-layout fixe : en répartition automatique, un base58 de
                    44 caractères réclame 366 px des 750 px disponibles (mesuré) et
                    il ne reste rien pour le rôle. Les proportions ci-dessous sont
                    tenues, l'identifiant passe sur deux lignes. */}
                <table className="styx-table" style={{ minWidth: '44rem', tableLayout: 'fixed' }}>
                  <caption className="styx-sr-only">
                    Programmes déployés sur le devnet Solana. L&apos;identifiant renvoie à
                    l&apos;explorateur, le lien source au fichier qui le déclare.
                  </caption>
                  <colgroup>
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '26%' }} />
                    <col style={{ width: '48%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Programme</th>
                      <th scope="col">Program ID (devnet)</th>
                      <th scope="col">Rôle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PROGRAMS.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <span
                            className="styx-mono styx-code-name"
                            style={{ wordBreak: 'break-all' }}
                          >
                            {p.name}
                          </span>
                          {p.sourcePath ? (
                            <p className="styx-mono" style={{ margin: '0.35rem 0 0' }}>
                              <Ext href={sourceUrl(p.sourcePath)} className="styx-link">
                                [source]
                              </Ext>
                            </p>
                          ) : null}
                        </td>
                        <td>
                          <span className="styx-mono" style={{ wordBreak: 'break-all' }}>
                            <Ext href={explorerUrl(p.id)} className="styx-link">
                              {p.id}
                            </Ext>
                          </span>
                        </td>
                        <td>{p.role}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="styx-note" style={{ marginTop: '1rem' }}>
                Huit des quinze programmes écrits, ceux qui portent le chemin principal.
                L&apos;identifiant renvoie à l&apos;explorateur et{' '}
                <span className="styx-mono">[source]</span>{' '}au fichier qui le déclare : chaque
                identifiant est le <code>declare_id!</code>{' '}de ce fichier. Mainnet : aucun. Si un
                lien tombe, cette page échoue honnêtement.
              </p>
            </div>
          </Section>

          {/* 03 STARK */}
          <Section
            id="stark"
            idx="03"
            index="STARK"
            title="Le vérifieur STARK"
            dek={
              <>
                La pièce la plus difficile du dossier, et celle que je défendrais une heure en
                entretien. Trois murs indéplaçables, et ce qui s&apos;est passé quand j&apos;ai
                mesuré ma propre sécurité.
              </>
            }
          >
            <RepoLine repos={REPOS.stark} />

            <div>
              <SubHead>Le problème, en chiffres</SubHead>
              <div className="styx-prose">
                <p>
                  Une transaction Solana ne peut pas dépasser <strong>1 232 octets</strong>. Une
                  preuve STARK de mon circuit numéro 3 en fait <strong>78 157</strong>. Une
                  instruction ne peut pas dépasser <strong>1 400 000 unités de calcul</strong>, et
                  une vérification FRI naïve les explose. Enfin, la pile de la machine virtuelle
                  fait <strong>4 Ko</strong>. Ces trois murs ne se négocient pas : ils sont dans le
                  runtime de la chaîne.
                </p>
              </div>
            </div>

            <div>
              <SubHead>Ce que j&apos;ai fait</SubHead>
              <Points
                items={[
                  <>
                    <strong>Téléverser la preuve en morceaux.</strong>{' '}Elle part dans un compte
                    détenu par le programme, créé à 10 240 octets puis agrandi par paliers, et
                    rempli par des écritures de 1 000 octets. Piège trouvé en route : Solana
                    déduplique les transactions strictement identiques, ce qui cassait
                    silencieusement la boucle d&apos;agrandissement. Corrigé en donnant à chaque
                    agrandissement un prix de calcul unique, donc des octets différents.
                  </>,
                  <>
                    <strong>Couper la vérification en deux instructions.</strong>{' '}Une seule ne
                    rentrait pas. La première fait Merkle, FRI et les transitions par requête ; la
                    seconde lie les contraintes de l&apos;AIR en un point tiré hors du domaine. Les
                    deux sont attachées par un SHA-256 des entrées publiques stocké dans le compte,
                    pour qu&apos;on ne puisse pas changer d&apos;entrées entre les deux appels.
                  </>,
                  <>
                    <strong>Changer de fonction de hachage, après mesure.</strong>{' '}
                    <code>sol_blake3</code>{' '}est derrière un drapeau inactif sur devnet, donc un
                    Blake3 logiciel coûtait environ 15 000 unités par haché de 64 octets. J&apos;ai
                    basculé toute la transcription sur <code>sol_sha256</code>, environ 85 unités
                    par appel, côté prouveur et côté chaîne pour qu&apos;ils restent identiques au
                    bit près.
                  </>,
                  <>
                    <strong>Remplacer une table par une décomposition en base 256.</strong>{' '}Le
                    calcul des inverses du générateur demandait 2 047 multiplications à
                    l&apos;initialisation du circuit 6, soit environ 442 000 unités : 32 % du budget
                    total. Une table à deux niveaux ramène cela à 270 multiplications, pour une
                    économie nette documentée d&apos;environ 342 000 unités.
                  </>,
                  <>
                    <strong>Précalculer les constantes périodiques.</strong>{' '}Les colonnes de
                    constantes de tour Poseidon sont figées à la compilation sous forme de
                    coefficients de NTT inverse, soit 26 494 lignes générées, pour que
                    l&apos;évaluation hors domaine ne soit plus qu&apos;un passage de Horner.
                  </>,
                ]}
              />
            </div>

            <div>
              <SubHead>Le résultat, vérifiable</SubHead>
              <DataTable
                caption="Verdicts des trois jambes du test de bout en bout"
                head={['Jambe', 'Verdict', 'Unités de calcul', 'Meurt où']}
                rows={VERDICTS.map((v) => [
                  v.leg,
                  <span key={v.leg} className="styx-chip">
                    {/* Un refus est un test qui passe : il ne prend ni sceau
                        cyan ni ambre, seulement le cadre neutre. */}
                    {v.kind === 'ok' ? <span className="styx-dot" aria-hidden="true" /> : null}
                    {v.verdict}
                  </span>,
                  <span key={`${v.leg}-cu`} className="styx-mono">
                    {v.cu}
                  </span>,
                  v.where,
                ])}
                note={
                  <>
                    Preuve honnête acceptée le 4 août 2026 :{' '}
                    <Ext href={txUrl(PROOF_TX)} className="styx-link">
                      voir la transaction
                    </Ext>
                    . Relue par <code>getTransaction</code>{' '}le 11 août 2026 : slot 481 215 821,{' '}
                    <code>err: null</code>, 809 662 unités consommées par le programme sur 1 399 850
                    allouées. Les 809 812 annoncés ailleurs sur cette page sont le total de la
                    transaction, le champ <code>computeUnitsConsumed</code>, soit ces 809 662 plus
                    les 150 unités de l&apos;instruction ComputeBudget : deux mesures du même appel,
                    pas deux versions du même chiffre. L&apos;écart de 27 fois entre les deux refus
                    est le vrai résultat : une forgerie cohérente avec sa propre transcription doit
                    payer tout le FRI avant de mourir, alors qu&apos;une entrée publique trafiquée
                    casse Fiat-Shamir et meurt immédiatement. Deux mécanismes distincts, tous les
                    deux fermés.
                  </>
                }
              />
            </div>

            <div>
              <SubHead>Et la mesure qui m&apos;a donné tort</SubHead>
              <div className="styx-prose">
                <p>
                  Ma documentation annonçait 124 bits de sécurité, en appliquant la formule
                  habituelle : nombre de requêtes multiplié par le logarithme du facteur
                  d&apos;expansion. J&apos;ai voulu vérifier plutôt que recopier, alors j&apos;ai
                  instrumenté le prouveur pour lire le vrai degré du polynôme que FRI teste. Il
                  valait <strong>4 088</strong>{' '}sur un domaine de 8 192 points, soit un taux de{' '}
                  <strong>1/2</strong>, et non le 1/16 que la constante de configuration laissait
                  croire.
                </p>
                <p>
                  La cause est structurelle, ce n&apos;est pas un réglage : la boîte S de Poseidon
                  est de degré 7, donc le polynôme de contraintes est de degré environ 7n, et la
                  division par le polynôme annulateur laisse un quotient de degré environ 6n au lieu
                  de moins de n. Conséquence directe : chaque requête valait environ 1 bit et non 4,
                  et les 124 bits annoncés en valaient réellement <strong>22 à 27</strong>. 2
                  puissance 27, c&apos;est une attaque que l&apos;on peut mener.
                </p>
                <p>
                  J&apos;ai corrigé en découpant le polynôme de composition en sept ou huit colonnes
                  de degré inférieur à n, chacune portant sa propre puissance de gamma. Taux mesuré
                  de nouveau : 1/16, et 4,000 bits par requête. Puis j&apos;ai écrit une seconde
                  dérivation, à partir des octets de preuve, en m&apos;interdisant de partager la
                  moindre fonction avec le code livré, précisément pour qu&apos;un désaccord se
                  voie.
                </p>
                <p>
                  Elle a montré que le terme de requête avait gagné 72 à 87 bits, mais que la
                  réponse n&apos;en gagnait que <strong>4 à 9</strong>. Chaque défi de Fiat-Shamir
                  est un unique élément de Goldilocks, donc l&apos;ensemble est plafonné par la
                  taille du corps de défi, autour de 48 à 52 bits, et le grinding ne peut pas
                  soulever ce plancher parce que le nonce est absorbé en dernier. La construction
                  est passée de limitée par les requêtes à limitée par le plancher : plus de
                  requêtes et plus de grinding sont désormais des leviers morts, et le test
                  l&apos;affirme au lieu de le raconter.
                </p>
                <p>
                  Le chiffre que je peux défendre est donc celui de ma propre mesure :{' '}
                  <strong>47 à 52 bits sous conjecture</strong>{' '}et{' '}
                  <strong>42 à 46 bits inconditionnellement</strong>. Personne d&apos;autre ne
                  l&apos;a relu. Le 124 a été retiré du README, qui ne revendique plus aucun chiffre
                  de solidité audité et écrit que la configuration FRI ne permet d&apos;en dériver
                  aucun. C&apos;est moins beau, et c&apos;est ce que je peux montrer.
                </p>
              </div>
            </div>

            <div>
              <SubHead>La signature post-quantique vérifiée par la chaîne</SubHead>
              <div className="styx-prose">
                <p>
                  À côté du vérifieur, la pièce la plus contrainte du dossier : une signature WOTS+
                  à 67 chaînes de hachage, vérifiée à l&apos;intérieur d&apos;un programme Solana,
                  qui échoue simultanément sur trois limites. Elle fait 2 144 octets, donc elle
                  dépasse le plafond de transaction et doit transiter par un compte tampon, écrit
                  directement dans la tranche de données plutôt qu&apos;à travers la sérialisation
                  du framework, ce qui garde le coût par morceau plat à 9 532 unités. Sa
                  vérification demande jusqu&apos;à 1 005 hachages, soit environ 2 millions
                  d&apos;unités avec une implémentation logicielle, d&apos;où le passage par
                  l&apos;appel système. Et ses 2 144 octets de points d&apos;arrivée ne tiennent pas
                  dans les 4 Ko de pile, donc ils vivent sur le tas.
                </p>
                <p>
                  Le détail dont je suis content : le coffre ne stocke pas la clé publique de 2 144
                  octets, mais un seul engagement de 32 octets sur la concaténation des 67 points
                  d&apos;arrivée. Le compte fait 98 octets au lieu de 2 176. Vérification mesurée à{' '}
                  <strong>97 787 unités de calcul</strong>{' '}sur devnet,{' '}
                  <Ext href={txUrl(WOTS_TX)} className="styx-link">
                    transaction ici
                  </Ext>
                  .
                </p>
              </div>
            </div>
          </Section>

          {/* 04 SDK */}
          <Section
            id="sdk"
            idx="04"
            index="SDK"
            alt
            title="Les SDK publiés"
            dek={
              <>
                Onze paquets vivants sur le registre npm public, sous le scope{' '}
                <code>@protocol-01</code>. C&apos;est la preuve la plus simple à vérifier de cette
                page : <code>npm view</code>{' '}suffit.
              </>
            }
          >
            <RepoLine repos={REPOS.sdk} />

            {/* Le nom du paquet porte le lien npm, au lieu d'une quatrième
                colonne [npm] : même URL, même Ext, et le rôle garde de quoi se
                lire dans la colonne de contenu. */}
            <DataTable
              caption="Paquets publiés sur le registre npm public"
              head={['Paquet', 'Version', 'Rôle']}
              rows={NPM_PACKAGES.map((p) => [
                <span key={`${p.name}-n`} style={{ whiteSpace: 'nowrap' }}>
                  <Ext href={npmUrl(p.name)} className="styx-link">
                    {`@protocol-01/${p.name}`}
                  </Ext>
                </span>,
                <span key={`${p.name}-v`} className="styx-mono">
                  {p.version}
                </span>,
                p.role,
              ])}
              note={
                <>
                  Chaque nom de paquet est un lien vers sa page npm. Versions lues sur
                  registry.npmjs.org le {VERIFIED.date}. Cinq autres paquets de l&apos;espace de
                  travail ne sont pas publiés et renvoient 404 : c&apos;est voulu pour l&apos;un, et
                  un travail non fini pour les autres.
                </>
              }
            />

            <div>
              <SubHead>Le résultat dont je suis le plus fier n&apos;est pas du code</SubHead>
              <div className="styx-prose">
                <p>
                  En écrivant le SDK marchand, je cherchais à répondre à une question simple :
                  comment un vendeur vérifie qu&apos;un abonnement a bien été payé chez lui.
                  J&apos;ai fini par prouver que{' '}
                  <strong>toutes les vérifications possibles côté SDK sont insuffisantes</strong>.
                </p>
                <p>
                  Le compte d&apos;abonnement est dérivé de trois graines et ne contient aucun
                  identifiant de service. L&apos;instruction de souscription est sans permission, et
                  elle déclare le marchand comme un compte non signataire. Un inconnu peut donc
                  faire créer par le programme un vrai compte, à la bonne adresse dérivée, nommant
                  comme bénéficiaire un marchand qu&apos;il n&apos;a jamais rencontré, au tarif
                  d&apos;une unité atomique par période. Ce compte passe le contrôle de
                  propriétaire, le discriminant, la dérivation canonique, l&apos;égalité du champ
                  marchand, l&apos;identifiant d&apos;abonné et le test de période financée. Non pas
                  parce&nbsp;qu&apos;une vérification est contournée, mais parce que{' '}
                  <strong>c&apos;est le programme lui-même qui a écrit le compte</strong>.
                </p>
                <p>
                  Supprimer l&apos;annulation n&apos;a fait qu&apos;augmenter le coût de
                  l&apos;attaque : à un tarif de 1, une dénomination de 0,1 SOL achète cent millions
                  de périodes payées, donc le compte reste valide plus longtemps que le marchand
                  n&apos;existera. La conclusion, c&apos;est que la provenance on-chain n&apos;est
                  pas une preuve de vente, et que la seule chose qui peut refuser ce compte est une
                  donnée que le marchand a publiée lui-même : son prix et son intervalle de
                  facturation, comparés aux champs du coffre.
                </p>
                <p>
                  L&apos;implémentation ne bluffe pas sur le cas résiduel : quand deux services
                  d&apos;un même marchand ont le même prix et le même intervalle, ils sont
                  indistinguables on-chain, alors la fonction renvoie <code>matches: true</code>{' '}
                  avec <code>ambiguous: true</code>{' '}plutôt que de faire semblant de trancher.
                </p>
              </div>
            </div>
          </Section>

          {/* 05 Makora */}
          <Section
            id="makora"
            idx="05"
            index="Makora"
            title="Makora"
            dek={
              <>
                Un agent DeFi piloté par un modèle de langage, sur Solana devnet. Construit seul en{' '}
                <strong>huit jours</strong>{' '}pour le Solana Agent Hackathon de février 2026 : 138
                commits, environ 46 000 lignes, trois programmes Anchor déployés.
              </>
            }
          >
            <RepoLine repos={REPOS.makora} />

            <div className="styx-prose">
              <p>
                Makora tourne en boucle : observer, orienter, décider, agir. À chaque cycle il lit
                l&apos;état du portefeuille et les positions, puis demande un plan à un modèle de
                langage à qui il donne le contexte du marché et des marchés de prédiction
                Polymarket. Ce que le modèle répond n&apos;est jamais exécuté tel quel : chaque
                action proposée passe par cinq contrôles de risque indépendants, taille de position,
                glissement, perte journalière avec coupe-circuit, réserve de SOL et exposition par
                protocole. N&apos;importe lequel peut mettre son veto.
              </p>
              <p>
                Le point de conception dont je suis content : ces limites sont appliquées{' '}
                <strong>deux fois</strong>. Une fois en TypeScript dans l&apos;agent, et une seconde
                fois en Rust à l&apos;intérieur du programme de coffre. Si le processus de
                l&apos;agent est compromis, il ne peut toujours pas vider le coffre, parce que la
                chaîne re-vérifie les mêmes bornes. Et le plafond de retrait se calcule sur
                l&apos;état comptable et non sur le solde réel, donc un attaquant ne peut pas
                gonfler son propre plafond en envoyant des lamports au coffre.
              </p>
              <p>
                Côté surfaces : un bot Telegram, une mini-application Telegram en Next.js, et une
                passerelle conteneurisée. La couche modèle est écrite contre trois API différentes
                en HTTP brut, sans aucun SDK d&apos;éditeur, ce qui permet à l&apos;utilisateur
                d&apos;apporter sa propre clé Anthropic, OpenAI ou Qwen.
              </p>
              <p>
                Contrainte amusante côté Rust : le journal d&apos;audit on-chain est un tampon
                circulaire de huit entrées dans une structure de taille fixe, dimensionné à la main
                à 929 octets, précisément pour ne pas faire déborder les 4 Ko de pile de la machine
                virtuelle. Un <code>Vec&lt;String&gt;</code>{' '}aurait planté.
              </p>
            </div>

            <Reserve title="Ce que Makora n'est pas">
              <p>
                Le README annonce de la confidentialité par preuve à divulgation nulle.{' '}
                <strong>Ce n&apos;est pas ce qui tourne.</strong>{' '}Le chemin réellement livré utilise
                des engagements SHA-256 et un arbre en mémoire ; la clé de vérification du programme
                correspondant est un tableau de zéros, marqué comme tel par son propre commentaire,
                et le pool n&apos;a jamais été initialisé.
              </p>
              <p>
                Les positions à effet de levier sont simulées. Le projet est abandonné depuis le 10
                février 2026. Je le laisse ici parce que ce qui est réel y est vérifiable, et parce
                que savoir dire où s&apos;arrête son propre projet fait partie du travail.
              </p>
            </Reserve>

            <p className="styx-note">
              Trois programmes vivants sur devnet avec un historique de transactions réel, et un
              tableau de bord déployé qui sert de vraies données Polymarket et un indicateur de
              sentiment agrégé depuis six sources publiques.
            </p>
          </Section>

          {/* 06 client */}
          <Section
            id="client"
            idx="06"
            index="Client"
            alt
            title="Travail client"
            dek="Deux livraisons freelance de bout en bout, sous micro-entreprise. Le contraire du reste de cette page : un client, une échéance, et un produit qui doit marcher pour quelqu'un qui ne lira jamais le code."
          >
            <RepoLine repos={REPOS.client} />

            <div>
              <SubHead>Vegas Corporate Videos, portfolio de vidéaste</SubHead>
              <div className="styx-prose">
                <p>
                  Une société de production vidéo de Las Vegas voulait un site qu&apos;elle puisse
                  faire vivre sans garder un développeur sous la main. Le problème réel n&apos;est
                  pas la mise en page : c&apos;est qu&apos;un client non technique doit pouvoir
                  changer ses contenus sans rien casser, sur un site fait presque entièrement de
                  médias lourds.
                </p>
                <p>
                  La réponse a été un <strong>CMS en place plutôt qu&apos;un back-office</strong>.
                  Le propriétaire se connecte, revient sur sa propre page d&apos;accueil, et édite
                  ce qu&apos;il regarde : chaque texte devient éditable, chaque section se réordonne
                  au glisser, chaque vidéo de fond se remplace sur place. Il n&apos;y a pas
                  d&apos;écran de prévisualisation, parce que la page EST la prévisualisation. Un
                  bouton Publier déclenche un redéploiement chez l&apos;hébergeur, côté serveur,
                  sans que le client ait jamais à ouvrir un tableau de bord technique.
                </p>
              </div>
            </div>

            <div>
              <SubHead>Les problèmes qui rendaient ça difficile</SubHead>
              <Points
                items={[
                  <>
                    <strong>React détruisait la frappe du client.</strong>{' '}Sur un champ éditable, le
                    moindre re-rendu réécrivait le contenu et renvoyait le curseur au début. Corrigé
                    en n&apos;écrivant le texte que via un effet gardé par une référence de focus,
                    en ne validant qu&apos;au blur, et en interceptant le collage pour ne garder que
                    du texte brut.
                  </>,
                  <>
                    <strong>Les identités temporaires.</strong>{' '}Un élément créé dans l&apos;éditeur
                    n&apos;a pas encore de ligne en base, donc il porte un identifiant provisoire.
                    La sauvegarde doit l&apos;insérer, récupérer le vrai identifiant et renvoyer une
                    table de correspondance que le magasin applique à tous les tableaux. Sans cela,
                    la sauvegarde automatique deux secondes plus tard aurait inséré des doublons au
                    lieu de mettre à jour.
                  </>,
                  <>
                    <strong>Le client tape pendant que la sauvegarde part.</strong>{' '}La fonction
                    prend donc un instantané des identifiants de changements qu&apos;elle envoie et,
                    au retour, ne vide que ceux-là de la file, de la pile d&apos;annulation et des
                    suppressions. Ce qui a été tapé entre-temps survit.
                  </>,
                  <>
                    <strong>
                      Cinq gigaoctets de vidéo à travers une plateforme qui limite les corps de
                      requête à quelques mégaoctets.
                    </strong>{' '}
                    Le serveur applicatif a été sorti du chemin de données : le navigateur demande
                    une URL signée, envoie le fichier directement au stockage, puis confirme pour
                    que la ligne soit écrite. Le serveur ne garde que l&apos;autorisation.
                  </>,
                  <>
                    <strong>Le site ne doit jamais tomber avec sa base.</strong>{' '}Les huit accesseurs
                    de données sont sous try/catch et retombent sur du contenu figé dans le code.
                    Une panne de la base rend le site statique d&apos;origine, pas une page
                    d&apos;erreur.
                  </>,
                ]}
              />
            </div>

            <div className="styx-prose">
              <p>
                42 commits, 18 jours, environ 10 700 lignes de TypeScript, dont 2 900 pour la seule
                couche d&apos;édition. 14 tables PostgreSQL, 48 règles de sécurité au niveau ligne.
                Et la moitié non technique du freelance, celle qui manque à la plupart des projets
                de portfolio : un guide de reprise de 10 pages écrit à la main, plus un guide du CMS
                et une facture, documentant chaque compte, chaque coût et chaque procédure de
                récupération, pour que le client survive à la disparition du développeur.
              </p>
            </div>

            <Reserve title="Réserve honnête">
              <p>
                Le site a été livré, le client formé et la facture réglée, mais le déploiement est
                en pause : le domaine répond <code>503 DEPLOYMENT_PAUSED</code>, vérifié le{' '}
                {VERIFIED.date}. Vous ne pouvez donc pas l&apos;ouvrir. Par ailleurs, 11 des 41
                routes d&apos;administration sont des lectures sans contrôle d&apos;accès qui
                passent par la clé de service : c&apos;est un défaut réel, que je signale plutôt que
                d&apos;attendre qu&apos;on le trouve.
              </p>
            </Reserve>

            <div>
              <SubHead>MON3TIZE, plateforme de formation pour créateurs</SubHead>
              <div className="styx-prose">
                <p>
                  Une plateforme de cours en ligne pour apprendre à devenir créateur de contenu,
                  construite pour un créateur qui vend à sa propre audience : marque personnelle,
                  contrats de contenu de marque, vente sur TikTok Shop. Un seul produit, un accès à
                  vie à 149 euros, tunnel de vente, inscription, paiement, espace membre.
                </p>
                <p>
                  Le détail qui fait la différence entre une maquette et un produit qui encaisse :
                  le droit d&apos;accès est accordé par un webhook de paiement à signature vérifiée,{' '}
                  <strong>et</strong>{' '}par un second chemin de réconciliation idempotent sur la page
                  de succès, au cas où le webhook arrive en retard. Un client qui a payé ne doit
                  jamais voir un mur de paiement.
                </p>
                <p>
                  Le lecteur de leçons est écrit contre l&apos;API iframe native plutôt qu&apos;avec
                  une bibliothèque : il reprend à la seconde où l&apos;on s&apos;est arrêté, écrit
                  la progression chaque seconde pendant la lecture, et marque la leçon terminée à 90
                  %. Côté administration, un constructeur de programme de 960 lignes permet au
                  client de gérer modules et leçons avec un éditeur de texte riche.
                </p>
                <p>
                  51 commits, environ deux jours du premier au dernier envoi, seul. Schéma
                  PostgreSQL écrit à la main : 10 tables, sécurité au niveau ligne partout,
                  déclencheurs PLpgSQL et deux fonctions SQL qui renvoient un agrégat JSON pour que
                  le tableau de bord ne fasse qu&apos;un aller-retour au lieu de N.
                </p>
              </div>
            </div>

            <Reserve title="Le bug dont je parlerais en entretien">
              <p>
                Sept commits d&apos;affilée sur une seule panne : la création de session de paiement
                échouait en production. La cause était que le gabarit d&apos;identifiant de session
                dans l&apos;URL de retour devait arriver non encodé chez le prestataire, et que la
                sérialisation du SDK l&apos;encodait à chaque fois. La sortie a été
                d&apos;abandonner le SDK pour cet appel précis et de poster le corps à la main, en
                gardant le SDK là où il est irremplaçable, c&apos;est-à-dire la vérification de
                signature du webhook. Le lendemain, une variable d&apos;environnement copiée depuis
                un tableau de bord tirait un retour à la ligne avec elle et cassait la même URL.
                Savoir quand cesser de se battre avec un outil fait partie du travail.
              </p>
              <p>
                Réserve : aucun test, aucune intégration continue, et le mur de paiement est
                appliqué dans le code applicatif alors que la règle de lecture de la table des
                leçons est ouverte. C&apos;est une bonne conversation d&apos;entretien sur
                l&apos;endroit où doit vivre l&apos;autorisation.
              </p>
            </Reserve>

            <p className="styx-note">
              MON3TIZE était en ligne et répondait le {VERIFIED.date},{' '}
              <Ext href="https://monetise-ashen.vercel.app" className="styx-link">
                monetise-ashen.vercel.app
              </Ext>
              , avec sa porte d&apos;authentification active en production ce jour-là. C&apos;est un
              constat daté, pas une garantie de disponibilité au moment où vous lisez.
            </p>
          </Section>

          {/* 07 portfolio */}
          <Section
            id="portfolio"
            idx="07"
            index="Portfolio"
            title="slashy.space"
            dek={
              <>
                Mon portfolio personnel, et le seul projet de cette page qui se juge en dix secondes
                : c&apos;est un faux système d&apos;exploitation rétro, jouable, dans le navigateur.{' '}
                <Ext href="https://slashy.space" className="styx-link">
                  slashy.space
                </Ext>
              </>
            }
          >
            <RepoLine repos={REPOS.portfolio} />

            <p className="styx-note">
              Réserve, à lire avant les chiffres de cette section : le dépôt est privé. Le site se
              visite, mais aucun des nombres qui suivent ne peut être vérifié par un tiers, ce sont
              mes propres relevés.
            </p>

            <div>
              <SubHead>La direction artistique</SubHead>
              <div className="styx-prose">
                <p>
                  Le parti pris est de ne pas écrire un portfolio, mais d&apos;en faire manipuler
                  un. Le site démarre comme un PC des années 90 : un splash en pixel art qui se
                  dissout depuis ses propres pixels, un défilement de faux BIOS, puis un bureau avec
                  des icônes déplaçables, un menu démarrer, une barre des tâches et une horloge.
                </p>
                <p>
                  L&apos;univers visuel emprunte à <i>Needy Streamer Overload</i>{' '}: un rose saturé,
                  une interface de système d&apos;exploitation fictif appelé Windose, du pixel art
                  dessiné à la main plutôt que des icônes importées. Les quinze icônes du bureau
                  sont des grilles de 16 sur 16 avec leur propre palette, écrites à la main et
                  rendues en SVG. Les panneaux latéraux sont des rues japonaises avec poteaux
                  électriques et lignes qui pendent.
                </p>
                <p>
                  Le détail qui fait tenir l&apos;ensemble est temporel : l&apos;heure réelle du
                  visiteur pilote le fond d&apos;écran et la musique, matin, après-midi ou nuit,
                  avec un fondu enchaîné de 500 millisecondes entre les pistes. Une minute
                  d&apos;inactivité déclenche un économiseur d&apos;écran à 200 étoiles en
                  parallaxe. Vingt-trois succès se débloquent en explorant, et si l&apos;on traîne
                  l&apos;icône du terminal dans la corbeille et qu&apos;on la vide, le système
                  s&apos;écroule dans un écran bleu qui ouvre une vraie console de récupération,
                  avec son propre analyseur de commandes.
                </p>
              </div>
            </div>

            <div>
              <SubHead>Ce qu&apos;il y a dessous</SubHead>
              <Points
                items={[
                  <>
                    <strong>Gestionnaire de fenêtres écrit à la main.</strong>{' '}Pas de react-rnd, pas
                    de dnd-kit. Déplacement par la barre de titre, redimensionnement sur huit
                    poignées avec compensation correcte des ancres nord et ouest, minimiser,
                    agrandir, fermer, et empilement au clic.
                  </>,
                  <>
                    <strong>Le vrai morceau : les icônes du bureau.</strong>{' '}Un même appui souris
                    peut vouloir dire sélectionner, ouvrir ou commencer un glisser. La distinction
                    se fait par un compteur de 350 millisecondes, et le glisser n&apos;est pas libre
                    : les icônes vivent dans une grille en colonnes dont la hauteur dépend de la
                    taille réelle du bureau, donc à chaque mouvement le code convertit la position
                    du curseur en case cible et réinsère l&apos;icône dans l&apos;ordre visible. La
                    corbeille est une cible de dépôt par-dessus tout ça.
                  </>,
                  <>
                    <strong>Géométrie toujours à jour.</strong>{' '}Un <code>ResizeObserver</code>{' '}écrit
                    la hauteur du bureau dans l&apos;état, et les positions sont reflétées dans une
                    référence que la fermeture de <code>mousemove</code>{' '}relit, pour qu&apos;elle ne
                    devienne jamais périmée au milieu d&apos;un glisser.
                  </>,
                  <>
                    <strong>Quinze applications réelles</strong>, pas des captures d&apos;écran : un
                    Paint 16 sur 16 avec remplissage par diffusion et vingt niveaux
                    d&apos;annulation, un Snake en canvas dont la boucle tourne entièrement sur des
                    références pour ne jamais re-rendre React, un faux navigateur avec une vraie
                    pile d&apos;historique qui tronque les entrées avant sur une nouvelle
                    navigation, un faux antivirus dont le scan est annulable, et un explorateur de
                    fichiers récursif.
                  </>,
                  <>
                    <strong>Plus de 1 100 primitives vectorielles</strong>{' '}dessinées à la main pour
                    les cinq cartes de villes : Tokyo 495 formes, New York 305, Paris 228, Genève
                    56, Miami 52.
                  </>,
                  <>
                    <strong>Détection mobile sans désynchronisation.</strong>{' '}
                    <code>useSyncExternalStore</code>{' '}avec un instantané serveur, donc{' '}
                    <code>matchMedia</code>{' '}sans erreur d&apos;hydratation et sans effet au montage.
                  </>,
                ]}
              />
            </div>

            <p className="styx-note">
              Next.js 16 App Router, React 19, Tailwind v4, framer-motion, Howler, canvas 2D, SVG
              écrit à la main. Environ 12 400 lignes, déclaratives comme le reste de la section. Le
              livre d&apos;or est en repli local parce que les variables Redis ne sont pas
              renseignées en production.
            </p>
          </Section>

          {/* 08 ULTRAKILL */}
          <Section
            id="ultrakill"
            idx="08"
            index="Unity"
            alt
            title="Unity, rétro-ingénierie et mod"
            dek={
              <>
                Le seul projet de cette page qui ne soit ni du web ni de la chaîne. Un mod pour
                ULTRAKILL, un jeu Unity commercial, et un niveau injecté dans le jeu livré.
                Ci-dessous les trois maillages que je manipule, dans une visionneuse 3D.
              </>
            }
          >
            <RepoLine repos={REPOS.ultrakill} />

            <ModelViewer />

            <div>
              <SubHead>Le bug qui vaut la section</SubHead>
              <div className="styx-prose">
                <p>
                  Injecter un niveau dans un jeu déjà compilé veut dire faire accepter par Unity des
                  composants qui n&apos;existent pas dans son assemblage. Le symptôme était
                  spectaculaire : <strong>1 007 scripts impossibles à résoudre</strong>, et un{' '}
                  <code>AddComponent</code>{' '}qui renvoyait <code>null</code>{' '}sans lever la moindre
                  erreur. La cause était une collision de nom sur l&apos;assemblage principal.
                </p>
                <p>
                  Le diagnostic est la partie intéressante. Un échec silencieux ne se débogue pas en
                  lisant des journaux, puisqu&apos;il n&apos;en produit pas. J&apos;ai écrit une
                  sonde qui interroge directement l&apos;éditeur sur ce qu&apos;il croit connaître,
                  et je l&apos;ai validée avec des valeurs volontairement non rondes, une friction à
                  3,25 et un multiplicateur de saut à 1,75, pour qu&apos;une résolution de type
                  ratée ne puisse pas se faire passer pour un succès en retombant sur une valeur par
                  défaut plausible.
                </p>
                <p>
                  L&apos;autre contrainte du niveau est venue d&apos;une mesure et non d&apos;une
                  intuition : l&apos;enveloppe de déplacement du personnage, relevée en jeu,
                  plafonne à <strong>31,05 mètres</strong>. Comme le jeu autorise le saut à la
                  roquette et au marteau, aucune barrière géométrique ne retient vraiment le joueur,
                  donc la sortie du niveau doit être un mécanisme, pas un mur.
                </p>
              </div>
            </div>

            <div>
              <SubHead>Démonstration en jeu</SubHead>
              <div className="styx-panel">
                <div className="styx-code-head">
                  <span>power-up, animation</span>
                  <span>capture en jeu, 1080p</span>
                </div>
                <video
                  className={styles.demoVideo}
                  controls
                  playsInline
                  preload="metadata"
                  poster={DEMO_POSTER}
                  width={1920}
                  height={1080}
                >
                  <source src={DEMO_VIDEO} type="video/mp4" />
                </video>
              </div>
              <p className="styx-note" style={{ marginTop: '1rem' }}>
                33 secondes, capture directe en jeu, 1080p. On y voit le bras mécanique V3 intégré
                au jeu livré et le power-up qui se déclenche. La vidéo ne se télécharge qu&apos;au
                clic sur lecture, seule l&apos;affiche est chargée avec la page.
              </p>
            </div>

            <Reserve title="Sur les maillages et la capture">
              <p>
                V1, V3, les bras et les images du jeu sont la propriété de New Blood Interactive.
                Ils sont montrés ici pour donner à voir le travail d&apos;ingénierie, pas comme une
                création de ma part. Ce qui est de moi, c&apos;est le mod, le niveau, et le code de
                cette visionneuse.
              </p>
            </Reserve>
          </Section>

          {/* 09 autres */}
          <Section
            id="autres"
            idx="09"
            index="Autres"
            title="Autres projets"
            dek="Ce qui est public et se lit, ce qui a été construit pour un hackathon, et ce qui sort du domaine crypto."
          >
            <RepoLine repos={REPOS.autres} />
            <ProjectGrid projects={OTHER_PROJECTS} />
          </Section>

          {/* 10 limites */}
          <Section
            id="limites"
            idx="10"
            index="Limites"
            alt
            title="Le registre des limites"
            dek="Tenu avec le même soin que la liste des réussites, parce que c'en est l'autre moitié. Si vous devez tester une seule chose de cette page en entretien, testez cette section."
          >
            {/* Le seul filet animé de la page : il marque la charnière entre ce
                qui est fait et ce qui ne l'est pas. */}
            <div className="styx-gleam-rule" aria-hidden="true" />
            <Register rows={LIMITS.map((l) => ({ label: l.label, body: l.body }))} />
          </Section>

          {/* 11 compétences */}
          <Section
            idx="11"
            index="Compétences"
            title="Compétences"
            dek="Classées par ce que j'ai réellement livré avec, pas par ce que j'ai lu."
          >
            <SkillGrid groups={SKILLS} />
          </Section>

          {/* 12 parcours */}
          <Section id="parcours" idx="12" index="Parcours" alt title="Parcours">
            <Timeline rows={TIMELINE} />
          </Section>

          {/* 13 vérifier */}
          <Section
            id="verifier"
            idx="13"
            index="Vérifier"
            title="Vérifier, puis me contacter"
            dek="Ne croyez rien de cette page. Les contrôles ci-dessous ne demandent qu'un terminal."
          >
            {/* Même raison que dans Section : la colonne implicite d'une grille
                styx-stack se dimensionne sur le min-content, et un <pre> qui
                défile n'a pas à élargir la page. */}
            <div className="styx-stack" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <div className="styx-code-panel">
                <div className="styx-code-head">
                  <span>Les programmes existent et sont exécutables</span>
                  <span>devnet</span>
                </div>
                <pre className="styx-code">
                  <code>
                    <span className="styx-code-comment">$</span>
                    {' solana account DGY37k3Jt7cbrfNa9rxyLZVcFB7S7A2NqtVpkh9fWQvs --url devnet'}
                  </code>
                </pre>
              </div>

              <div className="styx-code-panel">
                <div className="styx-code-head">
                  <span>La preuve a bien été acceptée, et pour combien</span>
                  <span>devnet</span>
                </div>
                <pre className="styx-code">
                  <code>
                    <span className="styx-code-comment">$</span>
                    {` solana confirm -v ${PROOF_TX.slice(0, 24)}... --url devnet`}
                  </code>
                </pre>
              </div>

              <div className="styx-code-panel">
                <div className="styx-code-head">
                  <span>Les paquets sont bien en ligne</span>
                  <span>registry.npmjs.org</span>
                </div>
                <pre className="styx-code">
                  <code>
                    <span className="styx-code-comment">$</span>
                    {' npm view @protocol-01/merchant-sdk version'}
                  </code>
                </pre>
              </div>

              <div className="styx-code-panel">
                <div className="styx-code-head">
                  <span>Les identifiants de la page sont ceux de la source</span>
                  <span>github</span>
                </div>
                <pre className="styx-code">
                  <code>
                    <span className="styx-code-comment">$</span>
                    {` git clone ${REPO}\n`}
                    <span className="styx-code-comment">$</span>
                    {' grep -rn "declare_id" programs/*/src/lib.rs'}
                  </code>
                </pre>
              </div>
            </div>

            <div className="styx-btn-row">
              <a href={`mailto:${EMAIL}`} className="styx-btn">
                M&apos;écrire
              </a>
              <Ext href={GITHUB} className="styx-btn-ghost">
                GitHub
              </Ext>
              <Ext href="https://slashy.space" className="styx-btn-ghost">
                slashy.space
              </Ext>
            </div>
          </Section>

          {/* pied */}
          <footer className="styx-footer">
            <div className="styx-container">
              <div className="styx-footer-grid">
                <div className="styx-footer-brand">
                  <p className="styx-h3" style={{ margin: 0 }}>
                    Ramy Chatbi
                  </p>
                  <p className="styx-footer-brand-line">
                    Ingénieur logiciel. Cryptographie appliquée, systèmes on-chain et fullstack.
                    France, ouvert à la Suisse et au télétravail. Tout ce que cette page écrit est
                    rendu sur le serveur, sauf la visionneuse 3D de la section 08, son seul composant
                    client, qui ne charge three.js qu&apos;une fois défilée jusqu&apos;à elle. Le
                    gabarit racine du site, lui, monte ses propres composants clients sur toutes les
                    routes, celle-ci comprise.
                  </p>
                </div>
                <div>
                  <p className="styx-footer-col-title">Index</p>
                  <ul className="styx-footer-links">
                    {NAV.map(([href, label]) => (
                      <li key={href}>
                        <a href={href} className="styx-footer-link">
                          {label}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="styx-footer-col-title">Externe</p>
                  <ul className="styx-footer-links">
                    <li>
                      <Ext href={GITHUB} className="styx-footer-link">
                        GitHub
                      </Ext>
                    </li>
                    <li>
                      <Ext href="https://slashy.space" className="styx-footer-link">
                        slashy.space
                      </Ext>
                    </li>
                    <li>
                      <Ext href={npmUrl('merchant-sdk')} className="styx-footer-link">
                        npm
                      </Ext>
                    </li>
                    <li>
                      <a href={`mailto:${EMAIL}`} className="styx-footer-link">
                        Email
                      </a>
                    </li>
                  </ul>
                </div>
              </div>
              <div className="styx-footer-legal">
                <span>
                  Logiciel de devnet. Non audité. Aucun fonds réel, aucun utilisateur en production.
                </span>
                <span>Chiffres revérifiés le {VERIFIED.date}.</span>
              </div>
            </div>
          </footer>
        </div>
      </div>
    </StyxShell>
  );
}
