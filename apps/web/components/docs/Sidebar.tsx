"use client";

import { memo } from "react";
import { Search, X } from "lucide-react";

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
}: Pick<Props, "groups" | "activeId" | "onSelect" | "onOpenSearch" | "searchLabel" | "searchHint">) {
  return (
    <div className="flex flex-col gap-6">
      {/* Search trigger */}
      <button
        onClick={onOpenSearch}
        className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-[#2a2a30] bg-white/[0.02] text-left text-[#555560] hover:border-[#39c5bb]/40 hover:text-[#888892] transition-colors"
      >
        <Search className="w-3.5 h-3.5 shrink-0" />
        <span className="text-sm flex-1 truncate">{searchLabel}</span>
        <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded border border-[#2a2a30] text-[#555560]">
          {searchHint}
        </kbd>
      </button>

      {/* Grouped nav */}
      <nav className="flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#555560] mb-2 px-3">
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = item.id === activeId;
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => onSelect(item.id)}
                      className={`w-full text-left text-sm px-3 py-1.5 rounded-lg border-l-2 transition-colors ${
                        active
                          ? "border-[#39c5bb] bg-[#39c5bb]/10 text-[#39c5bb] font-medium"
                          : "border-transparent text-[#888892] hover:text-white hover:bg-white/[0.03]"
                      }`}
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

function Sidebar(props: Props) {
  const { open, onClose } = props;
  return (
    <>
      {/* Desktop rail */}
      <aside className="hidden lg:block w-64 shrink-0">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pr-2 pb-10">
          <NavList {...props} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="lg:hidden fixed inset-0 z-[60]">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <div className="absolute left-0 top-0 bottom-0 w-72 max-w-[80vw] bg-[#0a0a0c] border-r border-[#2a2a30] p-5 overflow-y-auto">
            <div className="flex justify-end mb-2">
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg text-[#888892] hover:text-white hover:bg-white/[0.05]"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
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

export default memo(Sidebar);
