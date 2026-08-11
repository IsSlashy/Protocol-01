"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Search, CornerDownLeft } from "lucide-react";

/**
 * DocsPalette — the Ctrl/Cmd+K topic picker, in the Styx voice.
 *
 * A restyle of components/docs/DocsSearch.tsx, which stays untouched for the pages
 * still on the Protocol 01 identity. The keyboard model is reproduced verbatim
 * because it IS the component:
 *
 *  - filter on title OR group, case-insensitive, empty query shows everything
 *  - reset query + highlight and focus the input on open, focus deferred by one
 *    animation frame so the input exists when focus() lands
 *  - clamp the highlighted row as the result set shrinks
 *  - ArrowDown / ArrowUp / Enter / Escape, each preventDefault'd
 *  - a mouse entering a row moves the highlight to it
 *
 * framer-motion is dropped rather than restyled. The old panel faded and scaled in;
 * this design does not animate a modal into place, and the AnimatePresence wrapper
 * could never run an exit animation anyway because the component returns null the
 * moment `open` goes false.
 */
export type SearchItem = { id: string; title: string; group: string };

interface Props {
  open: boolean;
  onClose: () => void;
  items: SearchItem[];
  onSelect: (id: string) => void;
  placeholder: string;
  emptyLabel: string;
}

export default function DocsPalette({
  open,
  onClose,
  items,
  onSelect,
  placeholder,
  emptyLabel,
}: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.title.toLowerCase().includes(q) || it.group.toLowerCase().includes(q),
    );
  }, [query, items]);

  // Reset + focus when opened.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // Defer focus until the modal is mounted.
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the highlighted row in range as results shrink.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  const choose = (id: string) => {
    onSelect(id);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = results[active];
      if (hit) choose(hit.id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]">
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
        className="styx-panel relative w-full max-w-lg overflow-hidden"
        onKeyDown={onKeyDown}
      >
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: "1px solid var(--styx-rule-soft)" }}
        >
          <Search
            size={14}
            aria-hidden="true"
            style={{ flex: "none", color: "var(--styx-faint)" }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={placeholder}
            className="styx-input"
            style={{ border: "none", background: "transparent", padding: 0 }}
          />
        </div>

        <div className="max-h-[55vh] overflow-y-auto py-1">
          {results.length === 0 ? (
            <p className="styx-note styx-center" style={{ padding: "1.5rem 1rem" }}>
              {emptyLabel}
            </p>
          ) : (
            results.map((it, i) => {
              const isActive = i === active;
              return (
                <button
                  key={it.id}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(it.id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
                  style={{
                    background: isActive
                      ? "rgba(234, 231, 223, 0.05)"
                      : "transparent",
                    borderLeft: `1px solid ${
                      isActive ? "var(--styx-accent)" : "transparent"
                    }`,
                  }}
                >
                  <span className="min-w-0">
                    <span
                      className="block truncate"
                      style={{
                        fontSize: "0.9375rem",
                        color: isActive
                          ? "var(--styx-paper)"
                          : "var(--styx-muted)",
                      }}
                    >
                      {it.title}
                    </span>
                    <span
                      className="styx-overline block"
                      style={{ marginTop: "0.2rem" }}
                    >
                      {it.group}
                    </span>
                  </span>
                  {isActive && (
                    <CornerDownLeft
                      size={13}
                      aria-hidden="true"
                      style={{ flex: "none", color: "var(--styx-accent)" }}
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
