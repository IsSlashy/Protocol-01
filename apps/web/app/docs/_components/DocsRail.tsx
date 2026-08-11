"use client";

import { memo } from "react";
import { Search, X } from "lucide-react";

/**
 * DocsRail — the grouped topic rail, in the Styx voice.
 *
 * A behaviour-identical restyle of components/Sidebar (components/docs/Sidebar.tsx).
 * That file is shared with pages still carrying the Protocol 01 identity, so it is
 * left untouched and this local copy is what /docs mounts. Same props, same types,
 * same `memo`, same mobile-drawer contract (a selection inside the drawer also
 * closes it).
 *
 * styx.css has no docs-shell vocabulary yet, so the geometry is Tailwind layout
 * utilities only and every colour comes from a styx class or a styx token. Nothing
 * here invents a palette.
 */
export type NavItem = { id: string; title: string };
export type ResolvedGroup = { label: string; items: NavItem[] };

interface Props {
  groups: ResolvedGroup[];
  activeId: string;
  onSelect: (id: string) => void;
  open: boolean;
  onClose: () => void;
  onOpenSearch: () => void;
  searchLabel: string;
  searchHint: string;
}

function NavList({
  groups,
  activeId,
  onSelect,
  onOpenSearch,
  searchLabel,
  searchHint,
}: Pick<
  Props,
  "groups" | "activeId" | "onSelect" | "onOpenSearch" | "searchLabel" | "searchHint"
>) {
  return (
    <div className="flex flex-col gap-8">
      {/* Search trigger. The keyboard route (Ctrl/Cmd+K) lives on the page. */}
      <button
        type="button"
        onClick={onOpenSearch}
        className="styx-panel styx-sweep flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Search
          size={13}
          aria-hidden="true"
          style={{ flex: "none", color: "var(--styx-faint)" }}
        />
        <span className="styx-mono min-w-0 flex-1 truncate">{searchLabel}</span>
        <kbd
          className="styx-overline"
          style={{
            flex: "none",
            border: "1px solid var(--styx-rule)",
            padding: "0.15rem 0.4rem",
          }}
        >
          {searchHint}
        </kbd>
      </button>

      <nav className="flex flex-col gap-7">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="styx-overline" style={{ paddingLeft: "0.9rem" }}>
              {group.label}
            </p>
            <ul className="m-0 mt-3 flex list-none flex-col p-0">
              {group.items.map((item) => {
                const active = item.id === activeId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(item.id)}
                      aria-current={active ? "true" : undefined}
                      className="styx-footer-link block w-full py-[0.3rem] pl-[0.85rem] text-left leading-snug"
                      style={{
                        borderLeft: `1px solid ${
                          active ? "var(--styx-accent)" : "var(--styx-rule-soft)"
                        }`,
                        color: active ? "var(--styx-paper)" : undefined,
                      }}
                    >
                      {item.title}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </div>
  );
}

function DocsRail(props: Props) {
  const { open, onClose } = props;
  return (
    <>
      {/* Desktop rail: a hairline separates it from the topic, never a shadow. */}
      <aside
        className="hidden w-60 shrink-0 lg:block"
        style={{ borderRight: "1px solid var(--styx-rule)" }}
      >
        <div className="sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto pb-10 pr-5">
          <NavList {...props} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-[60] lg:hidden">
          <div
            className="absolute inset-0"
            style={{
              background: "rgba(7, 7, 9, 0.82)",
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
            onClick={onClose}
          />
          <div
            className="absolute bottom-0 left-0 top-0 w-72 max-w-[80vw] overflow-y-auto p-6"
            style={{
              background: "var(--styx-ink)",
              borderRight: "1px solid var(--styx-rule)",
            }}
          >
            <div className="mb-5 flex justify-end">
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="styx-btn-ghost"
                style={{ padding: "0.45rem" }}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <NavList
              {...props}
              onSelect={(id) => {
                props.onSelect(id);
                onClose();
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

export default memo(DocsRail);
