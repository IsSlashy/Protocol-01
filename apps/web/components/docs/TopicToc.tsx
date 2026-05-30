"use client";

export type TocItem = { href: string; label: string };

interface Props {
  items: TocItem[];
  title: string;
}

export default function TopicToc({ items, title }: Props) {
  if (items.length < 2) return null;
  return (
    <aside className="hidden xl:block w-52 shrink-0">
      <div className="sticky top-20 pl-4 border-l border-[#2a2a30]">
        <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#555560] mb-3">
          {title}
        </p>
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li key={item.href}>
              <a
                href={item.href}
                className="text-xs text-[#888892] hover:text-[#39c5bb] transition-colors block leading-snug"
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
