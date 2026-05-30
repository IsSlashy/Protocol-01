"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, CornerDownLeft } from "lucide-react";

export type SearchItem = { id: string; title: string; group: string };

interface Props {
  open: boolean;
  onClose: () => void;
  items: SearchItem[];
  onSelect: (id: string) => void;
  placeholder: string;
  emptyLabel: string;
}

export default function DocsSearch({
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
      (it) => it.title.toLowerCase().includes(q) || it.group.toLowerCase().includes(q),
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

  const onKeyDown = (e: React.KeyboardEvent) => {
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
    <AnimatePresence>
      <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[12vh] px-4">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          onClick={onClose}
        />
        <motion.div
          initial={{ opacity: 0, y: -12, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -12, scale: 0.98 }}
          transition={{ duration: 0.15 }}
          className="relative w-full max-w-lg bg-[#0d0d10] border border-[#2a2a30] rounded-2xl shadow-2xl overflow-hidden"
          onKeyDown={onKeyDown}
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2a2a30]">
            <Search className="w-4 h-4 text-[#555560] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="flex-1 bg-transparent text-sm text-white placeholder-[#555560] outline-none"
            />
          </div>

          <div className="max-h-[55vh] overflow-y-auto py-2">
            {results.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-[#555560]">{emptyLabel}</p>
            ) : (
              results.map((it, i) => {
                const isActive = i === active;
                return (
                  <button
                    key={it.id}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(it.id)}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors ${
                      isActive ? "bg-[#39c5bb]/10" : ""
                    }`}
                  >
                    <span className="min-w-0">
                      <span
                        className={`block text-sm truncate ${isActive ? "text-[#39c5bb]" : "text-white"}`}
                      >
                        {it.title}
                      </span>
                      <span className="block text-[10px] font-mono uppercase tracking-wider text-[#555560]">
                        {it.group}
                      </span>
                    </span>
                    {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-[#39c5bb] shrink-0" />}
                  </button>
                );
              })
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}
