/**
 * Blocs de présentation pour /parcours. Composants serveur : la page
 * n'embarque aucun JavaScript client.
 *
 * Tout ce qui est visible ici sort du vocabulaire partagé de app/_styx/styx.css.
 * Aucune couleur, aucune police et aucune taille de texte n'est écrite dans ce
 * fichier : les styles en ligne qui restent ne portent que de la géométrie
 * (gouttières, colonnes, largeurs minimales de tableau) ou un jeton
 * var(--styx-*) déjà défini par le système.
 *
 * ⚠ Comme dans page.tsx, les {' '} après une balise fermante sont load-bearing :
 * SWC supprime l'espace de tête d'un noeud de texte multiligne.
 */
import type { ReactNode } from 'react';

/* ---------------------------------------------------------------------------
   La voix serif, remise à la main sur les vraies balises de titre.

   styx.css sort toutes les balises h1..h6 de la police du thème racine avec
   `.styx :is(h1, h2, h3, h4, h5, h6) { font-family: inherit; font-weight:
   inherit; letter-spacing: normal }`. Ce sélecteur pèse (0,1,1) et `.styx-h2`
   pèse (0,1,0) : mesuré au navigateur le 11 août 2026, un `<h2 class="styx-h2">`
   rend donc en Inter 400, pas en Newsreader. Un `<p class="styx-h2">` rend bien
   en serif, ce qui explique que le style guide ne l'ait pas montré.

   Une page ne peut pas corriger styx.css, et remplacer les titres par des
   paragraphes détruirait le plan du document. Les styles en ligne ci-dessous
   remettent donc les jetons du système, jamais une valeur nouvelle. À supprimer
   le jour où le sélecteur partagé sera corrigé (voir needsSharedClass).
--------------------------------------------------------------------------- */
const SERIF = 'var(--styx-serif)';

export const serifH1 = {
  fontFamily: SERIF,
  fontWeight: 'var(--styx-serif-display)',
  letterSpacing: '-0.022em',
} as const;

export const serifH2 = {
  fontFamily: SERIF,
  fontWeight: 'var(--styx-serif-title)',
  letterSpacing: '-0.01em',
} as const;

export const serifH3 = {
  fontFamily: SERIF,
  fontWeight: 'var(--styx-serif-small)',
  letterSpacing: '-0.005em',
} as const;

/** Pour un styx-card-value porté par une balise de titre. */
export const serifCard = {
  fontFamily: SERIF,
  fontWeight: 'var(--styx-serif-small)',
} as const;

export function Ext({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

/* --- chapitre ---------------------------------------------------------------
 * Une section Styx : le numéral surdimensionné et le titre restent dans la
 * colonne de gauche, collés au défilement, et tout le contenu de la section
 * arrive dans la colonne de droite.
 * -------------------------------------------------------------------------- */

export function Section({
  id,
  idx,
  index,
  title,
  dek,
  alt = false,
  children,
}: {
  id?: string;
  /** Le numéro de chapitre, purement décoratif : il est masqué aux lecteurs d'écran. */
  idx: string;
  /** Le même libellé que dans l'index de navigation, pour se repérer. */
  index: string;
  title: string;
  dek?: ReactNode;
  alt?: boolean;
  children: ReactNode;
}) {
  return (
    <section id={id} className={alt ? 'styx-section styx-section-alt' : 'styx-section'}>
      <div className="styx-container styx-section-grid">
        <div className="styx-section-label">
          <span className="styx-numeral" aria-hidden="true">
            {idx}
          </span>
          <p className="styx-index">{index}</p>
          <h2 className="styx-h2" style={serifH2}>
            {title}
          </h2>
        </div>
        {/* minmax(0, 1fr) : styx-stack-lg est une grille dont la colonne
            implicite est en `auto`, donc elle se dimensionne sur le
            min-content de ses enfants. Mesuré au navigateur : un
            styx-table-wrap contenant un tableau à min-width poussait la
            colonne à 930 px dans une piste de 752 px, et la dernière colonne
            du tableau sortait de l'écran au lieu de défiler dans son cadre. */}
        <div className="styx-stack-lg" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
          {dek ? <p className="styx-lede">{dek}</p> : null}
          {children}
        </div>
      </div>
    </section>
  );
}

export function SubHead({ children }: { children: ReactNode }) {
  return (
    <h3
      className="styx-h3"
      style={{
        ...serifH3,
        margin: '0 0 1.1rem',
        paddingTop: '1.15rem',
        borderTop: '1px solid var(--styx-rule)',
      }}
    >
      {children}
    </h3>
  );
}

/* --- ligne de dépôts sous un titre de section ------------------------------- */

export interface RepoRef {
  label: string;
  href: string;
  /** Vérifié via l'API GitHub le 8 aout 2026. Un dépôt privé est annoncé
   *  comme tel plutot que lié comme s'il était ouvrable. */
  visibility: 'public' | 'privé';
  note?: string;
}

export function RepoLine({ repos }: { repos: readonly RepoRef[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.7rem 1.75rem',
      }}
    >
      {repos.map((r) => (
        <span
          key={r.href}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.6rem',
            minWidth: 0,
          }}
        >
          <span className="styx-mono" style={{ minWidth: 0, wordBreak: 'break-all' }}>
            <Ext href={r.href} className="styx-link">
              {r.label}
            </Ext>
          </span>
          <span className="styx-chip">
            {r.visibility === 'public' ? <span className="styx-dot" aria-hidden="true" /> : null}
            {r.visibility}
          </span>
          {r.note ? <span className="styx-note">{r.note}</span> : null}
        </span>
      ))}
    </div>
  );
}

/* --- bandeau de chiffres --------------------------------------------------- */

export interface Stat {
  value: string;
  label: string;
}

export function StatBand({ stats }: { stats: readonly Stat[] }) {
  return (
    <div className="styx-grid styx-grid-3">
      {stats.map((s) => (
        <div key={s.label} className="styx-card styx-sweep">
          <p className="styx-card-label">{s.label}</p>
          <p
            className="styx-card-value"
            style={{ margin: 0, fontSize: 'clamp(1.75rem, 3.2vw, 2.4rem)', fontWeight: 300 }}
          >
            {s.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/* --- registre a deux colonnes ---------------------------------------------- */

export interface RegisterRow {
  label: string;
  body: ReactNode;
}

export function Register({
  rows,
  prefix = 'Limite',
}: {
  rows: readonly RegisterRow[];
  prefix?: string;
}) {
  return (
    <div className="styx-grid styx-grid-2">
      {rows.map((r, i) => (
        <div key={r.label} className="styx-card">
          <p className="styx-card-label">
            {prefix} {String(i + 1).padStart(2, '0')}
          </p>
          <h3 className="styx-card-value" style={serifCard}>
            {r.label}
          </h3>
          <p className="styx-card-note">{r.body}</p>
        </div>
      ))}
    </div>
  );
}

/* --- grille de projets ------------------------------------------------------ */

export interface ProjectLink {
  label: string;
  href: string;
}

export interface Project {
  name: string;
  status: string;
  statusKind?: 'ok' | 'warn' | 'neutral';
  body: string;
  stack: string;
  links?: readonly ProjectLink[];
}

export function ProjectGrid({ projects }: { projects: readonly Project[] }) {
  return (
    <div className="styx-grid styx-grid-3">
      {projects.map((p) => (
        <article
          key={p.name}
          className="styx-card styx-sweep"
          style={{ display: 'flex', flexDirection: 'column' }}
        >
          <span className="styx-chip" style={{ alignSelf: 'flex-start', marginBottom: '1rem' }}>
            {/* Le point cyan est un sceau d'état, pas une décoration : il ne
                marque que ce qui est public et ouvrable. */}
            {p.statusKind === 'ok' ? <span className="styx-dot" aria-hidden="true" /> : null}
            {p.status}
          </span>
          <h3 className="styx-card-value" style={{ ...serifCard, fontSize: '1.25rem' }}>
            {p.name}
          </h3>
          <p className="styx-card-note" style={{ flex: 1 }}>
            {p.body}
          </p>
          <p className="styx-mono" style={{ margin: '1rem 0 0' }}>
            {p.stack}
          </p>
          {p.links?.length ? (
            <p className="styx-mono" style={{ margin: '0.6rem 0 0' }}>
              {p.links.map((l) => (
                <span key={l.href} style={{ marginRight: '0.8rem' }}>
                  <Ext href={l.href} className="styx-link">
                    [{l.label}]
                  </Ext>
                </span>
              ))}
            </p>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/* --- etapes ----------------------------------------------------------------- */

export interface Step {
  no: string;
  name: string;
  body: string;
  metaLabel?: string;
  metaHref?: string;
}

export function Steps({ steps }: { steps: readonly Step[] }) {
  return (
    <ul className="styx-steps">
      {steps.map((s) => (
        <li key={s.no} className="styx-step">
          <span className="styx-step-index">{s.no}</span>
          <div>
            <h3 className="styx-h3" style={serifH3}>
              {s.name}
            </h3>
            <p className="styx-step-body">{s.body}</p>
            {s.metaHref && s.metaLabel ? (
              <p className="styx-note" style={{ marginTop: '0.75rem' }}>
                <Ext href={s.metaHref} className="styx-link">
                  {s.metaLabel}
                </Ext>
              </p>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* --- liste numérotée de points ----------------------------------------------
 * Remplace les anciennes puces au tiret cyan. Le numéro est masqué aux lecteurs
 * d'écran : il ordonne l'oeil, il ne porte pas de sens.
 * -------------------------------------------------------------------------- */

export function Points({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="styx-steps">
      {items.map((item, i) => (
        <li key={`point-${i}`} className="styx-step">
          <span className="styx-step-index" aria-hidden="true">
            {String(i + 1).padStart(2, '0')}
          </span>
          <div className="styx-step-body styx-prose">{item}</div>
        </li>
      ))}
    </ul>
  );
}

/* --- réserve ----------------------------------------------------------------
 * Ce qui n'est pas fini, ou pas défendable. L'ambre du système est dépensée une
 * seule fois, sur l'admission du hero ; ici la réserve tient par le cadre et le
 * filet, pas par la couleur, sinon plus rien ne serait signalé.
 * -------------------------------------------------------------------------- */

export function Reserve({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="styx-panel" role="note">
      <div className="styx-panel-head">
        <p className="styx-overline">{title}</p>
      </div>
      <div className="styx-panel-body">
        <div className="styx-prose">{children}</div>
      </div>
    </div>
  );
}

/* --- compétences ------------------------------------------------------------ */

export interface SkillGroup {
  title: string;
  items: string;
  note?: string;
}

export function SkillGrid({ groups }: { groups: readonly SkillGroup[] }) {
  return (
    <div className="styx-grid styx-grid-3">
      {groups.map((g) => (
        <div key={g.title} className="styx-card">
          <h3 className="styx-h3" style={serifH3}>
            {g.title}
          </h3>
          <p className="styx-card-note">{g.items}</p>
          {g.note ? (
            <p className="styx-note" style={{ marginTop: '0.9rem' }}>
              {g.note}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/* --- chronologie ------------------------------------------------------------
 * Un tableau plutôt qu'une liste d'étapes : la colonne de dates de styx-step
 * fait 3,5rem, ce qui coupe « 2023 à 2024 ».
 * -------------------------------------------------------------------------- */

export interface TimelineRow {
  when: string;
  role: string;
  org: string;
  body: string;
}

export function Timeline({ rows }: { rows: readonly TimelineRow[] }) {
  return (
    <div className="styx-table-wrap">
      <table className="styx-table" style={{ minWidth: '44rem' }}>
        <caption className="styx-sr-only">
          Parcours professionnel et diplômes, du plus récent au plus ancien
        </caption>
        <thead>
          <tr>
            <th scope="col">Période</th>
            <th scope="col">Poste et organisation</th>
            <th scope="col">Détail</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.when}-${r.role}`}>
              <td style={{ whiteSpace: 'nowrap' }}>
                <span className="styx-mono styx-code-name">{r.when}</span>
              </td>
              <td style={{ minWidth: '16ch' }}>
                <p className="styx-h3" style={{ fontSize: '1.1rem', margin: '0 0 0.3rem' }}>
                  {r.role}
                </p>
                <p className="styx-mono" style={{ margin: 0 }}>
                  {r.org}
                </p>
              </td>
              <td>{r.body}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --- tableau générique ------------------------------------------------------ */

export type Cell = ReactNode;

export function DataTable({
  caption,
  head,
  rows,
  /** Largeur minimale avant que le cadre ne défile horizontalement. La colonne
   *  de contenu d'une section Styx mesure environ 47rem sur un portable, donc
   *  au-delà de cette valeur le tableau défile dans son propre cadre. */
  minWidth = '42rem',
  note,
}: {
  caption: string;
  head: readonly string[];
  rows: readonly (readonly Cell[])[];
  minWidth?: string;
  note?: ReactNode;
}) {
  return (
    <div>
      <div className="styx-table-wrap">
        <table className="styx-table" style={{ minWidth }}>
          <caption className="styx-sr-only">{caption}</caption>
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} scope="col">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`row-${i}`}>
                {r.map((c, j) => (
                  <td key={`cell-${i}-${j}`}>
                    {j === 0 ? <span className="styx-mono styx-code-name">{c}</span> : c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {note ? (
        <p className="styx-note" style={{ marginTop: '1rem' }}>
          {note}
        </p>
      ) : null}
    </div>
  );
}
