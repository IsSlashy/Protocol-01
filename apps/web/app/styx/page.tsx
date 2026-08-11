import Link from "next/link";

/**
 * Hub de comparaison des directions artistiques Styx Protocol.
 * Route de travail : non listée dans la navigation, supprimée une fois la direction choisie.
 */

const DIRECTIONS = [
  {
    slug: "styx-a",
    label: "A",
    name: "La chambre forte",
    thesis:
      "Institutionnel, quasi monochrome, éditorial. La confiance naît de la retenue et de la preuve. Grille stricte, filets fins, hiérarchie typographique forte. Le mouvement est lent et jamais décoratif.",
    risk: "Peut basculer dans l'ennuyeux si la densité est trop faible.",
  },
  {
    slug: "styx-b",
    label: "B",
    name: "Le fleuve",
    thesis:
      "Cinématographique et calme. Une seule idée visuelle forte qui traverse la page : un courant qui s'écoule. La confiance naît de la maîtrise, l'impression que quelque chose de puissant tourne sans effort.",
    risk: "Le coût d'animation et le rendu mobile sont les points à vérifier.",
  },
  {
    slug: "styx-c",
    label: "C",
    name: "Le terminal noir",
    thesis:
      "La confiance par la vérifiabilité. Dense en information, monospace pour tout nombre et tout hash, chaque affirmation accompagnée de son moyen de vérification : program ID, code source, et ce qui n'est pas encore fait.",
    risk: "Austère par construction. Le pari est que la densité remplace le décor.",
  },
] as const;

export default function StyxCompare() {
  return (
    <main className="min-h-screen bg-[#08080a] text-white px-6 py-16 sm:px-10">
      <div className="mx-auto max-w-3xl">
        <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-[#39c5bb]">
          Direction artistique
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
          Styx Protocol
        </h1>
        <p className="mt-4 max-w-xl text-sm leading-relaxed text-white/55">
          Trois directions construites en parallèle sur la même copie et le même
          produit. Même fond noir, même cyan hérité, même exigence d&apos;honnêteté sur
          l&apos;état réel du projet. Seule la présentation change.
        </p>

        <ul className="mt-14 space-y-px">
          {DIRECTIONS.map((d) => (
            <li key={d.slug}>
              <Link
                href={`/${d.slug}`}
                className="group flex flex-col gap-4 border-t border-white/10 py-8 transition-colors hover:border-[#39c5bb]/40 sm:flex-row sm:gap-10"
              >
                <span className="font-mono text-xs text-white/30 transition-colors group-hover:text-[#39c5bb] sm:w-10 sm:shrink-0">
                  {d.label}
                </span>
                <div className="min-w-0">
                  <h2 className="text-xl font-medium tracking-tight">{d.name}</h2>
                  <p className="mt-3 text-sm leading-relaxed text-white/55">
                    {d.thesis}
                  </p>
                  <p className="mt-3 text-xs leading-relaxed text-white/30">
                    {d.risk}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-16 border-t border-white/10 pt-8">
          <Link
            href="/"
            className="font-mono text-xs text-white/40 underline-offset-4 hover:text-white/70 hover:underline"
          >
            Revoir la version actuelle
          </Link>
        </div>
      </div>
    </main>
  );
}
