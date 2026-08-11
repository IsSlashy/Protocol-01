"use client";

/**
 * DocsToc — the "on this page" rail, in the Styx voice.
 *
 * A restyle of components/docs/TopicToc.tsx, which is shared with pages still on
 * the Protocol 01 identity and therefore left untouched. The length rule is the
 * load-bearing part and is preserved exactly: fewer than two anchors and the rail
 * does not render at all, which is what keeps the architecture topic (zero
 * anchors) from growing an empty column.
 */
export type TocItem = { href: string; label: string };

interface Props {
  items: TocItem[];
  title: string;
}

export default function DocsToc({ items, title }: Props) {
  if (items.length < 2) return null;
  return (
    <aside className="hidden w-48 shrink-0 xl:block">
      <div
        className="sticky top-24 pl-6"
        style={{ borderLeft: "1px solid var(--styx-rule)" }}
      >
        <p className="styx-overline">{title}</p>
        <ul className="m-0 mt-4 flex list-none flex-col gap-2.5 p-0">
          {items.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="styx-footer-link block leading-snug"
                style={{ fontSize: "0.8125rem" }}
              >
                {item.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
